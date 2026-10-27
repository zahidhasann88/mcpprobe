import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { parse as yaml } from "yaml";
import { z } from "zod";
import { Session } from "./session.js";
import { leakFinding } from "./checks.js";
import { requireConsent, safetyDecision } from "./safety.js";
import { createReport, finishReport, diagnosticFindings, quote, targetArgs } from "./runner.js";
import { UsageError, type Finding, type Options, type Report } from "./types.js";
const strings = z.union([z.string(), z.array(z.string())]);
const expectSchema = z
  .object({
    isError: z.boolean().optional(),
    error: z.boolean().optional(),
    errorCode: z.number().int().optional(),
    contains: strings.optional(),
    notContains: strings.optional(),
    matches: z.string().optional(),
    structured: z.unknown().optional(),
    maxMs: z.number().int().positive().optional(),
  })
  .strict();
const stepSchema = z
  .object({
    name: z.string().min(1).optional(),
    call: z.string().min(1).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    read: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    expect: expectSchema.optional(),
  })
  .strict()
  .refine((s) => [s.call, s.read, s.prompt].filter(Boolean).length === 1, {
    message: "Each scenario needs exactly one of call, read or prompt",
  })
  .refine((s) => !s.args || s.call || s.prompt, {
    message: "args only applies to call and prompt",
  });
export const scenarioFileSchema = z.object({ scenarios: z.array(stepSchema).min(1) }).strict();
export type Scenario = z.infer<typeof stepSchema>;
export async function loadScenarios(file: string): Promise<Scenario[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new UsageError(`Cannot read scenario file: ${file}`);
  }
  const parsed = scenarioFileSchema.safeParse(yaml(text));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new UsageError(
      `Invalid scenario file at ${issue.path.join(".") || "root"}: ${issue.message}`,
    );
  }
  return parsed.data.scenarios;
}

function visibleText(result: any): string {
  const items = [
    ...(result?.content ?? []),
    ...(result?.contents ?? []),
    ...(result?.messages ?? []).map((m: any) => m.content),
  ];
  return items
    .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}
/** Every key in `expected` must match `actual`; extra keys in `actual` are ignored. */
function partialMatch(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected))
    return (
      !!actual &&
      typeof actual === "object" &&
      Object.entries(expected).every(([k, v]) => partialMatch((actual as any)[k], v))
    );
  return isDeepStrictEqual(actual, expected);
}
function assertions(scenario: Scenario, result: any, error: any, ms: number): string[] {
  const e = scenario.expect ?? {};
  const failures: string[] = [];
  const wantsError = e.error === true || e.errorCode !== undefined;
  if (error) {
    if (!wantsError) return [`Request failed: ${error.message ?? String(error)}`];
    if (e.errorCode !== undefined && error.code !== e.errorCode)
      failures.push(`Expected error code ${e.errorCode}, got ${error.code}`);
  } else {
    if (wantsError) failures.push("Expected a JSON-RPC error, but the request succeeded");
    const isError = result?.isError === true;
    if (scenario.call && isError !== (e.isError ?? false))
      failures.push(e.isError ? "Expected isError: true" : `Tool returned isError: ${visibleText(result)}`);
    const text = visibleText(result);
    for (const s of [e.contains ?? []].flat())
      if (!text.includes(s)) failures.push(`Output does not contain ${JSON.stringify(s)}`);
    for (const s of [e.notContains ?? []].flat())
      if (text.includes(s)) failures.push(`Output contains ${JSON.stringify(s)}`);
    if (e.matches !== undefined && !new RegExp(e.matches).test(text))
      failures.push(`Output does not match /${e.matches}/`);
    if (e.structured !== undefined && !partialMatch(result?.structuredContent, e.structured))
      failures.push("structuredContent does not match the expected value");
  }
  if (e.maxMs !== undefined && ms > e.maxMs) failures.push(`Took ${ms} ms, limit is ${e.maxMs} ms`);
  return failures;
}
export async function runScenarios(
  options: Options,
  scenarios: Scenario[],
  strict = false,
  file?: string,
): Promise<Report> {
  requireConsent(options);
  for (const s of scenarios)
    if (s.expect?.matches !== undefined)
      try {
        new RegExp(s.expect.matches);
      } catch {
        throw new UsageError(`Invalid regular expression: ${s.expect.matches}`);
      }
  const report = createReport("run", options);
  const session = new Session(options);
  try {
    await session.connect();
  } catch (e) {
    report.exitCode = 3;
    report.findings.push({
      id: "INITIALIZE",
      status: "fail",
      explanation: e instanceof Error ? e.message : String(e),
      fix: "Check the command/URL, credentials, and initialize handler",
    });
    report.findings.push(...diagnosticFindings(session));
    await session.close();
    return finishReport(report, options, strict);
  }
  try {
    const inventory = (report.inventory = await session.inventory());
    report.findings.push(...session.findings.filter((f) => f.status !== "pass"));
    for (const [i, scenario] of scenarios.entries()) {
      const label = scenario.name ?? scenario.call ?? scenario.read ?? scenario.prompt!;
      const finding: Finding = {
        id: "SCENARIO",
        status: "pass",
        tool: scenario.call,
        input: scenario.call ? (scenario.args ?? {}) : undefined,
        explanation: label,
        fix: "None",
        ...(!scenario.call && file
          ? { reproduction: `mcpprobe run ${quote(file)} ${targetArgs(options)}` }
          : {}),
      };
      if (!session.remaining() || session.diagnostics.unexpectedExit) {
        report.findings.push({ ...finding, status: "skipped", explanation: `${label}: not run (server exited or time budget exhausted)` });
        continue;
      }
      if (scenario.call) {
        const tool = inventory.tools.find((t) => t.name === scenario.call);
        if (!tool) {
          report.findings.push({ ...finding, status: "fail", explanation: `${label}: tool not found`, fix: "Use a tool name the server lists" });
          continue;
        }
        const decision = safetyDecision(tool, options);
        if (!decision.allowed) {
          report.findings.push({ ...finding, status: "skipped", explanation: `${label}: ${decision.reason}`, fix: "Allow this tool with --allow-tool after reviewing its side effects" });
          continue;
        }
      }
      let result: any;
      let error: any;
      const start = Date.now();
      try {
        result = scenario.call
          ? await session.call(scenario.call, scenario.args ?? {})
          : scenario.read
            ? await session.request("resources/read", { uri: scenario.read })
            : await session.request("prompts/get", { name: scenario.prompt, arguments: scenario.args ?? {} });
      } catch (e) {
        error = e;
      }
      const ms = Date.now() - start;
      const failures = assertions(scenario, result, error, ms);
      report.findings.push(
        failures.length
          ? {
              ...finding,
              status: "fail",
              actual: error ? { error: error.message, code: error.code } : result,
              expected: JSON.stringify(scenario.expect ?? { isError: false }),
              explanation: `${label} (scenario ${i + 1}): ${failures.join("; ")}`,
              fix: "Fix the server, or update the scenario if the new behavior is intended",
            }
          : { ...finding, explanation: `${label} (${ms} ms)` },
      );
      const leak = leakFinding(error ? error.message : result, options.secrets, scenario.call, finding.input);
      if (leak) report.findings.push(leak);
    }
  } finally {
    report.findings.push(...diagnosticFindings(session));
    await session.close();
  }
  return finishReport(report, options, strict);
}

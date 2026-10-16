import fc from "fast-check";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  generateInputs,
  validSamples,
  validator,
  hostileStrings,
  type Input,
} from "./generators.js";
import { evaluateSample } from "./checks.js";
import { Session } from "./session.js";
import { requireConsent, safetyDecision, safetyWarnings } from "./safety.js";
import { createReport, finishReport, diagnosticFindings } from "./runner.js";
import type { Finding, Options, Report } from "./types.js";
function valueArbitrary(spec: any, depth = 0): fc.Arbitrary<unknown> {
  if (Array.isArray(spec?.enum) && spec.enum.length)
    return fc.constantFrom(...spec.enum);
  if (spec?.const !== undefined) return fc.constant(spec.const);
  if (depth > 4) return fc.jsonValue({ maxDepth: 2 });
  switch (spec?.type) {
    case "string":
      return fc.oneof(
        fc.string({
          maxLength: Math.min(Math.max(spec.maxLength ?? 80, 80), 1000),
        }),
        fc.constantFrom(...hostileStrings),
      );
    case "integer":
      return fc.integer({
        min: Math.max(-2147483648, Math.min(spec.minimum ?? -1000, -1000)),
        max: Math.min(2147483647, Math.max(spec.maximum ?? 1000, 1000)),
      });
    case "number":
      return fc.double({ noNaN: true, noDefaultInfinity: true });
    case "boolean":
      return fc.boolean();
    case "null":
      return fc.constant(null);
    case "array":
      return fc.array(valueArbitrary(spec.items, depth + 1), {
        maxLength: Math.min(Math.max(spec.maxItems ?? 8, 8), 64),
      });
    case "object":
      return objectArbitrary(spec, depth + 1);
    default:
      return fc.jsonValue({ maxDepth: 3 });
  }
}
export function objectArbitrary(schema: any, depth = 0): fc.Arbitrary<Input> {
  const fields: Record<string, fc.Arbitrary<unknown>> = {};
  for (const [name, spec] of Object.entries(schema.properties ?? {}))
    fields[name] = fc.oneof(
      { withCrossShrink: true },
      valueArbitrary(spec, depth),
      fc.jsonValue({ maxDepth: 2 }),
    );
  return fc.record(fields, { requiredKeys: [] });
}
export async function fuzz(options: Options, strict = false): Promise<Report> {
  requireConsent(options);
  const report = createReport("fuzz", options);
  let session = new Session(options);
  const deadline = session.deadline;
  for (const text of safetyWarnings(options))
    report.findings.push({
      id: "SAFETY_OVERRIDE",
      status: "warn",
      explanation: text,
      fix: "Use explicit allowlists instead",
    });
  try {
    await session.connect();
  } catch (e) {
    report.exitCode = 3;
    report.findings.push({
      id: "INITIALIZE",
      status: "fail",
      explanation: String(e),
      fix: "Check server connection",
    });
    report.findings.push(...diagnosticFindings(session));
    await session.close();
    return finishReport(report, options, strict);
  }
  try {
    report.inventory = await session.inventory();
    report.findings.push(...session.findings);
    const tools = report.inventory.tools.filter(
      (t) => !options.tool || options.tool === t.name,
    );
    if (options.tool && !tools.length)
      report.findings.push({
        id: "TOOL_SELECTION",
        status: "fail",
        explanation: `Tool not found: ${options.tool}`,
        fix: "Select a listed tool",
      });
    for (const tool of tools) {
      if (!safetyDecision(tool, options).allowed) {
        report.findings.push({
          id: "SAFETY_SKIP",
          status: "skipped",
          tool: tool.name,
          explanation: safetyDecision(tool, options).reason,
          fix: "Review policy before allowing calls",
        });
        continue;
      }
      if (Date.now() >= deadline) break;
      let validate: ReturnType<typeof validator>;
      let examples: Input[];
      try {
        validate = validator(tool.inputSchema);
        examples = generateInputs(tool.inputSchema, options.seed).map(
          (s) => s.input,
        );
      } catch (e) {
        report.findings.push({
          id: "INPUT_SCHEMA",
          status: "fail",
          tool: tool.name,
          explanation: String(e),
          fix: "Correct input schema",
        });
        continue;
      }
      // Include faker-generated valid values as well as mutable records. Records and their values shrink.
      const valid = validSamples(
        tool.inputSchema,
        options.seed,
        Math.min(options.runs, 100),
      );
      const arb = valid.length
        ? fc.oneof(
            { withCrossShrink: true },
            objectArbitrary(tool.inputSchema),
            fc.constantFrom(...valid),
          )
        : objectArbitrary(tool.inputSchema);
      const failures = new Map<string, Finding[]>();
      let calls = 0;
      const check = await fc.check(
        fc.asyncProperty(arb, async (input) => {
          if (Date.now() >= deadline) return true;
          if (session.diagnostics.unexpectedExit) {
            await session.close();
            session = new Session(options);
            session.deadline = deadline;
            try {
              await session.connect();
            } catch {
              return true;
            }
          }
          calls++;
          const findings = await evaluateSample(session, tool as Tool, {
            input,
            valid: Boolean(validate(input)),
            kind: "fuzz",
          });
          const bad = findings.filter((f) => f.status === "fail");
          if (bad.length)
            failures.set(JSON.stringify(input), [
              ...bad,
              ...diagnosticFindings(session),
            ]);
          return bad.length === 0;
        }),
        {
          seed: options.seed,
          numRuns: options.runs,
          examples: examples.slice(0, options.runs).map((v) => [v] as [Input]),
          interruptAfterTimeLimit: Math.max(1, deadline - Date.now()),
          markInterruptAsFailure: false,
          // Safety limits for a server that fails every input; shrinking is bounded by the global deadline.
          endOnFailure: false,
        },
      );
      if (check.failed && check.counterexample) {
        const input = check.counterexample[0];
        report.findings.push(...(failures.get(JSON.stringify(input)) ?? []));
        report.findings.push({
          id: "FUZZ_FAILURE",
          status: "fail",
          tool: tool.name,
          input,
          actual: {
            seed: check.seed,
            counterexamplePath: check.counterexamplePath,
            numShrinks: check.numShrinks,
            calls,
          },
          expected:
            "All generated inputs handled according to their schema validity",
          explanation: `Found a failing input; fast-check performed ${check.numShrinks} shrink steps (locally minimal within time budget)`,
          fix: "Replay the input, correct validation/error handling, and rerun with the same seed",
        });
      } else
        report.findings.push({
          id: "FUZZ_RUNS",
          status: "pass",
          tool: tool.name,
          actual: { calls, seed: options.seed },
          explanation: `No failures in ${calls} fuzz calls`,
          fix: "None",
        });
    }
    if (Date.now() >= deadline)
      report.findings.push({
        id: "GLOBAL_BUDGET",
        status: "warn",
        explanation:
          "Global fuzz budget exhausted; shrinking or remaining runs may be incomplete",
        fix: "Increase --max-duration",
      });
  } finally {
    report.findings.push(...diagnosticFindings(session));
    await session.close();
  }
  return finishReport(report, options, strict);
}

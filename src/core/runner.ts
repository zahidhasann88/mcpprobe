import { Session } from "./session.js";
import { redact } from "./config.js";
import { safetyWarnings, requireConsent } from "./safety.js";
import { rawChecks } from "./raw.js";
import { toolChecks, resourceChecks, protocolChecks } from "./checks.js";
import {
  featureChecks,
  lifecycleChecks,
  notificationChecks,
} from "./features.js";
import { poisoningChecks } from "./security.js";
import { httpChecks } from "./http.js";
import { type Options, type Report, type Finding } from "./types.js";
export function createReport(command: string, options: Options): Report {
  return {
    command,
    target: options.target.stdio ?? options.target.http!,
    seed: options.seed,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    findings: [],
    summary: { pass: 0, warn: 0, fail: 0, skipped: 0 },
    exitCode: 0,
  };
}
export function finishReport(
  report: Report,
  options?: Options,
  strict = false,
): Report {
  report.durationMs = Date.now() - Date.parse(report.startedAt);
  report.summary = { pass: 0, warn: 0, fail: 0, skipped: 0 };
  for (const f of report.findings) report.summary[f.status]++;
  if (report.exitCode !== 3)
    report.exitCode =
      report.summary.fail || (strict && report.summary.warn) ? 1 : 0;
  for (const f of report.findings) {
    if (f.status === "fail") {
      f.expected ??=
        "Valid MCP behavior without crash, hang or information leakage";
      f.actual ??= f.explanation;
      f.input ??= null;
      if (!f.reproduction && options)
        f.reproduction = f.tool
          ? reproduction(options, f.tool, f.input)
          : `mcpprobe ${report.command === "inspect" ? "inspect" : "test"} ${targetArgs(options)} --seed ${options.seed} --timeout ${options.timeout} --max-duration ${options.maxDuration}`;
    }
    if (f.tool && f.input !== undefined && !f.reproduction && options)
      f.reproduction = reproduction(options, f.tool, f.input);
  }
  return redact(report, options?.secrets ?? []);
}
export function quote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function targetArgs(options: Options): string {
  return options.target.stdio
    ? `--stdio ${quote(options.target.stdio)}`
    : `--http ${quote(options.target.http!)}${options.target.sse ? " --sse" : ""}`;
}
export function reproduction(
  options: Options,
  tool: string,
  input: unknown,
): string {
  return `mcpprobe call ${quote(tool)} ${targetArgs(options)} --args ${quote(JSON.stringify(input))} --allow-tool ${quote(tool)}${options.allowDestructive ? " --allow-destructive --yes" : ""}`;
}
export function diagnosticFindings(session: Session): Finding[] {
  const d = session.diagnostics;
  const findings: Finding[] = [];
  if (d.stdoutErrors.length)
    findings.push({
      id: "STDOUT_PURITY",
      status: "fail",
      actual: d.stdoutErrors,
      expected: "Only newline-delimited JSON-RPC on stdout",
      explanation: "Server printed non-protocol data on stdout",
      fix: "Use stderr for logs; reserve stdout exclusively for MCP messages",
    });
  if (d.unexpectedExit)
    findings.push({
      id: "PROCESS_EXIT",
      status: "fail",
      actual: { ...d.exit, stderr: d.stderr.join("").split("\n").slice(-20) },
      expected: "Server process stays alive for the whole session",
      explanation: `Server exited unexpectedly (code ${d.exit?.code}, signal ${d.exit?.signal})`,
      fix: "Catch exceptions and reject invalid input without terminating the process",
    });
  return findings;
}
export async function inspect(options: Options): Promise<Report> {
  const report = createReport("inspect", options);
  const session = new Session(options);
  try {
    await session.connect();
    report.inventory = await session.inventory();
    report.findings.push(...session.findings);
  } catch (e) {
    report.exitCode = 3;
    report.findings.push({
      id: "INITIALIZE",
      status: "fail",
      explanation: e instanceof Error ? e.message : String(e),
      fix: "Check target, authentication and MCP initialization",
    });
  } finally {
    report.findings.push(...diagnosticFindings(session));
    await session.close();
  }
  return finishReport(report, options);
}
export async function testServer(
  options: Options,
  strict = false,
): Promise<Report> {
  requireConsent(options);
  const report = createReport("test", options);
  const session = new Session(options);
  for (const warning of safetyWarnings(options))
    report.findings.push({
      id: "SAFETY_OVERRIDE",
      status: "warn",
      explanation: warning,
      fix: "Prefer explicit allowlists and read-only tools",
    });
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
  report.findings.push({
    id: "INITIALIZE",
    status: "pass",
    explanation: `Initialize succeeded; negotiated ${session.protocolVersion}`,
    fix: "None",
  });
  report.findings.push({
    id: "PROTOCOL_VERSION",
    status: "pass",
    explanation: "Negotiated a protocol revision supported by the pinned SDK",
    fix: "None",
  });
  try {
    const inventory = (report.inventory = await session.inventory());
    report.findings.push(...session.findings);
    if (options.tool && !inventory.tools.some((t) => t.name === options.tool))
      report.findings.push({
        id: "TOOL_SELECTION",
        status: "fail",
        explanation: `Tool not found: ${options.tool}`,
        fix: "Select a listed tool",
      });
    report.findings.push(
      ...poisoningChecks(
        inventory,
        `mcpprobe inspect ${targetArgs(options)} --json`,
      ),
    );
    report.findings.push(...(await protocolChecks(session)));
    report.findings.push(...(await featureChecks(session, inventory)));
    report.findings.push(...(await toolChecks(session, inventory)));
    if (!session.diagnostics.unexpectedExit)
      report.findings.push(...(await lifecycleChecks(session, inventory)));
    if (!session.diagnostics.unexpectedExit)
      report.findings.push(...(await resourceChecks(session, inventory)));
    report.findings.push(...notificationChecks(session, inventory));
    if (session.remaining())
      report.findings.push(...(await rawChecks(options, session.deadline)));
    if (session.remaining() && options.target.http)
      report.findings.push(...(await httpChecks(options, session.deadline)));
    if (!session.remaining())
      report.findings.push({
        id: "GLOBAL_BUDGET",
        status: "warn",
        explanation:
          "Global time budget exhausted; remaining probes were not run",
        fix: "Increase --max-duration or narrow --tool",
      });
  } finally {
    report.findings.push(...diagnosticFindings(session));
    await session.close();
  }
  return finishReport(report, options, strict);
}

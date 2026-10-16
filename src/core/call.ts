import { Session } from "./session.js";
import { requireConsent, safetyDecision, safetyWarnings } from "./safety.js";
import { createReport, finishReport, diagnosticFindings } from "./runner.js";
import { redact } from "./config.js";
import { UsageError, type Options, type Report } from "./types.js";
export async function callTool(
  options: Options,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result?: unknown; report: Report }> {
  requireConsent(options);
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new UsageError("--args must be a JSON object");
  const report = createReport("call", options);
  for (const warning of safetyWarnings(options))
    report.findings.push({
      id: "SAFETY_OVERRIDE",
      status: "warn",
      explanation: warning,
      fix: "Prefer explicit allowlists",
    });
  const session = new Session(options);
  let result: unknown;
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
    return { report: finishReport(report, options) };
  }
  try {
    report.inventory = await session.inventory();
    report.findings.push(...session.findings);
    const tool = report.inventory.tools.find((t) => t.name === name);
    if (!tool) throw new UsageError(`Tool not found: ${name}`);
    const decision = safetyDecision(tool, options);
    if (!decision.allowed)
      report.findings.push({
        id: "SAFETY_SKIP",
        status: "skipped",
        tool: name,
        explanation: decision.reason,
        fix: "Explicitly allow this tool after reviewing its side effects",
      });
    else {
      try {
        result = await session.call(name, args);
        report.findings.push({
          id: "MANUAL_CALL",
          status: "pass",
          tool: name,
          input: args,
          actual: result,
          explanation: "Tool returned a result",
          fix: "None",
        });
      } catch (e) {
        report.findings.push({
          id: "MANUAL_CALL",
          status: "fail",
          tool: name,
          input: args,
          actual: String(e),
          expected: "MCP tool result",
          explanation: String(e),
          fix: "Check arguments and tool implementation",
        });
      }
    }
  } finally {
    report.findings.push(...diagnosticFindings(session));
    await session.close();
  }
  return {
    result: redact(result, options.secrets),
    report: finishReport(report, options),
  };
}

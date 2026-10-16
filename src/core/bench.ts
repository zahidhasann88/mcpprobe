import { performance } from "node:perf_hooks";
import { Session } from "./session.js";
import { validSamples } from "./generators.js";
import { requireConsent, safetyDecision, safetyWarnings } from "./safety.js";
import { createReport, finishReport, diagnosticFindings } from "./runner.js";
import type { Options, Report } from "./types.js";
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
export async function bench(options: Options, strict = false): Promise<Report> {
  requireConsent(options);
  const report = createReport("bench", options);
  const session = new Session(options);
  report.benchmarks = [];
  for (const text of safetyWarnings(options))
    report.findings.push({
      id: "SAFETY_OVERRIDE",
      status: "warn",
      explanation: text,
      fix: "Use explicit allowlists",
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
      (t) => !options.tool || t.name === options.tool,
    );
    if (options.tool && !tools.length)
      report.findings.push({
        id: "TOOL_SELECTION",
        status: "fail",
        explanation: `Tool not found: ${options.tool}`,
        fix: "Select a listed tool",
      });
    for (const tool of tools) {
      const decision = safetyDecision(tool, options);
      if (!decision.allowed) {
        report.findings.push({
          id: "SAFETY_SKIP",
          status: "skipped",
          tool: tool.name,
          explanation: decision.reason,
          fix: "Review policy before allowing calls",
        });
        continue;
      }
      let input: Record<string, unknown> | undefined;
      try {
        input = validSamples(tool.inputSchema, options.seed, 1)[0];
      } catch {
        /* reported below */
      }
      if (!input) {
        report.findings.push({
          id: "INPUT_GENERATION",
          status: "warn",
          tool: tool.name,
          explanation: "No schema-valid benchmark input could be generated",
          fix: "Correct schema or supported formats",
        });
        continue;
      }
      let next = 0;
      let errors = 0;
      let firstError: unknown;
      const times: number[] = [];
      const start = performance.now();
      const worker = async () => {
        while (
          next < options.iterations &&
          session.remaining() &&
          !session.diagnostics.unexpectedExit
        ) {
          next++;
          const begin = performance.now();
          try {
            const result = await session.call(tool.name, input!);
            if (result.isError) {
              errors++;
              firstError ??= result;
            }
          } catch (e) {
            errors++;
            firstError ??= String(e);
          }
          times.push(performance.now() - begin);
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(options.concurrency, options.iterations) },
          worker,
        ),
      );
      const durationMs = performance.now() - start;
      report.benchmarks.push({
        tool: tool.name,
        calls: times.length,
        errors,
        errorRate: times.length ? errors / times.length : 0,
        p50: percentile(times, 0.5),
        p90: percentile(times, 0.9),
        p99: percentile(times, 0.99),
        throughput: durationMs ? (times.length / durationMs) * 1000 : 0,
        durationMs,
      });
      report.findings.push({
        id: "BENCH_ERRORS",
        status: errors ? "fail" : "pass",
        tool: tool.name,
        input,
        actual: { errors, calls: times.length, firstError },
        expected: "Zero benchmark call errors",
        explanation: `${errors} errors in ${times.length} calls`,
        fix: errors
          ? "Inspect tool errors and reduce concurrency if necessary"
          : "None",
      });
      if (percentile(times, 0.9) > options.latencyBudget)
        report.findings.push({
          id: "TOOL_LATENCY",
          status: "warn",
          tool: tool.name,
          input,
          actual: percentile(times, 0.9),
          explanation: "p90 exceeds configured latency budget",
          fix: "Optimize latency or adjust the budget",
        });
    }
    if (!session.remaining())
      report.findings.push({
        id: "GLOBAL_BUDGET",
        status: "warn",
        explanation: "Benchmark stopped at global time budget",
        fix: "Increase --max-duration or reduce iterations",
      });
  } finally {
    report.findings.push(...diagnosticFindings(session));
    await session.close();
  }
  return finishReport(report, options, strict);
}

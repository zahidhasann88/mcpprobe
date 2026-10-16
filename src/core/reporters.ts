import type { Report, Finding } from "./types.js";
export type ReportFormat = "console" | "json" | "junit" | "markdown" | "sarif";
const display = (v: unknown) => JSON.stringify(v, null, 2) ?? "null";
const cleanTerminal = (s: string) =>
  s.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
const xml = (s: unknown) =>
  String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[c]!,
    );
function details(f: Finding): string {
  return [
    f.explanation,
    `Fix: ${f.fix}`,
    f.input !== undefined ? `Input: ${display(f.input)}` : "",
    f.actual !== undefined ? `Actual: ${display(f.actual)}` : "",
    f.expected ? `Expected: ${f.expected}` : "",
    f.reproduction ? `Reproduce: ${f.reproduction}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
export function consoleReport(report: Report, color = false): string {
  const tint = (s: string, status: string) =>
    color
      ? `\u001b[${({ pass: 32, warn: 33, fail: 31, skipped: 90 } as Record<string, number>)[status] ?? 36}m${s}\u001b[0m`
      : s;
  const lines = [
    `mcpprobe ${report.command} — ${cleanTerminal(report.target)}`,
    `Seed: ${report.seed} | Duration: ${report.durationMs} ms`,
  ];
  if (report.inventory && report.command === "inspect")
    lines.push(display(report.inventory));
  const groups = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const key = f.tool ?? "server";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  for (const [group, findings] of groups) {
    lines.push(`\n  ${cleanTerminal(group)}`);
    for (const f of findings) {
      lines.push(
        `    ${tint(f.status.toUpperCase(), f.status)} ${f.id}: ${cleanTerminal(f.explanation)}`,
      );
      if (f.status === "fail")
        lines.push(
          ...cleanTerminal(details(f))
            .split("\n")
            .map((s) => `      ${s}`),
        );
      else if (f.status === "warn")
        lines.push(`      Fix: ${cleanTerminal(f.fix)}`);
    }
  }
  for (const b of report.benchmarks ?? [])
    lines.push(
      `\n  ${b.tool}: ${b.calls} calls | p50 ${b.p50.toFixed(2)} ms | p90 ${b.p90.toFixed(2)} ms | p99 ${b.p99.toFixed(2)} ms | error rate ${(b.errorRate * 100).toFixed(2)}% | ${b.throughput.toFixed(2)} calls/s`,
    );
  const s = report.summary;
  lines.push(
    `\nSummary: ${s.pass} passed, ${s.warn} warned, ${s.fail} failed, ${s.skipped} skipped | ${report.durationMs} ms | seed ${report.seed}`,
  );
  return lines.join("\n") + "\n";
}
export function junitReport(report: Report): string {
  const strictWarning = (f: Finding) =>
    f.status === "warn" && report.exitCode === 1 && report.summary.fail === 0;
  const failureCount = report.findings.filter(
    (f) => f.status === "fail" || strictWarning(f),
  ).length;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="mcpprobe.${xml(report.command)}" tests="${report.findings.length}" failures="${failureCount}" skipped="${report.summary.skipped}" time="${report.durationMs / 1000}"><properties><property name="seed" value="${report.seed}"/><property name="target" value="${xml(report.target)}"/></properties>\n` +
    report.findings
      .map(
        (f, i) =>
          `<testcase classname="${xml(f.tool ?? "server")}" name="${xml(f.id)}.${i}">${f.status === "fail" || strictWarning(f) ? `<failure type="${xml(f.id)}" message="${xml(f.explanation)}">${xml(details(f))}</failure>` : f.status === "skipped" ? `<skipped message="${xml(f.explanation)}"/>` : `<system-out>${xml(details(f))}</system-out>`}</testcase>`,
      )
      .join("\n") +
    "\n</testsuite></testsuites>\n"
  );
}
export function markdownReport(report: Report): string {
  const escape = (s: string) =>
    s.replace(/[<>&|`]/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\n/g, " ");
  const lines = [
    `# mcpprobe ${escape(report.command)}`,
    "",
    `Target: ${escape(report.target)}`,
    `Seed: **${report.seed}** · Duration: ${report.durationMs} ms`,
    "",
    `Passed: ${report.summary.pass} · Warned: ${report.summary.warn} · Failed: ${report.summary.fail} · Skipped: ${report.summary.skipped}`,
    "",
    "| Status | Check | Tool | Explanation |",
    "|---|---|---|---|",
  ];
  for (const f of report.findings)
    lines.push(
      `| ${f.status} | ${f.id} | ${escape(f.tool ?? "server")} | ${escape(f.explanation)} |`,
    );
  for (const f of report.findings.filter((f) => f.status === "fail"))
    lines.push(
      "",
      `## ${f.id}: ${escape(f.tool ?? "server")}`,
      "",
      ...details(f)
        .split("\n")
        .map((s) => `    ${s}`),
    );
  if (report.inventory && report.command === "inspect")
    lines.push(
      "",
      "## Inventory",
      "",
      ...display(report.inventory)
        .split("\n")
        .map((s) => `    ${s}`),
    );
  if (report.benchmarks)
    lines.push(
      "",
      "## Benchmarks",
      "",
      ...display(report.benchmarks)
        .split("\n")
        .map((s) => `    ${s}`),
    );
  return lines.join("\n") + "\n";
}
export function sarifReport(report: Report): string {
  const ids = [...new Set(report.findings.map((f) => f.id))];
  return (
    display({
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "mcpprobe",
              version: "0.1.0",
              rules: ids.map((id) => ({ id, shortDescription: { text: id } })),
            },
          },
          properties: {
            seed: report.seed,
            target: report.target,
            summary: report.summary,
            durationMs: report.durationMs,
          },
          results: report.findings
            .filter((f) => f.status === "fail" || f.status === "warn")
            .map((f) => ({
              ruleId: f.id,
              level: f.status === "fail" ? "error" : "warning",
              message: { text: details(f) },
              properties: {
                tool: f.tool,
                input: f.input,
                actual: f.actual,
                expected: f.expected,
                reproduction: f.reproduction,
              },
            })),
        },
      ],
    }) + "\n"
  );
}
export function formatReport(
  report: Report,
  format: ReportFormat = "console",
  color = false,
): string {
  switch (format) {
    case "json":
      return display(report) + "\n";
    case "junit":
      return junitReport(report);
    case "markdown":
      return markdownReport(report);
    case "sarif":
      return sarifReport(report);
    default:
      return consoleReport(report, color);
  }
}

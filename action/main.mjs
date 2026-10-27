// Runs mcpprobe for the GitHub Action, then writes the log, job summary and SARIF.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const env = process.env;
const temp = env.RUNNER_TEMP || tmpdir();
const pkgDir = join(env.DIR, "node_modules", "@zahid15", "mcpprobe");
const setOutput = (key, value) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
const fail = (message) => {
  console.log(`::error title=mcpprobe::${message}`);
  setOutput("exit-code", 2);
  process.exit(0);
};

// Split args like a shell (quotes and $VARS) without running anything.
const { parse } = createRequire(join(pkgDir, "package.json"))("shell-quote");
const args = parse(env.ARGS ?? "", (key) => env[key] ?? "");
if (args.some((a) => typeof a !== "string"))
  fail("args must not contain shell operators such as | ; & > or wildcards");
if (args.some((a) => /^--(?:format|out|json)(?:=|$)/.test(a)))
  fail("Do not pass --format, --json or --out in args; the action sets them");

const reportPath = join(temp, "mcpprobe-report.json");
rmSync(reportPath, { force: true });
const run = spawnSync(
  process.execPath,
  [join(pkgDir, "dist/cli/index.js"), env.COMMAND || "test", ...args, "--format", "json", "--out", reportPath],
  { stdio: "inherit" },
);
setOutput("exit-code", run.status ?? 1);
setOutput("report", reportPath);
if (!existsSync(reportPath)) {
  console.log("mcpprobe did not write a report; see the error above.");
  process.exit(0);
}

const { formatReport } = await import(pathToFileURL(join(pkgDir, "dist/core/index.js")).href);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const { pass, warn, fail: failed, skipped } = report.summary;
setOutput("passed", pass);
setOutput("warned", warn);
setOutput("failed", failed);
process.stdout.write(formatReport(report, "console", true));

// Job summary: counts, a table of problems, and commands to reproduce them.
const problems = report.findings.filter((f) => f.status === "fail" || f.status === "warn");
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 200);
const summary = [
  `### mcpprobe ${report.command}: ${failed ? "failed" : "passed"}`,
  "",
  `**${pass} passed, ${warn} warned, ${failed} failed, ${skipped} skipped** against \`${cell(report.target)}\` (seed ${report.seed})`,
  "",
];
if (problems.length) {
  summary.push("| Status | Check | Tool | Details |", "|---|---|---|---|");
  for (const f of problems.slice(0, 50))
    summary.push(`| ${f.status} | ${f.id} | ${cell(f.tool)} | ${cell(f.explanation)} |`);
  if (problems.length > 50) summary.push("", `${problems.length - 50} more in the log.`);
  const commands = [...new Set(problems.map((f) => f.reproduction).filter(Boolean))].slice(0, 20);
  if (commands.length)
    summary.push("", "<details><summary>Reproduce</summary>", "", "```sh", ...commands, "```", "", "</details>");
}
for (const b of report.benchmarks ?? [])
  summary.push("", `**${b.tool}**: ${b.calls} calls, p50 ${b.p50.toFixed(2)} ms, p99 ${b.p99.toFixed(2)} ms, ${(b.errorRate * 100).toFixed(2)}% errors`);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");

// Code scanning needs a repository file for every result. A server test has no
// source file, so attach findings to the workflow that ran it.
const workflow = (env.GITHUB_WORKFLOW_REF ?? "").split("@")[0].split("/").slice(2).join("/");
const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
const location =
  env.SARIF_LOCATION ||
  [workflow, "package.json", "README.md"].find((f) => f && existsSync(join(workspace, f))) ||
  workflow ||
  "README.md";
const sarif = JSON.parse(formatReport(report, "sarif"));
const fixes = new Map();
for (const f of report.findings)
  if (f.fix && f.fix !== "None" && !fixes.has(f.id)) fixes.set(f.id, f.fix);
for (const run of sarif.runs) {
  for (const rule of run.tool.driver.rules)
    if (fixes.has(rule.id)) rule.help = { text: fixes.get(rule.id) };
  for (const result of run.results) {
    result.locations = [
      { physicalLocation: { artifactLocation: { uri: location }, region: { startLine: 1 } } },
    ];
    // Stable identity across runs, so code scanning tracks each problem separately.
    const p = result.properties ?? {};
    result.partialFingerprints = {
      "mcpprobe/v1": createHash("sha256")
        .update(JSON.stringify([result.ruleId, p.tool ?? null, p.input ?? null, p.expected ?? null]))
        .digest("hex")
        .slice(0, 32),
    };
  }
}
const sarifPath = join(temp, "mcpprobe.sarif");
writeFileSync(sarifPath, JSON.stringify(sarif, null, 2));
setOutput("sarif", sarifPath);

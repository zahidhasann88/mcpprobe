#!/usr/bin/env node
import {
  Command,
  Option,
  InvalidArgumentError,
  CommanderError,
} from "commander";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import {
  loadConfig,
  resolveOptions,
  inspect,
  testServer,
  fuzz,
  bench,
  callTool,
  runScenarios,
  loadScenarios,
  diff,
  diffSnapshots,
  loadSnapshot,
  formatReport,
  redact,
  safetyWarnings,
  UsageError,
  type Options,
  type Report,
  type ReportFormat,
} from "../core/index.js";
import { VERSION } from "../core/version.js";
let currentOptions: Options | undefined;
function integer(value: string): number {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new InvalidArgumentError("Expected an integer");
  return Number(value);
}
function positive(value: string): number {
  const n = integer(value);
  if (n <= 0) throw new InvalidArgumentError("Expected a positive integer");
  return n;
}
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
function pairs(
  values: string[] = [],
  delimiter: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const i = value.indexOf(delimiter);
    if (i < 1) throw new UsageError(`Expected key${delimiter}value`);
    result[value.slice(0, i).trim()] = value.slice(i + 1).trim();
  }
  return result;
}
function common(command: Command): Command {
  return command
    .option(
      "--stdio <command>",
      "Executable and arguments (no shell operators)",
    )
    .option(
      "--http <url>",
      "Streamable HTTP endpoint (404/405 may fall back to SSE)",
    )
    .option("--sse", "Use legacy SSE explicitly")
    .option("--header <header>", "HTTP header, repeatable", collect)
    .option(
      "--env <assignment>",
      "Server environment KEY=VALUE, repeatable",
      collect,
    )
    .option("--config <path>", "JSON/YAML configuration file")
    .option("--target <name>", "Configured target")
    .option("--timeout <ms>", "Per-call timeout (default 15000 ms)", positive)
    .option("--max-duration <ms>", "Total budget (default 120000 ms)", positive)
    .option(
      "--latency-budget <ms>",
      "Latency warning threshold (default 2000 ms)",
      positive,
    )
    .option(
      "--allow-tool <name>",
      "Explicit safe allowlist, repeatable",
      collect,
    )
    .option("--deny-tool <name>", "Never invoke this tool, repeatable", collect)
    .option("--allow-unsafe", "Permit unannotated/non-read-only tools")
    .option("--allow-destructive", "Separately permit destructive tools")
    .option(
      "--yes",
      "Acknowledge unsafe/destructive overrides without a prompt",
    )
    .option(
      "--seed <number>",
      "Reproducible integer seed (default 424242)",
      integer,
    )
    .option("--strict", "Treat warnings as failures")
    .addOption(
      new Option("--format <format>", "Report format").choices([
        "console",
        "json",
        "junit",
        "markdown",
        "sarif",
      ]),
    )
    .option("--json", "Alias for --format json")
    .option("--out <file>", "Write report to a file (mode 0600)");
}
async function optionsFor(
  flags: Record<string, any>,
  invoke: boolean,
): Promise<Options> {
  const config = await loadConfig(flags.config);
  const options = resolveOptions(config, {
    ...flags,
    ...(flags.header ? { headers: pairs(flags.header, ":") } : {}),
    ...(flags.env ? { env: pairs(flags.env, "=") } : {}),
  });
  currentOptions = options;
  if (invoke) {
    for (const warning of safetyWarnings(options))
      process.stderr.write(warning + "\n");
    if (
      (options.allowUnsafe || options.allowDestructive) &&
      !options.yes &&
      process.stdin.isTTY &&
      process.stderr.isTTY
    ) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        options.yes = /^y(?:es)?$/i.test(
          (
            await rl.question(
              "Proceed with potentially side-effecting calls? [y/N] ",
            )
          ).trim(),
        );
      } finally {
        rl.close();
      }
    }
  }
  return options;
}
async function output(
  report: Report,
  flags: Record<string, any>,
  raw?: unknown,
): Promise<void> {
  if (flags.strict && report.exitCode === 0 && report.summary.warn)
    report.exitCode = 1;
  const format = flags.json ? "json" : (flags.format ?? "console");
  const text =
    report.command === "call" &&
    raw !== undefined &&
    !flags.format &&
    !flags.json
      ? JSON.stringify(raw, null, 2) + "\n"
      : formatReport(
          report,
          format as ReportFormat,
          !flags.out && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
        );
  if (flags.out) {
    try {
      await writeFile(flags.out, text, { mode: 0o600 });
    } catch {
      throw new UsageError("Could not write output file");
    }
  } else process.stdout.write(text);
  process.exitCode = report.exitCode;
}
const program = new Command()
  .name("mcpprobe")
  .description("Safety-first scripted testing and fuzzing of MCP servers")
  .version(VERSION)
  .configureOutput({
    outputError: () => {
      process.stderr.write("Invalid command or option. Run mcpprobe --help.\n");
    },
  })
  .exitOverride();
common(
  program
    .command("inspect")
    .description("Initialize and list the complete server inventory"),
).action(async (flags) => {
  const options = await optionsFor(flags, false);
  await output(await inspect(options), flags);
});
common(
  program
    .command("test")
    .description("Run lifecycle, schema, safety and behavior checks"),
)
  .option("--tool <name>", "Select one tool")
  .action(async (flags) => {
    const options = await optionsFor(flags, true);
    await output(await testServer(options, flags.strict), flags);
  });
common(
  program
    .command("fuzz")
    .description("Fuzz tools with reproducible inputs and shrinking"),
)
  .option("--tool <name>")
  .option("--runs <count>", "Runs per tool (default 200)", positive)
  .action(async (flags) => {
    const options = await optionsFor(flags, true);
    await output(await fuzz(options, flags.strict), flags);
  });
common(
  program
    .command("bench")
    .description("Measure call latency, errors and throughput"),
)
  .option("--tool <name>")
  .option("--iterations <count>", "Calls per tool (default 50)", positive)
  .option("--concurrency <count>", "In-flight calls (default 1)", positive)
  .action(async (flags) => {
    const options = await optionsFor(flags, true);
    await output(await bench(options, flags.strict), flags);
  });
common(
  program
    .command("call")
    .description("Manually call a tool (safety policy still applies)"),
)
  .argument("[name]", "Tool name")
  .option("--tool <name>", "Alternative tool selector")
  .requiredOption("--args <json>", "JSON object arguments")
  .action(async (name: string | undefined, flags) => {
    let args: unknown;
    try {
      args = JSON.parse(flags.args);
    } catch {
      throw new UsageError("--args must be valid JSON");
    }
    if (!name && !flags.tool)
      throw new UsageError("Provide a tool name or --tool");
    const options = await optionsFor(flags, true);
    const value = await callTool(
      options,
      name ?? flags.tool,
      args as Record<string, unknown>,
    );
    await output(value.report, flags, value.result);
  });
common(
  program
    .command("run")
    .description("Run scripted scenarios with expectations from a YAML/JSON file"),
)
  .argument("<file>", "Scenario file")
  .action(async (file: string, flags) => {
    const scenarios = await loadScenarios(file);
    const options = await optionsFor(flags, true);
    await output(await runScenarios(options, scenarios, flags.strict, file), flags);
  });
common(
  program
    .command("snapshot")
    .description("Save the server inventory as a baseline for diff"),
)
  .argument("<file>", "Snapshot file to write")
  .action(async (file: string, flags) => {
    const options = await optionsFor(flags, false);
    const report = await inspect(options);
    if (report.inventory && report.exitCode !== 3)
      try {
        await writeFile(file, JSON.stringify(report.inventory, null, 2) + "\n");
      } catch {
        throw new UsageError("Could not write snapshot file");
      }
    report.command = "snapshot";
    if (!flags.format && !flags.json) {
      process.stderr.write(
        report.exitCode === 3
          ? "Could not connect; no snapshot written\n"
          : `Saved ${report.inventory!.tools.length} tools, ${report.inventory!.resources.length} resources and ${report.inventory!.prompts.length} prompts to ${file}\n`,
      );
      process.exitCode = report.exitCode;
    } else await output(report, flags);
  });
common(
  program
    .command("diff")
    .description("Compare a server, or a second snapshot, with a baseline snapshot"),
)
  .argument("<baseline>", "Baseline snapshot file")
  .argument("[current]", "Snapshot to compare instead of connecting to a server")
  .action(async (baselineFile: string, currentFile: string | undefined, flags) => {
    const baseline = await loadSnapshot(baselineFile);
    if (currentFile) {
      const current = await loadSnapshot(currentFile);
      await output(
        diffSnapshots(baseline, current, `${baselineFile} ${currentFile}`, flags.strict),
        flags,
      );
      return;
    }
    const options = await optionsFor(flags, false);
    await output(await diff(options, baseline, flags.strict, baselineFile), flags);
  });
try {
  await program.parseAsync();
} catch (e) {
  if (e instanceof CommanderError) {
    process.exitCode =
      e.code === "commander.helpDisplayed" || e.code === "commander.version"
        ? 0
        : 2;
  } else {
    const message =
      e instanceof UsageError
        ? e.message
        : "Unexpected client error (details omitted to protect secrets)";
    process.stderr.write(redact(message, currentOptions?.secrets ?? []) + "\n");
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}

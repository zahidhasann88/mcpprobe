import { readFile } from "node:fs/promises";
import { inspect, finishReport, quote, targetArgs } from "./runner.js";
import {
  UsageError,
  type Finding,
  type Inventory,
  type Options,
  type Report,
} from "./types.js";
export async function loadSnapshot(file: string): Promise<Inventory> {
  let data: any;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new UsageError(`Cannot read snapshot: ${file}`);
  }

  const inventory = data?.inventory ?? data;
  if (!inventory || !Array.isArray(inventory.tools))
    throw new UsageError(`Not an mcpprobe snapshot: ${file}`);
  return {
    server: inventory.server,
    protocolVersion: inventory.protocolVersion ?? "",
    capabilities: inventory.capabilities ?? {},
    tools: inventory.tools,
    resources: inventory.resources ?? [],
    resourceTemplates: inventory.resourceTemplates ?? [],
    prompts: inventory.prompts ?? [],
  };
}
type Changes = { breaking: string[]; compatible: string[] };
const types = (s: any): string[] | undefined =>
  s?.type === undefined ? undefined : [s.type].flat();
const covers = (wide: string[], t: string) =>
  wide.includes(t) || (t === "integer" && wide.includes("number"));

function compareSchema(
  before: any,
  after: any,
  path: string,
  direction: "input" | "output",
  out: Changes,
) {
  if (
    !before ||
    !after ||
    typeof before !== "object" ||
    typeof after !== "object"
  )
    return;
  const at = path || "(root)";
  const [narrow, wide] =
    direction === "input" ? [after, before] : [before, after];
  const narrowTypes = types(narrow);
  const wideTypes = types(wide);
  if (
    narrowTypes &&
    (!wideTypes || wideTypes.some((t) => !covers(narrowTypes, t)))
  )
    out.breaking.push(
      `${at}: type changed from ${JSON.stringify(before.type ?? "any")} to ${JSON.stringify(after.type ?? "any")}`,
    );
  if (
    Array.isArray(narrow.enum) &&
    (!Array.isArray(wide.enum) ||
      wide.enum.some(
        (v: unknown) =>
          !narrow.enum.some(
            (n: unknown) => JSON.stringify(n) === JSON.stringify(v),
          ),
      ))
  )
    out.breaking.push(`${at}: allowed values changed`);
  if (direction === "input") {
    for (const [key, tighter] of [
      ["minimum", (a: number, b: number) => b > a],
      ["minLength", (a: number, b: number) => b > a],
      ["minItems", (a: number, b: number) => b > a],
      ["maximum", (a: number, b: number) => b < a],
      ["maxLength", (a: number, b: number) => b < a],
      ["maxItems", (a: number, b: number) => b < a],
    ] as const)
      if (
        typeof after[key] === "number" &&
        (typeof before[key] !== "number" || tighter(before[key], after[key]))
      )
        out.breaking.push(
          `${at}: ${key} tightened from ${before[key] ?? "none"} to ${after[key]}`,
        );
    if (after.pattern !== undefined && after.pattern !== before.pattern)
      out.breaking.push(`${at}: pattern changed`);
    if (
      before.additionalProperties !== false &&
      after.additionalProperties === false
    )
      out.breaking.push(`${at}: additional properties are no longer accepted`);
  }
  const beforeProps = before.properties ?? {};
  const afterProps = after.properties ?? {};
  const beforeRequired = new Set<string>(before.required ?? []);
  const afterRequired = new Set<string>(after.required ?? []);
  for (const name of Object.keys(beforeProps)) {
    const p = path ? `${path}.${name}` : name;
    if (!(name in afterProps)) {
      if (direction === "output" || after.additionalProperties === false)
        out.breaking.push(`${p}: removed`);
      else
        out.compatible.push(
          `${p}: removed (still accepted as an extra property)`,
        );
    } else
      compareSchema(beforeProps[name], afterProps[name], p, direction, out);
  }
  for (const name of Object.keys(afterProps))
    if (!(name in beforeProps))
      (direction === "input" && afterRequired.has(name)
        ? out.breaking
        : out.compatible
      ).push(
        `${path ? `${path}.${name}` : name}: added${afterRequired.has(name) ? " as required" : ""}`,
      );
  for (const name of afterRequired)
    if (
      direction === "input" &&
      name in beforeProps &&
      !beforeRequired.has(name)
    )
      out.breaking.push(`${path ? `${path}.${name}` : name}: now required`);
  for (const name of beforeRequired)
    if (
      direction === "output" &&
      name in afterProps &&
      !afterRequired.has(name)
    )
      out.breaking.push(
        `${path ? `${path}.${name}` : name}: no longer always returned`,
      );
  compareSchema(before.items, after.items, `${at}[]`, direction, out);
}
const byKey = <T>(items: T[], key: (t: T) => string) =>
  new Map(items.map((t) => [key(t), t]));
export function diffInventories(
  before: Inventory,
  after: Inventory,
  reproduction?: string,
): Finding[] {
  const findings: Finding[] = [];
  const add = (f: Omit<Finding, "fix"> & { fix?: string }) =>
    findings.push({ fix: "None", reproduction, ...f });
  const breaking = (
    tool: string | undefined,
    what: string,
    details: string[],
  ) =>
    add({
      id: "BREAKING_CHANGE",
      status: "fail",
      tool,
      actual: details,
      expected: "No changes that break existing clients",
      explanation: `${what}: ${details[0]}${details.length > 1 ? ` (+${details.length - 1} more)` : ""}`,
      fix: "Restore compatibility, or release the change as a new major version and update the baseline",
    });
  for (const cap of Object.keys(before.capabilities ?? {}))
    if (!(cap in (after.capabilities ?? {})))
      breaking(undefined, "Capabilities", [`${cap} capability removed`]);
  const oldTools = byKey(before.tools, (t) => t.name);
  const newTools = byKey(after.tools, (t) => t.name);
  for (const [name, old] of oldTools) {
    const now = newTools.get(name);
    if (!now) {
      breaking(name, `Tool ${name}`, ["tool removed"]);
      continue;
    }
    const changes: Changes = { breaking: [], compatible: [] };
    compareSchema(old.inputSchema, now.inputSchema, "", "input", changes);
    if (old.outputSchema && !now.outputSchema)
      changes.breaking.push("outputSchema removed");
    else
      compareSchema(
        old.outputSchema,
        now.outputSchema,
        "output",
        "output",
        changes,
      );
    if (changes.breaking.length)
      breaking(name, `Tool ${name}`, changes.breaking);
    if (changes.compatible.length)
      add({
        id: "INVENTORY_CHANGE",
        status: "pass",
        tool: name,
        actual: changes.compatible,
        explanation: `Tool ${name}: ${changes.compatible.join("; ")}`,
      });
    const safety: string[] = [];
    if (
      old.annotations?.readOnlyHint === true &&
      now.annotations?.readOnlyHint !== true
    )
      safety.push("no longer read-only");
    if (
      old.annotations?.destructiveHint !== true &&
      now.annotations?.destructiveHint === true
    )
      safety.push("now destructive");
    if (
      old.annotations?.openWorldHint === false &&
      now.annotations?.openWorldHint !== false
    )
      safety.push("now reaches external systems");
    if (safety.length)
      add({
        id: "SAFETY_CHANGE",
        status: "warn",
        tool: name,
        actual: safety,
        explanation: `Tool ${name} is ${safety.join(" and ")}`,
        fix: "Review the new side effects before allowing this tool",
      });
    if (old.description !== now.description || old.title !== now.title)
      add({
        id: "DESCRIPTION_CHANGE",
        status: "warn",
        tool: name,
        actual: { before: old.description, after: now.description },
        explanation: `Tool ${name} description changed`,
        fix: "Review the new description: a changed description can carry new instructions to the model",
      });
  }
  for (const name of newTools.keys())
    if (!oldTools.has(name))
      add({
        id: "INVENTORY_CHANGE",
        status: "pass",
        tool: name,
        explanation: `Tool ${name} added`,
      });
  const oldPrompts = byKey(before.prompts, (p) => p.name);
  const newPrompts = byKey(after.prompts, (p) => p.name);
  for (const [name, old] of oldPrompts) {
    const now = newPrompts.get(name);
    if (!now) {
      breaking(undefined, `Prompt ${name}`, ["prompt removed"]);
      continue;
    }
    const oldArgs = byKey<any>(old.arguments ?? [], (a) => a.name);
    const problems = (now.arguments ?? [])
      .filter((a: any) => a.required && !oldArgs.get(a.name)?.required)
      .map((a: any) => `argument ${a.name} is now required`);
    if (problems.length) breaking(undefined, `Prompt ${name}`, problems);
    if (old.description !== now.description)
      add({
        id: "DESCRIPTION_CHANGE",
        status: "warn",
        actual: { before: old.description, after: now.description },
        explanation: `Prompt ${name} description changed`,
        fix: "Review the new description for unexpected instructions",
      });
  }
  for (const name of newPrompts.keys())
    if (!oldPrompts.has(name))
      add({
        id: "INVENTORY_CHANGE",
        status: "pass",
        explanation: `Prompt ${name} added`,
      });
  for (const [list, key, label] of [
    ["resources", "uri", "Resource"],
    ["resourceTemplates", "uriTemplate", "Resource template"],
  ] as const) {
    const oldItems = byKey<any>(before[list], (r) => r[key]);
    const newItems = byKey<any>(after[list], (r) => r[key]);
    for (const id of oldItems.keys())
      if (!newItems.has(id))
        breaking(undefined, `${label} ${id}`, [
          `${label.toLowerCase()} removed`,
        ]);
    for (const id of newItems.keys())
      if (!oldItems.has(id))
        add({
          id: "INVENTORY_CHANGE",
          status: "pass",
          explanation: `${label} ${id} added`,
        });
  }
  if (!findings.length)
    add({
      id: "INVENTORY_CHANGE",
      status: "pass",
      explanation: "No changes since the baseline",
    });
  return findings;
}

export async function diff(
  options: Options,
  baseline: Inventory,
  strict = false,
  baselineFile?: string,
): Promise<Report> {
  const report = await inspect(options);
  report.command = "diff";
  if (report.inventory && report.exitCode !== 3) {
    report.findings = report.findings.filter((f) => f.status !== "pass");
    report.findings.push(
      ...diffInventories(
        baseline,
        report.inventory,
        baselineFile
          ? `mcpprobe diff ${quote(baselineFile)} ${targetArgs(options)}`
          : undefined,
      ),
    );
  }
  return finishReport(report, options, strict);
}

export function diffSnapshots(
  baseline: Inventory,
  current: Inventory,
  label: string,
  strict = false,
): Report {
  const report: Report = {
    command: "diff",
    target: label,
    seed: 0,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    findings: diffInventories(baseline, current, `mcpprobe diff ${label}`),
    summary: { pass: 0, warn: 0, fail: 0, skipped: 0 },
    exitCode: 0,
  };
  return finishReport(report, undefined, strict);
}

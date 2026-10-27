import { readFile } from "node:fs/promises";
import { parse as yaml } from "yaml";
import { z } from "zod";
import type { Options } from "./types.js";
import { UsageError } from "./types.js";
const positive = z.number().int().positive();
const fields = {
  stdio: z.string().min(1).optional(),
  http: z.url().optional(),
  sse: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  timeout: positive.optional(),
  maxDuration: positive.optional(),
  latencyBudget: positive.optional(),
  allowTool: z.array(z.string()).optional(),
  denyTool: z.array(z.string()).optional(),
  allowUnsafe: z.boolean().optional(),
  allowDestructive: z.boolean().optional(),
  seed: z.number().int().optional(),
  runs: positive.optional(),
  iterations: positive.optional(),
  concurrency: positive.optional(),
  tool: z.string().optional(),
};
const targetSchema = z.object(fields).strict();
export const configSchema = z
  .object({
    ...fields,
    defaultTarget: z.string().optional(),
    targets: z.record(z.string(), targetSchema).optional(),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export async function loadConfig(file?: string): Promise<Config> {
  for (const name of file
    ? [file]
    : ["mcpprobe.config.json", "mcpprobe.config.yaml", "mcpprobe.config.yml"]) {
    let text: string;
    try {
      text = await readFile(name, "utf8");
    } catch (e) {
      if (!file && (e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new UsageError("Cannot read configuration file");
    }
    try {
      return configSchema.parse(yaml(text));
    } catch {
      throw new UsageError(
        "Invalid configuration (check field names and types; secret values omitted)",
      );
    }
  }
  return {};
}
export function resolveOptions(
  config: Config = {},
  flags: Record<string, any> = {},
  environment: NodeJS.ProcessEnv = process.env,
): Options {
  const name = flags.target ?? config.defaultTarget;
  if (name && !config.targets?.[name])
    throw new UsageError(`Unknown target: ${name}`);
  const selected: z.infer<typeof targetSchema> = name
    ? config.targets![name]
    : {};
  const clean = Object.fromEntries(
    Object.entries(flags).filter(([, v]) => v !== undefined),
  );
  const merged: Record<string, any> = { ...config, ...selected, ...clean };
  // A transport flag selects that transport, rather than retaining a configured alternative.
  if (selected.stdio && !selected.http) delete merged.http;
  if (selected.http && !selected.stdio) delete merged.stdio;
  if (flags.stdio) delete merged.http;
  if (flags.http) delete merged.stdio;
  if (flags.stdio && flags.http)
    throw new UsageError("Choose exactly one transport flag");
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(environment))
    if (
      value &&
      /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)/i.test(
        key,
      )
    )
      secrets.add(value);
  function interpolate(value: string): string {
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_, key: string) => {
        const result = environment[key];
        if (result === undefined)
          throw new UsageError(`Missing environment variable: ${key}`);
        if (result) secrets.add(result);
        return result;
      },
    );
  }
  const map = (v: Record<string, string>) =>
    Object.fromEntries(Object.entries(v).map(([k, s]) => [k, interpolate(s)]));
  const headers = map({
    ...config.headers,
    ...selected.headers,
    ...flags.headers,
  });
  const env = map({ ...config.env, ...selected.env, ...flags.env });
  for (const value of [...Object.values(headers), ...Object.values(env)])
    if (value) {
      secrets.add(value);
      const bearer = /^Bearer\s+(.+)$/i.exec(value);
      if (bearer) secrets.add(bearer[1]);
    }
  if (Boolean(merged.stdio) === Boolean(merged.http))
    throw new UsageError(
      "Choose exactly one of --stdio or --http (or a configured target)",
    );
  try {
    targetSchema.parse(
      Object.fromEntries(
        Object.keys(fields)
          .filter((k) => merged[k] !== undefined)
          .map((k) => [k, merged[k]]),
      ),
    );
  } catch {
    throw new UsageError(
      "Invalid options: numeric limits must be positive integers and target fields must have valid types",
    );
  }
  const stdio = merged.stdio ? interpolate(merged.stdio) : undefined;
  const http = merged.http ? interpolate(merged.http) : undefined;
  if (http) {
    try {
      for (const value of new URL(http).searchParams.values())
        if (value) secrets.add(value);
    } catch {
      throw new UsageError("Invalid HTTP URL");
    }
  }
  if (stdio)
    for (const match of stdio.matchAll(
      /--(?:token|password|secret|api-key|authorization)(?:=|\s+)["']?([^\s"']+)/gi,
    ))
      secrets.add(match[1]);
  return {
    target: { stdio, http, sse: merged.sse, headers, env, cwd: merged.cwd },
    timeout: merged.timeout ?? 15000,
    maxDuration: merged.maxDuration ?? 120000,
    latencyBudget: merged.latencyBudget ?? 2000,
    allowTool: merged.allowTool ?? [],
    denyTool: merged.denyTool ?? [],
    allowUnsafe: merged.allowUnsafe ?? false,
    allowDestructive: merged.allowDestructive ?? false,
    yes: flags.yes ?? false,
    seed: merged.seed ?? 424242,
    tool: merged.tool,
    runs: merged.runs ?? 200,
    iterations: merged.iterations ?? 50,
    concurrency: merged.concurrency ?? 1,
    secrets: [...secrets].sort((a, b) => b.length - a.length),
  };
}
export function redact<T>(value: T, secrets: string[]): T {
  // Redact string leaves before serialization, including control characters and quotes.
  const visit = (v: any): any => {
    if (typeof v === "string") {
      for (const secret of secrets)
        if (secret) v = v.split(secret).join("[REDACTED]");
      return v
        .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
        .replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/g, "$1[REDACTED]@");
    }
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [visit(k), visit(x)]),
      );
    return v;
  };
  return visit(value) as T;
}

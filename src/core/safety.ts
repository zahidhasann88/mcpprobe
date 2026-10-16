import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { UsageError, type Options } from "./types.js";
export function safetyDecision(
  tool: Tool,
  options: Options,
): { allowed: boolean; reason: string } {
  if (options.denyTool.includes(tool.name))
    return { allowed: false, reason: "skipped (denied by policy)" };
  if (tool.annotations?.destructiveHint === true && !options.allowDestructive)
    return { allowed: false, reason: "skipped (not known to be safe)" };
  if (tool.annotations?.destructiveHint === true && options.allowDestructive)
    return { allowed: true, reason: "explicit destructive override" };
  if (
    tool.annotations?.readOnlyHint === true ||
    options.allowTool.includes(tool.name)
  )
    return { allowed: true, reason: "read-only or explicit allowlist" };
  if (options.allowUnsafe)
    return { allowed: true, reason: "explicit unsafe override" };
  return { allowed: false, reason: "skipped (not known to be safe)" };
}
export function safetyWarnings(options: Options): string[] {
  return [
    ...(options.allowUnsafe
      ? [
          "WARNING: --allow-unsafe permits tools not known to be read-only. Calls may change or expose data.",
        ]
      : []),
    ...(options.allowDestructive
      ? [
          "WARNING: --allow-destructive permits destructive tools. Calls may permanently delete or modify data.",
        ]
      : []),
  ];
}
export function requireConsent(options: Options): void {
  // Library callers explicitly acknowledge too: never silently infer interactive consent.
  if ((options.allowUnsafe || options.allowDestructive) && !options.yes)
    throw new UsageError(
      "Unsafe overrides require explicit consent (--yes in non-interactive mode)",
    );
}

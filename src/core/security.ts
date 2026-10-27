import type { Finding, Inventory } from "./types.js";
const hiddenCharacters = /[​-‏⁠-⁤﻿‪-‮⁦-⁩]|\uDB40[\uDC00-\uDC7F]/u;
const injectionPatterns: [RegExp, string][] = [
  [
    /\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:previous|prior|above|earlier|other|system)\b.{0,20}\b(?:instructions?|prompts?|rules?|messages?)\b/i,
    "asks the model to override its instructions",
  ],
  [
    /\b(?:do not|don't|never)\b.{0,20}\b(?:tell|inform|mention|reveal|show|notify)\b.{0,20}\buser\b/i,
    "asks the model to hide something from the user",
  ],
  [
    /<\/?\s*(?:important|system|instructions?|secret|hidden)\b[^>]*>/i,
    "contains an instruction tag",
  ],
  [/<!--[\s\S]*?-->/, "contains a hidden HTML comment"],
  [
    /(?:~\/\.ssh|\bid_(?:rsa|ed25519)\b|\.aws\/credentials|\/etc\/(?:passwd|shadow)|\bmcp\.json\b|(?:^|[\s/"'`])\.env\b)/i,
    "references a sensitive file",
  ],
  [
    /\b(?:send|pass|include|append|forward|upload|exfiltrate)\b.{0,60}\b(?:passwords?|tokens?|api[ _-]?keys?|secrets?|credentials?|private keys?|ssh keys?)\b/i,
    "asks for credentials to be sent",
  ],
];
const maxDescription = 2000;
const skipKeys = new Set([
  "uri",
  "uriTemplate",
  "mimeType",
  "$schema",
  "$id",
  "$ref",
  "type",
  "format",
  "pattern",
]);
function texts(value: unknown, path: string, out: [string, string][]) {
  if (typeof value === "string") out.push([path || "value", value]);
  else if (Array.isArray(value))
    value.forEach((v, i) => texts(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value))
      if (!skipKeys.has(k)) texts(v, path ? `${path}.${k}` : k, out);
  return out;
}
export function poisoningChecks(
  inventory: Inventory,
  reproduction?: string,
): Finding[] {
  const findings: Finding[] = [];
  const entries: [string, string | undefined, unknown][] = [
    ...inventory.tools.map((t): [string, string, unknown] => [
      "tool",
      t.name,
      t,
    ]),
    ...inventory.prompts.map((p): [string, string, unknown] => [
      "prompt",
      p.name,
      p,
    ]),
    ...inventory.resources.map((r): [string, string, unknown] => [
      "resource",
      r.uri,
      r,
    ]),
    ...inventory.resourceTemplates.map((r): [string, string, unknown] => [
      "resource template",
      r.uriTemplate,
      r,
    ]),
  ];
  for (const [kind, name, item] of entries) {
    const tool = kind === "tool" ? name : undefined;
    const problems: string[] = [];
    for (const [field, text] of texts(item, "", [])) {
      if (hiddenCharacters.test(text))
        problems.push(
          `${field} contains invisible or bidirectional Unicode characters`,
        );
      for (const [pattern, reason] of injectionPatterns)
        if (pattern.test(text)) problems.push(`${field} ${reason}`);
    }
    if (problems.length)
      findings.push({
        id: "TOOL_POISONING",
        status: "fail",
        tool,
        actual: [...new Set(problems)],
        expected:
          "Descriptions that only describe behavior, with no hidden content or instructions to the model",
        explanation: `Possible prompt injection in ${kind} ${name}: ${problems[0]}`,
        fix: "Remove hidden characters and instructions aimed at the model from names, descriptions and schemas",
        reproduction,
      });
    const description = (item as { description?: unknown }).description;
    if (typeof description === "string" && description.length > maxDescription)
      findings.push({
        id: "DESCRIPTION_LENGTH",
        status: "warn",
        tool,
        actual: description.length,
        expected: `<= ${maxDescription} characters`,
        explanation: `${kind} ${name} has a ${description.length}-character description`,
        fix: "Keep descriptions short; long descriptions waste context and can hide instructions",
      });
  }
  if (!findings.some((f) => f.id === "TOOL_POISONING"))
    findings.push({
      id: "TOOL_POISONING",
      status: "pass",
      explanation:
        "No hidden characters or injected instructions in descriptions",
      fix: "None",
    });
  return findings;
}

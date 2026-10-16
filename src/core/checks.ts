import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { parse as parseTemplate } from "uri-template";
import { Session } from "./session.js";
import { generateInputs, validator, type Sample } from "./generators.js";
import { safetyDecision } from "./safety.js";
import type { Finding, Inventory } from "./types.js";
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const stackOrPath =
  /(?:\n\s*at\s+.+|(?:^|[\s("'])\/(?:home|Users|usr|app|private|var|tmp|opt)\/[^\s"']+|[A-Za-z]:\\(?:Users|work|app)\\)/;
export function leakFinding(
  value: unknown,
  secrets: string[],
  tool?: string,
  input?: unknown,
): Finding | undefined {
  const strings = (v: any): string[] =>
    typeof v === "string"
      ? [v]
      : v && typeof v === "object"
        ? Object.values(v).flatMap(strings)
        : [];
  const text = strings(value).join("\n");
  if (
    stackOrPath.test(text) ||
    secrets.some((secret) => secret.length >= 4 && text.includes(secret))
  )
    return {
      id: "ERROR_LEAK",
      status: "fail",
      tool,
      input,
      actual: value,
      expected: "No stack traces, absolute local paths or secret values",
      explanation:
        "Response contains a possible stack trace, local path or environment secret",
      fix: "Sanitize errors and keep internal details in private server logs",
    };
}
export async function evaluateSample(
  session: Session,
  tool: Tool,
  sample: Sample,
): Promise<Finding[]> {
  const start = Date.now();
  const findings: Finding[] = [];
  const add = (f: Omit<Finding, "tool" | "input">) =>
    findings.push({ ...f, tool: tool.name, input: sample.input });
  try {
    const result = await session.call(tool.name, sample.input);
    if (!sample.valid) {
      const clear =
        result.isError === true &&
        Array.isArray(result.content) &&
        result.content.some((c: any) => c.type === "text" && c.text?.trim());
      add({
        id: "INVALID_INPUT",
        status: clear ? "pass" : "fail",
        actual: result,
        expected: "A clear isError result or an invalid-params JSON-RPC error",
        explanation: clear
          ? `Rejected ${sample.kind}`
          : `Invalid input was accepted or error was unclear (${sample.kind})`,
        fix: "Validate arguments and return a clear error for invalid input",
      });
    } else
      add({
        id: "VALID_INPUT",
        status: "pass",
        actual: result,
        explanation: result.isError
          ? "Valid input returned a well-formed tool error"
          : "Valid input succeeded",
        fix: "None",
      });
    if (tool.outputSchema && result.isError !== true) {
      try {
        const check = validator(tool.outputSchema);
        const ok =
          result.structuredContent !== undefined &&
          check(result.structuredContent);
        add({
          id: "OUTPUT_SCHEMA",
          status: ok ? "pass" : "fail",
          actual: result.structuredContent ?? null,
          expected: "structuredContent matching outputSchema",
          explanation: ok
            ? "Structured output matches schema"
            : `Structured output violates outputSchema: ${JSON.stringify(check.errors)}`,
          fix: "Return structuredContent conforming to the declared outputSchema",
        });
      } catch (e) {
        add({
          id: "OUTPUT_SCHEMA",
          status: "fail",
          explanation: `Invalid output schema: ${errorText(e)}`,
          actual: tool.outputSchema,
          expected: "Valid JSON Schema",
          fix: "Correct outputSchema",
        });
      }
    }
    const leak = leakFinding(
      result,
      session.options.secrets,
      tool.name,
      sample.input,
    );
    if (leak) findings.push(leak);
  } catch (e) {
    const code = (e as { code?: number }).code;
    const timeout = /timeout|timed out|budget/i.test(errorText(e));
    const properInvalid = !sample.valid && code === -32602;
    add({
      id: timeout
        ? "CALL_TIMEOUT"
        : sample.valid
          ? "VALID_INPUT"
          : "INVALID_INPUT",
      status: properInvalid ? "pass" : "fail",
      actual: { error: errorText(e), code },
      expected: sample.valid
        ? "Tool result (including well-formed isError), not an unhandled protocol error"
        : "Clear rejection without crash or hang",
      explanation: properInvalid
        ? "Invalid arguments rejected with -32602"
        : errorText(e),
      fix: timeout
        ? "Bound tool work and respect cancellation"
        : "Validate input and return isError for tool execution errors",
    });
    const leak = leakFinding(
      errorText(e),
      session.options.secrets,
      tool.name,
      sample.input,
    );
    if (leak) findings.push(leak);
  }
  const elapsed = Date.now() - start;
  if (elapsed > session.options.latencyBudget)
    add({
      id: "TOOL_LATENCY",
      status: "warn",
      actual: elapsed,
      expected: `< ${session.options.latencyBudget} ms`,
      explanation: `Call took ${elapsed} ms`,
      fix: "Optimize tool latency or configure a realistic latencyBudget",
    });
  return findings;
}
export async function toolChecks(
  session: Session,
  inventory: Inventory,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const names = new Set<string>();
  for (const tool of inventory.tools) {
    const add = (f: Omit<Finding, "tool">) =>
      findings.push({ ...f, tool: tool.name });
    const nameValid =
      typeof tool.name === "string" &&
      tool.name.trim() &&
      !names.has(tool.name);
    names.add(tool.name);
    add({
      id: "TOOL_NAME",
      status: nameValid ? "pass" : "fail",
      actual: tool.name,
      explanation: nameValid
        ? "Unique nonempty tool name"
        : "Missing or duplicate tool name",
      fix: "Give each tool a unique descriptive name",
    });
    if (typeof tool.description !== "string" || !tool.description.trim())
      add({
        id: "TOOL_DESCRIPTION",
        status: "warn",
        explanation: "Missing tool description",
        fix: "Describe purpose, input and side effects",
      });
    if (/^(tool|test|run|do|foo|bar|x)\d*$/i.test(tool.name))
      add({
        id: "TOOL_VAGUE_NAME",
        status: "warn",
        explanation: "Overly vague tool name",
        fix: "Use a specific action and subject, e.g. search_documents",
      });
    const selected =
      !session.options.tool || tool.name === session.options.tool;
    const decision = safetyDecision(tool, session.options);
    if (selected && !decision.allowed)
      add({
        id: "SAFETY_SKIP",
        status: "skipped",
        explanation: decision.reason,
        fix: "Review side effects, then explicitly allow this tool; destructiveHint still requires --allow-destructive",
      });
    let samples: Sample[];
    try {
      if (tool.inputSchema?.type !== "object")
        throw new Error("inputSchema must have type object");
      validator(tool.inputSchema);
      add({
        id: "INPUT_SCHEMA",
        status: "pass",
        explanation: "Input schema is valid JSON Schema",
        fix: "None",
      });
      const props = Object.values<any>(tool.inputSchema.properties ?? {});
      if (
        !props.length ||
        props.some((p) => typeof p !== "object" || !p?.description)
      )
        add({
          id: "SCHEMA_DOCUMENTATION",
          status: "warn",
          explanation:
            "One or more properties are undocumented, or schema has no documented properties",
          fix: "Add descriptions to input properties",
        });
      if (tool.outputSchema) {
        try {
          validator(tool.outputSchema);
        } catch (e) {
          add({
            id: "OUTPUT_SCHEMA",
            status: "fail",
            actual: tool.outputSchema,
            expected: "Valid JSON Schema",
            explanation: `Invalid output schema: ${errorText(e)}`,
            fix: "Correct outputSchema",
          });
        }
      }
      samples =
        selected && decision.allowed
          ? generateInputs(tool.inputSchema, session.options.seed)
          : [];
    } catch (e) {
      add({
        id: "INPUT_SCHEMA",
        status: "fail",
        explanation: errorText(e),
        actual: tool.inputSchema,
        expected: "Valid object JSON Schema",
        fix: "Correct the inputSchema, including all property types and constraints",
      });
      continue;
    }
    if (!selected || !decision.allowed) continue;
    if (!samples.length) {
      add({
        id: "INPUT_GENERATION",
        status: "warn",
        explanation: "Could not derive a schema-valid sample",
        fix: "Simplify schema, supply supported formats, or use call --args",
      });
      continue;
    }
    for (const sample of samples) {
      if (!session.remaining()) break;
      findings.push(...(await evaluateSample(session, tool, sample)));
      if (session.diagnostics.unexpectedExit) break;
    }
    if (
      tool.annotations?.readOnlyHint === true &&
      session.remaining() &&
      !session.diagnostics.unexpectedExit
    ) {
      const input = samples.find((s) => s.valid)?.input;
      if (input)
        try {
          const a = await session.call(tool.name, input);
          const b = await session.call(tool.name, input);
          add({
            id: "READONLY_DETERMINISM",
            status: JSON.stringify(a) === JSON.stringify(b) ? "pass" : "warn",
            input,
            actual: { first: a, second: b },
            explanation:
              JSON.stringify(a) === JSON.stringify(b)
                ? "Identical input returned identical output"
                : "Read-only output changed; may be expected for time-dependent data",
            fix: "Document expected nondeterminism or eliminate unintended state changes",
          });
        } catch (e) {
          add({
            id: "READONLY_DETERMINISM",
            status: "warn",
            input,
            explanation: `Could not compare calls: ${errorText(e)}`,
            fix: "Ensure read-only tools accept reproducible inputs",
          });
        }
    }
    if (session.diagnostics.unexpectedExit) break;
  }
  return findings;
}
export async function resourceChecks(
  session: Session,
  inventory: Inventory,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const read = async (uri: string, template = false) => {
    try {
      const result = await session.request("resources/read", { uri });
      const ok =
        Array.isArray(result.contents) &&
        result.contents.length > 0 &&
        result.contents.every(
          (c: any) =>
            c.uri && (typeof c.text === "string" || typeof c.blob === "string"),
        );
      findings.push({
        id: template ? "RESOURCE_TEMPLATE" : "RESOURCE_READ",
        status: ok ? "pass" : "fail",
        actual: result,
        explanation: `Read ${uri}`,
        expected: "Nonempty valid resource contents",
        fix: "Serve listed resources and expanded resource templates",
      });
      if (ok && result.contents.some((c: any) => !c.mimeType))
        findings.push({
          id: "RESOURCE_MIME",
          status: "warn",
          explanation: `Missing MIME type on ${uri}`,
          fix: "Include mimeType on resource contents",
        });
      const leak = leakFinding(result, session.options.secrets);
      if (leak) findings.push(leak);
    } catch (e) {
      findings.push({
        id: template ? "RESOURCE_TEMPLATE" : "RESOURCE_READ",
        status: "fail",
        actual: { uri },
        explanation: errorText(e),
        fix: "Serve listed resources and valid expanded template URIs",
      });
    }
  };
  for (const resource of inventory.resources) {
    if (!session.remaining()) break;
    if (!resource.mimeType)
      findings.push({
        id: "RESOURCE_MIME",
        status: "warn",
        explanation: `Missing MIME type for ${resource.uri}`,
        fix: "Add a MIME type to resource metadata",
      });
    await read(resource.uri);
  }
  for (const template of inventory.resourceTemplates) {
    if (!session.remaining()) break;
    try {
      const parsed = parseTemplate(template.uriTemplate);
      const vars = [
        ...String(template.uriTemplate).matchAll(/\{[+#./;?&]?([^}]+)\}/g),
      ].flatMap((m) => m[1].split(",").map((v) => v.replace(/\*|:\d+$/g, "")));
      await read(
        parsed.expand(Object.fromEntries(vars.map((v) => [v, "example"]))),
        true,
      );
    } catch (e) {
      findings.push({
        id: "RESOURCE_TEMPLATE",
        status: "fail",
        explanation: errorText(e),
        fix: "Use a valid RFC 6570 URI template",
      });
    }
  }
  if (inventory.capabilities.resources && session.remaining()) {
    try {
      const r = await session.request("resources/read", {
        uri: "mcpprobe-unknown://not-found",
      });
      findings.push({
        id: "UNKNOWN_RESOURCE",
        status: "fail",
        actual: r,
        expected: "JSON-RPC error for unknown URI",
        explanation: "Unknown URI returned success",
        fix: "Return a resource-not-found or invalid-params error",
      });
    } catch (e) {
      const code = (e as { code?: number }).code;
      findings.push({
        id: "UNKNOWN_RESOURCE",
        status:
          typeof code === "number" &&
          code !== -32000 &&
          code !== -32001 &&
          code !== -32603
            ? "pass"
            : "fail",
        explanation: errorText(e),
        fix: "Return a proper JSON-RPC error without crashing",
      });
    }
  }
  for (const prompt of inventory.prompts) {
    if (!session.remaining()) break;
    try {
      const args = Object.fromEntries(
        (prompt.arguments ?? []).map((a: any) => [a.name, "example"]),
      );
      const r = await session.request("prompts/get", {
        name: prompt.name,
        arguments: args,
      });
      const ok =
        Array.isArray(r.messages) &&
        r.messages.every(
          (m: any) => ["user", "assistant"].includes(m.role) && m.content?.type,
        );
      findings.push({
        id: "PROMPT_GET",
        status: ok ? "pass" : "fail",
        actual: r,
        explanation: `Retrieved prompt ${prompt.name}`,
        expected: "Valid prompt messages",
        fix: "Return valid messages for listed prompts",
      });
      const leak = leakFinding(r, session.options.secrets);
      if (leak) findings.push(leak);
    } catch (e) {
      findings.push({
        id: "PROMPT_GET",
        status: "fail",
        explanation: errorText(e),
        fix: "Accept documented prompt arguments and return valid messages",
      });
    }
  }
  return findings;
}

export async function protocolChecks(session: Session): Promise<Finding[]> {
  try {
    const result = await session.request("mcpprobe/unknown");
    return [
      {
        id: "UNKNOWN_METHOD",
        status: "fail",
        actual: result,
        expected: "JSON-RPC -32601",
        explanation: "Unknown method returned success",
        fix: "Reject unknown methods with -32601",
      },
    ];
  } catch (e) {
    const code = (e as { code?: number }).code;
    return [
      {
        id: "UNKNOWN_METHOD",
        status: code === -32601 ? "pass" : "fail",
        actual: { code, message: errorText(e) },
        expected: "JSON-RPC -32601",
        explanation:
          code === -32601 ? "Unknown method returned -32601" : errorText(e),
        fix: "Reject unknown methods with -32601 without crashing",
      },
    ];
  }
}

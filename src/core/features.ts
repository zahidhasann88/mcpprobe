import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Session } from "./session.js";
import { validSamples } from "./generators.js";
import { safetyDecision } from "./safety.js";
import type { Finding, Inventory } from "./types.js";
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const logLevels = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];
export async function featureChecks(
  session: Session,
  inventory: Inventory,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const caps = inventory.capabilities as Record<string, any>;
  const probe = async (
    id: string,
    action: () => Promise<string>,
    fix: string,
  ) => {
    if (!session.remaining() || session.diagnostics.unexpectedExit) return;
    try {
      findings.push({
        id,
        status: "pass",
        explanation: await action(),
        fix: "None",
      });
    } catch (e) {
      findings.push({ id, status: "fail", explanation: errorText(e), fix });
    }
  };
  await probe(
    "PING",
    async () => {
      await session.request("ping");
      return "Server answered ping";
    },
    "Respond to ping with an empty result",
  );
  if (caps.logging) {
    await probe(
      "LOGGING",
      async () => {
        await session.request("logging/setLevel", { level: "debug" });
        return "logging/setLevel accepted a valid level";
      },
      "Implement logging/setLevel for the declared logging capability",
    );
    if (session.remaining() && !session.diagnostics.unexpectedExit) {
      // The spec says servers SHOULD use -32602 here, so a different answer is a warning.
      let problem = "logging/setLevel accepted an invalid level";
      try {
        await session.request("logging/setLevel", {
          level: "mcpprobe-invalid",
        });
      } catch (e) {
        problem =
          (e as { code?: number }).code === -32602
            ? ""
            : `Invalid level returned ${errorText(e)} instead of -32602`;
      }
      findings.push({
        id: "LOGGING",
        status: problem ? "warn" : "pass",
        explanation:
          problem || "logging/setLevel rejected an invalid level with -32602",
        fix: "Reject unknown log levels with an invalid-params (-32602) error",
      });
    }
  }
  if (caps.completions) {
    const prompt = inventory.prompts.find((p) => p.arguments?.length);
    const template = inventory.resourceTemplates.find((t) =>
      /\{[^}]+\}/.test(t.uriTemplate),
    );
    const targets: [any, string][] = [
      ...(prompt
        ? [
            [
              { type: "ref/prompt", name: prompt.name },
              prompt.arguments[0].name,
            ] as [any, string],
          ]
        : []),
      ...(template
        ? [
            [
              { type: "ref/resource", uri: template.uriTemplate },
              /\{[+#./;?&]?([^},*:]+)/.exec(template.uriTemplate)![1],
            ] as [any, string],
          ]
        : []),
    ];
    for (const [ref, argument] of targets)
      await probe(
        "COMPLETION",
        async () => {
          const r = await session.request("completion/complete", {
            ref,
            argument: { name: argument, value: "" },
          });
          const values = r.completion?.values;
          if (
            !Array.isArray(values) ||
            values.some((v: unknown) => typeof v !== "string")
          )
            throw new Error("completion.values must be an array of strings");
          if (values.length > 100)
            throw new Error(
              `Returned ${values.length} values; the limit is 100`,
            );
          return `Completed ${ref.name ?? ref.uri} argument ${argument}`;
        },
        "Return { completion: { values: string[] } } with at most 100 values",
      );
  }
  const resource = inventory.resources[0];
  if (caps.resources?.subscribe && resource)
    await probe(
      "RESOURCE_SUBSCRIBE",
      async () => {
        await session.request("resources/subscribe", { uri: resource.uri });
        await session.request("resources/unsubscribe", { uri: resource.uri });
        return `Subscribed to and unsubscribed from ${resource.uri}`;
      },
      "Implement resources/subscribe and resources/unsubscribe for the declared capability",
    );
  return findings;
}

export async function lifecycleChecks(
  session: Session,
  inventory: Inventory,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const eligible = inventory.tools.flatMap((tool) => {
    if (session.options.tool && tool.name !== session.options.tool) return [];
    if (!safetyDecision(tool, session.options).allowed) return [];
    try {
      const input = validSamples(tool.inputSchema, session.options.seed, 1)[0];
      return input ? [{ tool, input }] : [];
    } catch {
      return [];
    }
  });
  for (const { tool, input } of eligible) {
    if (!session.remaining() || session.diagnostics.unexpectedExit) break;
    const before = session.notifications.length;
    try {
      await session.call(tool.name, input, () => {});
    } catch {
      continue;
    }
    const updates: { progress: number }[] = session.notifications
      .slice(before)
      .filter((n) => n.method === "notifications/progress")
      .map((n) => n.params ?? {});
    if (!updates.length) continue;
    const increasing = updates.every(
      (u, i) => i === 0 || u.progress > updates[i - 1].progress,
    );
    findings.push({
      id: "PROGRESS",
      status: increasing ? "pass" : "fail",
      tool: tool.name,
      input,
      actual: updates.map((u) => u.progress),
      expected: "Progress values that increase with every notification",
      explanation: increasing
        ? `${updates.length} progress notification${updates.length === 1 ? "" : "s"} in increasing order`
        : "Progress values did not increase with every notification",
      fix: "Send a strictly increasing progress value in each notifications/progress",
    });
  }
  const first = eligible[0];
  if (first && session.remaining() && !session.diagnostics.unexpectedExit) {
    const controller = new AbortController();
    const pending = session.client
      .request(
        {
          method: "tools/call",
          params: { name: first.tool.name, arguments: first.input },
        },
        CallToolResultSchema,
        {
          signal: controller.signal,
          timeout: Math.min(session.options.timeout, session.remaining()),
        },
      )
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort("mcpprobe cancellation check");
    await pending;
    let alive = false;
    let detail = "";
    try {
      await session.request("ping");
      alive = !session.diagnostics.unexpectedExit;
    } catch (e) {
      detail = errorText(e);
    }
    findings.push({
      id: "CANCELLATION",
      status: alive ? "pass" : "fail",
      tool: first.tool.name,
      input: first.input,
      actual: alive
        ? "Server answered ping after cancellation"
        : detail || "Server exited",
      expected: "Server keeps working after notifications/cancelled",
      explanation: alive
        ? "Server kept working after a request was cancelled"
        : "Server stopped responding after a request was cancelled",
      fix: "Handle notifications/cancelled by stopping the work, without crashing or blocking other requests",
    });
  }
  return findings;
}

export function notificationChecks(
  session: Session,
  inventory: Inventory,
): Finding[] {
  const caps = inventory.capabilities as Record<string, any>;
  const problems: string[] = [];
  for (const { method, params } of session.notifications) {
    switch (method) {
      case "notifications/message":
        if (
          !logLevels.includes(params?.level) ||
          !params ||
          !("data" in params)
        )
          problems.push(`${method} needs a valid level and data`);
        if (!caps.logging)
          problems.push(`${method} sent without the logging capability`);
        break;
      case "notifications/progress":
      case "notifications/cancelled":
        break;
      case "notifications/tools/list_changed":
      case "notifications/prompts/list_changed":
      case "notifications/resources/list_changed": {
        const cap = method.split("/")[1];
        if (!caps[cap]?.listChanged)
          problems.push(`${method} sent without declaring ${cap}.listChanged`);
        break;
      }
      case "notifications/resources/updated":
        if (!caps.resources?.subscribe)
          problems.push(`${method} sent without declaring resources.subscribe`);
        if (typeof params?.uri !== "string")
          problems.push(`${method} needs a uri`);
        break;
      default:
        problems.push(`Unknown notification ${method}`);
    }
  }
  if (!session.notifications.length) return [];
  const unique = [...new Set(problems)];
  return [
    {
      id: "NOTIFICATIONS",
      status: unique.length ? "warn" : "pass",
      actual: unique.length ? unique : session.notifications.length,
      explanation: unique.length
        ? `Unexpected notifications: ${unique[0]}`
        : `${session.notifications.length} notifications, all valid for the declared capabilities`,
      fix: "Only send notifications the spec defines, with the capabilities that enable them",
    },
  ];
}

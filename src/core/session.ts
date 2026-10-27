import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { ObservedStdio, type Diagnostics } from "./transport.js";
import {
  ConnectionError,
  type Options,
  type Inventory,
  type Finding,
} from "./types.js";
import { VERSION } from "./version.js";
export class Session {
  client = new Client(
    { name: "mcpprobe", version: VERSION },
    { capabilities: {} },
  );
  transport!: Transport;
  protocolVersion = "";
  deadline: number;
  findings: Finding[] = [];
  notifications: { method: string; params?: any }[] = [];
  diagnostics: Diagnostics = { stderr: [], stdoutErrors: [] };
  constructor(public options: Options) {
    this.deadline = Date.now() + options.maxDuration;
    this.client.onerror = () => {};
  }
  remaining(): number {
    return Math.max(0, this.deadline - Date.now());
  }
  async bounded<T>(
    fn: (signal: AbortSignal, timeout: number) => Promise<T>,
  ): Promise<T> {
    const timeout = Math.min(this.options.timeout, this.remaining());
    if (timeout <= 0) throw new Error("Global time budget exhausted");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(controller.signal, timeout),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Call timeout or global time budget exhausted"));
          }, timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private makeTransport(legacy: boolean): Transport {
    const t = this.options.target;
    if (t.stdio) {
      const io = new ObservedStdio(t);
      this.diagnostics = io.diagnostics;
      return io;
    }
    const url = new URL(t.http!);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new ConnectionError(
        "HTTP targets require http(s) without embedded credentials",
      );
    const fetchWithHeaders: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [key, value] of Object.entries(t.headers))
        headers.set(key, value);
      return fetch(input, { ...init, headers, redirect: "error" });
    };
    return legacy
      ? new SSEClientTransport(url, {
          requestInit: { headers: t.headers },
          fetch: fetchWithHeaders,
        })
      : new StreamableHTTPClientTransport(url, {
          requestInit: { headers: t.headers },
          fetch: fetchWithHeaders,
        });
  }
  async connect(): Promise<void> {
    const attempt = async (legacy: boolean) => {
      this.transport = this.makeTransport(legacy);
      const original = this.transport.start.bind(this.transport);
      this.transport.start = async () => {
        const handler = this.transport.onmessage;
        this.transport.onmessage = (m, extra) => {
          if (
            "result" in m &&
            m.result &&
            typeof m.result === "object" &&
            "protocolVersion" in m.result
          )
            this.protocolVersion = String(m.result.protocolVersion);
          if ("method" in m && !("id" in m) && this.notifications.length < 1000)
            this.notifications.push({ method: m.method, params: m.params });
          handler?.(m, extra);
        };
        await original();
      };
      await this.bounded((signal, timeout) =>
        this.client.connect(this.transport, { signal, timeout }),
      );
    };
    try {
      await attempt(Boolean(this.options.target.sse));
    } catch (first) {
      await this.close();
      if (
        this.options.target.http &&
        !this.options.target.sse &&
        [404, 405].includes(Number((first as { code?: number }).code))
      ) {
        this.client = new Client({ name: "mcpprobe", version: VERSION });
        this.client.onerror = () => {};
        try {
          await attempt(true);
        } catch {
          await this.close();
          throw new ConnectionError(
            "Could not connect using Streamable HTTP or legacy SSE",
          );
        }
      } else
        throw new ConnectionError(
          first instanceof Error ? first.message : "Could not connect",
        );
    }
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(this.protocolVersion))
      throw new ConnectionError("Unsupported negotiated protocol version");
  }
  async request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<any> {
    const { z } = await import("zod");
    return this.bounded((signal, timeout) =>
      this.client.request({ method, params }, z.looseObject({}), {
        signal,
        timeout,
      }),
    );
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    onprogress?: (progress: {
      progress: number;
      total?: number;
      message?: string;
    }) => void,
  ): Promise<any> {
    return this.bounded((signal, timeout) =>
      this.client.request(
        { method: "tools/call", params: { name, arguments: args } },
        CallToolResultSchema,
        { signal, timeout, ...(onprogress ? { onprogress } : {}) },
      ),
    );
  }
  async inventory(): Promise<Inventory> {
    const capabilities = this.client.getServerCapabilities() ?? {};
    const result: Inventory = {
      server: this.client.getServerVersion(),
      protocolVersion: this.protocolVersion,
      capabilities,
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    };
    for (const [cap, method, key] of [
      ["tools", "tools/list", "tools"],
      ["resources", "resources/list", "resources"],
      ["resources", "resources/templates/list", "resourceTemplates"],
      ["prompts", "prompts/list", "prompts"],
    ] as const) {
      if (!capabilities[cap]) continue;
      try {
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await this.request(
            method,
            cursor === undefined ? {} : { cursor },
          );
          if (
            !Array.isArray(page[key]) ||
            page[key].some(
              (entry: unknown) =>
                !entry || typeof entry !== "object" || Array.isArray(entry),
            )
          )
            throw new Error(`Missing ${key} array`);
          result[key].push(...page[key]);
          cursor = page.nextCursor;
          if (
            cursor !== undefined &&
            (typeof cursor !== "string" || seen.has(cursor))
          )
            throw new Error("Invalid or repeated pagination cursor");
          if (cursor !== undefined) seen.add(cursor);
        } while (cursor !== undefined);
        this.findings.push({
          id: "CAPABILITY_MATCH",
          status: "pass",
          explanation: `${method} succeeded with full pagination`,
          fix: "None",
        });
      } catch (e) {
        this.findings.push({
          id: "CAPABILITY_MATCH",
          status: "fail",
          explanation: `${method}: ${String(e)}`,
          fix: "Implement every declared capability and return valid pagination cursors",
        });
      }
    }
    return result;
  }
  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      /* best-effort transport cleanup */
    }
    try {
      await this.transport?.close();
    } catch {
      /* already closed */
    }
  }
}

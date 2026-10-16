import {
  SUPPORTED_PROTOCOL_VERSIONS,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { ObservedStdio } from "./transport.js";
import type { Finding, Options } from "./types.js";
export async function rawChecks(
  options: Options,
  deadline: number,
): Promise<Finding[]> {
  if (!options.target.stdio)
    return [
      {
        id: "RAW_STDIO",
        status: "skipped",
        explanation:
          "Raw pre-initialization and malformed-frame probes only run over stdio",
        fix: "Use a local stdio target to enable raw-frame checks",
      },
    ];
  const io = new ObservedStdio(options.target);
  const findings: Finding[] = [];
  let current:
    | {
        resolve: (m: any) => void;
        reject: (e: Error) => void;
        id: number | undefined;
      }
    | undefined;
  io.onerror = () => {};
  io.onmessage = (m: JSONRPCMessage) => {
    if (
      current &&
      (("id" in m && m.id === current.id) || ("error" in m && !("id" in m)))
    ) {
      current.resolve(m);
      current = undefined;
    }
  };
  io.onclose = () => {
    current?.reject(new Error("Raw probe server exited"));
    current = undefined;
  };
  let id = 0;
  const exchange = async (frame: string, requestId?: number): Promise<any> => {
    const timeout = Math.min(options.timeout, deadline - Date.now());
    if (timeout <= 0) throw new Error("Global time budget exhausted");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        current = { resolve, reject, id: requestId };
        timer = setTimeout(() => {
          current = undefined;
          reject(new Error("Raw probe timeout"));
        }, timeout);
        io.raw(frame).catch(reject);
      });
    } finally {
      clearTimeout(timer);
      current = undefined;
    }
  };
  const rpc = (method: string, params: unknown = {}) => {
    const next = ++id;
    return exchange(
      JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n",
      next,
    );
  };
  const probe = async (
    checkId: string,
    action: () => Promise<boolean>,
    expected: string,
  ) => {
    try {
      const ok = await action();
      findings.push({
        id: checkId,
        status: ok ? "pass" : "fail",
        explanation: ok ? expected : `Server did not satisfy: ${expected}`,
        expected,
        fix: "Return a JSON-RPC error for invalid requests and keep the session alive",
      });
    } catch (e) {
      findings.push({
        id: checkId,
        status: "fail",
        explanation: String(e),
        expected,
        fix: "Reject invalid requests promptly without exiting or hanging",
      });
    }
  };
  try {
    await io.start();
    await probe(
      "PREINITIALIZE",
      async () => {
        const r = await rpc("ping");
        return Boolean(
          r.result || (r.error && typeof r.error.code === "number"),
        );
      },
      "Requests before initialization are handled without crash or hang",
    );
    const init = await rpc("initialize", {
      protocolVersion: "1900-01-01",
      capabilities: {},
      clientInfo: { name: "mcpprobe-raw", version: "0.1.0" },
    });
    if (!init.result) throw new Error("Raw probe initialization failed");
    findings.push({
      id: "PROTOCOL_NEGOTIATION",
      status: SUPPORTED_PROTOCOL_VERSIONS.includes(init.result.protocolVersion)
        ? "pass"
        : "fail",
      actual: init.result.protocolVersion,
      expected:
        "A supported alternative when the requested version is unsupported",
      explanation: "Negotiation with an unsupported requested revision",
      fix: "Select a supported protocol revision rather than echoing an unsupported version",
    });
    await io.raw(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    await probe(
      "UNKNOWN_METHOD",
      async () => (await rpc("mcpprobe/unknown")).error?.code === -32601,
      "Unknown method returns -32601",
    );
    await probe(
      "MALFORMED_JSONRPC",
      async () => {
        const response = await exchange("{not json}\n");
        return (
          [-32700, -32600].includes(response.error?.code) &&
          Boolean((await rpc("ping")).result)
        );
      },
      "Malformed JSON gets a parse/invalid-request error and server remains alive",
    );
    await probe(
      "WRONG_PARAMS",
      async () => {
        const r = await rpc("tools/list", { cursor: 123 });
        return (
          [-32602, -32600].includes(r.error?.code) &&
          Boolean((await rpc("ping")).result)
        );
      },
      "Wrong parameter types return an invalid-params error and server remains alive",
    );
  } catch (e) {
    findings.push({
      id: "RAW_STDIO",
      status: "fail",
      explanation: String(e),
      fix: "Handle lifecycle requests correctly",
    });
  } finally {
    await io.close();
  }
  return findings;
}

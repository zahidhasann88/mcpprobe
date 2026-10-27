import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { Finding, Options } from "./types.js";
import { VERSION } from "./version.js";
const credentialHeader = /authorization|token|api[-_]?key|cookie|auth/i;
const localHost = /^(?:localhost|127(?:\.\d+){3}|\[::1\])$/i;
export async function httpChecks(
  options: Options,
  deadline: number,
): Promise<Finding[]> {
  const { http, sse, headers } = options.target;
  if (!http || sse)
    return [
      {
        id: "HTTP_SECURITY",
        status: "skipped",
        explanation:
          "HTTP security probes only run against Streamable HTTP targets",
        fix: "Use --http without --sse to enable them",
      },
    ];
  const findings: Finding[] = [];
  const sessions: string[] = [];
  const post = async (
    body: unknown,
    extra: Record<string, string> = {},
    withCredentials = true,
  ) => {
    const timeout = Math.min(options.timeout, deadline - Date.now());
    if (timeout <= 0) throw new Error("Global time budget exhausted");
    const response = await fetch(http, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(withCredentials ? headers : {}),
        ...extra,
      },
      body: JSON.stringify(body),
    });
    const session = response.headers.get("mcp-session-id");
    if (response.ok && session && !sessions.includes(session))
      sessions.push(session);
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, session };
  };
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcpprobe", version: VERSION },
    },
  };
  const ping = { jsonrpc: "2.0", id: 2, method: "ping" };
  const probe = async (
    id: string,
    action: () => Promise<Omit<Finding, "id">>,
  ) => {
    try {
      findings.push({ id, ...(await action()) });
    } catch (e) {
      findings.push({
        id,
        status: "warn",
        explanation: `Could not run probe: ${e instanceof Error ? e.message : String(e)}`,
        fix: "Check that the endpoint is reachable within --timeout",
      });
    }
  };
  try {
    await probe("HTTP_ORIGIN", async () => {
      const { status } = await post(initialize, {
        Origin: "https://mcpprobe-untrusted.example",
      });
      const local = localHost.test(new URL(http).hostname);
      return status === 403
        ? {
            status: "pass",
            explanation: "Rejected an untrusted Origin with 403",
            fix: "None",
          }
        : {
            status: status < 300 && local ? "fail" : "warn",
            actual: status,
            expected: "HTTP 403 for an untrusted Origin header",
            explanation:
              status < 300
                ? `Accepted a request from an untrusted Origin (HTTP ${status})`
                : `Untrusted Origin returned HTTP ${status} instead of 403`,
            fix: "Validate the Origin header and respond 403 to untrusted origins to prevent DNS rebinding",
          };
    });
    if (Object.keys(headers).some((h) => credentialHeader.test(h)))
      await probe("HTTP_AUTH", async () => {
        const { status } = await post(initialize, {}, false);
        return status === 401 || status === 403
          ? {
              status: "pass",
              explanation: `Rejected a request without credentials (HTTP ${status})`,
              fix: "None",
            }
          : {
              status: "warn",
              actual: status,
              expected: "HTTP 401 or 403 without the configured credentials",
              explanation: `Request without the configured credentials returned HTTP ${status}`,
              fix: "Require authentication on every request if the server is not meant to be public",
            };
      });
    const init = await post(initialize);
    if (init.status >= 300)
      throw new Error(`initialize returned HTTP ${init.status}`);
    const session = init.session;
    const sessionHeader: Record<string, string> = session
      ? { "Mcp-Session-Id": session }
      : {};
    const versionHeader = { "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION };
    await post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { ...sessionHeader, ...versionHeader },
    );
    if (session) {
      await probe("HTTP_SESSION", async () => {
        const visible = /^[\x21-\x7E]+$/.test(session);
        return visible
          ? {
              status: "pass",
              explanation: "Session ID uses only visible ASCII characters",
              fix: "None",
            }
          : {
              status: "fail",
              actual: session,
              expected: "Visible ASCII characters (0x21 to 0x7E)",
              explanation:
                "Session ID contains characters outside visible ASCII",
              fix: "Generate session IDs from visible ASCII, such as a UUID",
            };
      });
      await probe("HTTP_SESSION", async () => {
        const { status } = await post(ping, {
          "Mcp-Session-Id": "mcpprobe-unknown-session",
          ...versionHeader,
        });
        return status === 404
          ? {
              status: "pass",
              explanation: "Unknown session ID returned 404",
              fix: "None",
            }
          : {
              status: "fail",
              actual: status,
              expected: "HTTP 404 for an unknown session ID",
              explanation: `Unknown session ID returned HTTP ${status} instead of 404`,
              fix: "Respond 404 to requests with an unknown or expired Mcp-Session-Id",
            };
      });
      await probe("HTTP_SESSION", async () => {
        const { status } = await post(ping, versionHeader);
        return status === 400
          ? {
              status: "pass",
              explanation: "Request without a session ID returned 400",
              fix: "None",
            }
          : {
              status: "warn",
              actual: status,
              expected: "HTTP 400 when the session ID is missing",
              explanation: `Request without a session ID returned HTTP ${status} instead of 400`,
              fix: "Respond 400 to non-initialize requests that omit Mcp-Session-Id",
            };
      });
    }
    await probe("HTTP_PROTOCOL_VERSION", async () => {
      const { status } = await post(ping, {
        ...sessionHeader,
        "MCP-Protocol-Version": "1900-01-01",
      });
      return status === 400
        ? {
            status: "pass",
            explanation: "Unsupported MCP-Protocol-Version returned 400",
            fix: "None",
          }
        : {
            status: "fail",
            actual: status,
            expected: "HTTP 400 for an unsupported MCP-Protocol-Version header",
            explanation: `Unsupported MCP-Protocol-Version returned HTTP ${status} instead of 400`,
            fix: "Validate the MCP-Protocol-Version header and respond 400 to unsupported versions",
          };
    });
  } catch (e) {
    findings.push({
      id: "HTTP_SECURITY",
      status: "warn",
      explanation: `HTTP probes stopped: ${e instanceof Error ? e.message : String(e)}`,
      fix: "Check that the endpoint accepts initialize with the configured headers",
    });
  } finally {
    for (const id of sessions)
      await fetch(http, {
        method: "DELETE",
        redirect: "error",
        signal: AbortSignal.timeout(2000),
        headers: {
          ...headers,
          "Mcp-Session-Id": id,
          "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION,
        },
      })
        .then((r) => r.body?.cancel())
        .catch(() => undefined);
  }
  return findings;
}

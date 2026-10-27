import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createFixtureServer } from "./server.js";
const mode = process.argv[2] ?? "http";
const sessions = new Map<string, StreamableHTTPServerTransport>();
let legacy: SSEServerTransport | undefined;
const http = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== "Bearer integration-secret") {
      res.writeHead(401).end();
      return;
    }
    if (mode !== "sse" && req.url === "/mcp") {
      const id = req.headers["mcp-session-id"];
      let transport = typeof id === "string" ? sessions.get(id) : undefined;
      if (id && !transport) {
        res.writeHead(404).end();
        return;
      }
      if (!transport) {
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (sid) => void sessions.set(sid, created),
          enableDnsRebindingProtection: mode === "secure",
          allowedOrigins: ["http://127.0.0.1"],
        });
        await createFixtureServer().connect(created);
        transport = created;
      }
      await transport.handleRequest(req, res);
      return;
    }
    if (mode === "sse" && req.url === "/sse" && req.method === "GET") {
      legacy = new SSEServerTransport("/messages", res);
      await createFixtureServer().connect(legacy);
      return;
    }
    if (mode === "sse" && req.url?.startsWith("/messages")) {
      await legacy?.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404).end();
  } catch {
    if (!res.headersSent) res.writeHead(500).end();
  }
});
http.listen(0, "127.0.0.1", () =>
  process.stdout.write(JSON.stringify(http.address()) + "\n"),
);

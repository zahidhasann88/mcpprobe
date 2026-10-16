import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createFixtureServer } from "./server.js";
const mode = process.argv[2] ?? "http";
const server = createFixtureServer();
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: randomUUID,
});
let legacy: SSEServerTransport | undefined;
if (mode === "http") await server.connect(transport);
const http = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== "Bearer integration-secret") {
      res.writeHead(401).end();
      return;
    }
    if (mode === "http" && req.url === "/mcp") {
      await transport.handleRequest(req, res);
      return;
    }
    if (mode === "sse" && req.url === "/sse" && req.method === "GET") {
      legacy = new SSEServerTransport("/messages", res);
      await server.connect(legacy);
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

import { describe, it, expect } from "vitest";
import { resolveOptions, Session } from "../src/core/index.js";
export const target = (mode = "healthy") =>
  `"${process.execPath}" --import tsx test/fixtures/servers/server.ts ${mode}`;
describe("phase 1: connection and inspection", () => {
  it("negotiates supported revision and follows all pages", async () => {
    const s = new Session(resolveOptions({}, { stdio: target() }));
    try {
      await s.connect();
      const data = await s.inventory();
      expect(data.protocolVersion).toBe("2025-11-25");
      expect(data.tools).toHaveLength(2);
      expect(data.resources).toHaveLength(2);
      expect(data.resourceTemplates).toHaveLength(2);
      expect(data.prompts).toHaveLength(2);
      expect(s.findings.every((f) => f.status === "pass")).toBe(true);
    } finally {
      await s.close();
    }
  });
  it("flags override target and global config without losing headers", () => {
    const o = resolveOptions(
      {
        http: "https://example.com/mcp",
        timeout: 20,
        headers: { A: "${TOKEN}" },
        targets: { local: { stdio: target(), timeout: 30 } },
      },
      { target: "local", stdio: target(), timeout: 40 },
      { TOKEN: "secret-token" },
    );
    expect(o.timeout).toBe(40);
    expect(o.target.http).toBeUndefined();
    expect(o.target.headers.A).toBe("secret-token");
  });
});

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  resolveOptions,
  inspect,
  testServer,
  formatReport,
  loadConfig,
  fuzz,
} from "../src/core/index.js";
const target = (mode = "healthy") =>
  `"${process.execPath}" --import tsx test/fixtures/servers/server.ts ${mode}`;
const cli = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/cli/index.ts", ...args],
        { env: { ...process.env, ...env } },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
describe("phase 4: integration and reporting", () => {
  it.each(["http", "sse", "fallback"])(
    "connects with headers over %s",
    async (mode) => {
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        "test/fixtures/servers/http.ts",
        mode === "fallback" ? "sse" : mode,
      ]);
      const address = await new Promise<{ port: number }>((resolve, reject) => {
        child.stdout.once("data", (d) => resolve(JSON.parse(d.toString())));
        child.once("error", reject);
        child.once("exit", () => reject(new Error("HTTP fixture exited")));
      });
      try {
        const o = resolveOptions(
          {},
          {
            http: `http://127.0.0.1:${address.port}/${mode === "http" ? "mcp" : "sse"}`,
            sse: mode === "sse",
            headers: { Authorization: "Bearer integration-secret" },
          },
        );
        const r = await inspect(o);
        expect(r.exitCode).toBe(0);
        expect(r.inventory?.tools).toHaveLength(2);
        expect(JSON.stringify(r)).not.toContain("integration-secret");
      } finally {
        child.kill();
        await once(child, "exit");
      }
    },
    15000,
  );
  it("renders JSON, JUnit, Markdown, SARIF with details and no secrets", async () => {
    const r = await testServer(
      resolveOptions(
        {},
        { stdio: target("output"), env: { API_TOKEN: "private-value" } },
      ),
    );
    for (const format of [
      "console",
      "json",
      "junit",
      "markdown",
      "sarif",
    ] as const) {
      const text = formatReport(r, format);
      expect(text).not.toContain("private-value");
      expect(text).toContain("OUTPUT_SCHEMA");
      expect(text).toContain("424242");
    }
    const junit = formatReport(r, "junit");
    expect(junit).toContain("<failure");
    expect(junit).toContain("&quot;");
    expect(JSON.parse(formatReport(r, "sarif")).version).toBe("2.1.0");
    expect(
      r.findings
        .filter((f) => f.status === "fail")
        .every(
          (f) => f.expected && f.actual !== undefined && f.input !== undefined,
        ),
    ).toBe(true);
    expect(
      r.findings
        .filter((f) => f.status === "fail" && f.tool)
        .every((f) => f.reproduction?.startsWith("mcpprobe call")),
    ).toBe(true);
  }, 15000);
  it("CLI exit codes 0, 1, 2, 3 and strict warnings", async () => {
    const base = ["--stdio", target()];
    expect((await cli(["inspect", ...base, "--json"])).code).toBe(0);
    expect(
      (await cli(["test", "--stdio", target("schema"), "--format", "json"]))
        .code,
    ).toBe(1);
    expect((await cli(["inspect"])).code).toBe(2);
    expect(
      (await cli(["inspect", "--stdio", "/nonexistent-mcpprobe-command"])).code,
    ).toBe(3);
    expect((await cli(["test", ...base, "--strict"])).code).toBe(1);
    const unsafe = await cli(["test", ...base, "--allow-unsafe"]);
    expect(unsafe.code).toBe(2);
    expect(unsafe.stderr).toContain("WARNING");
    expect(unsafe.stderr).toContain("--yes");
  }, 60000);
  it("writes JUnit, validates config and preserves flags > target > defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcpprobe-config-"));
    try {
      const file = join(dir, "config.yaml");
      const out = join(dir, "report.xml");
      await writeFile(
        file,
        `http: https://example.com/mcp\ntimeout: 9\nheaders:\n  Authorization: Bearer \u0024{TOKEN}\ntargets:\n  local:\n    stdio: '${target()}'\n    timeout: 2000\n`,
      );
      const config = await loadConfig(file);
      const o = resolveOptions(
        config,
        { target: "local", timeout: 4000 },
        { TOKEN: "hidden-ci-token" },
      );
      expect(o.target.http).toBeUndefined();
      expect(o.timeout).toBe(4000);
      const r = await cli(
        [
          "inspect",
          "--config",
          file,
          "--target",
          "local",
          "--format",
          "junit",
          "--out",
          out,
        ],
        { TOKEN: "hidden-ci-token" },
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(await readFile(out, "utf8")).toContain("<testsuites>");
      expect(await readFile(out, "utf8")).not.toContain("hidden-ci-token");
      await writeFile(file, "timeout: nope");
      await expect(loadConfig(file)).rejects.toThrow("Invalid configuration");
    } finally {
      await rm(dir, { recursive: true });
    }
  }, 15000);
  it("all CLI execution commands work, and manual call is raw JSON", async () => {
    const common = ["--stdio", target(), "--tool", "echo_text"];
    const call = await cli(["call", ...common, "--args", '{"text":"hello"}']);
    expect(call.code).toBe(0);
    expect(JSON.parse(call.stdout).content[0].text).toBe("hello");
    const f = await cli(["fuzz", ...common, "--runs", "5", "--json"]);
    expect(f.code).toBe(0);
    expect(JSON.parse(f.stdout).seed).toBe(424242);
    const b = await cli([
      "bench",
      ...common,
      "--iterations",
      "3",
      "--concurrency",
      "2",
      "--json",
    ]);
    expect(b.code).toBe(0);
    expect(JSON.parse(b.stdout).benchmarks[0].calls).toBe(3);
    const invalid = await cli(["call", ...common, "--args", "not-json-secret"]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).not.toContain("not-json-secret");
  }, 45000);
  it("genuinely shrinks a nontrivial failure", async () => {
    const r = await fuzz(
      resolveOptions(
        {},
        {
          stdio: target("shrink"),
          tool: "echo_text",
          runs: 100,
          maxDuration: 10000,
        },
      ),
    );
    const f = r.findings.find((f) => f.id === "FUZZ_FAILURE");
    expect(f).toBeDefined();
    expect((f?.input as any).text.length).toBe(3);
    expect((f?.actual as any).numShrinks).toBeGreaterThan(0);
  }, 15000);
  it("server-emitted credentials are detected and never printed by CLI or reports", async () => {
    const secret = 'test-private-token-with-quotes-"-and-newline\nvalue';
    const o = resolveOptions(
      {},
      { stdio: target("leak"), env: { API_TOKEN: secret } },
    );
    const r = await testServer(o);
    expect(
      r.findings.some((f) => f.id === "ERROR_LEAK" && f.status === "fail"),
    ).toBe(true);
    for (const format of [
      "console",
      "json",
      "junit",
      "markdown",
      "sarif",
    ] as const) {
      expect(formatReport(r, format)).not.toContain("test-private-token");
    }
    const c = await cli([
      "call",
      "echo_text",
      "--stdio",
      target("leak"),
      "--env",
      `API_TOKEN=${secret}`,
      "--args",
      '{"text":"hello"}',
    ]);
    expect(c.code).toBe(0);
    expect(c.stdout).toContain("[REDACTED]");
    expect(c.stdout + c.stderr).not.toContain("test-private-token");
  }, 15000);
});

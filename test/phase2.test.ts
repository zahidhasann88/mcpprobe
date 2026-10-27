import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveOptions,
  testServer,
  generateInputs,
  safetyDecision,
  redact,
  Session,
  diagnosticFindings,
  requireConsent,
} from "../src/core/index.js";
const target = (mode = "healthy") =>
  `"${process.execPath}" --import tsx test/fixtures/servers/server.ts ${mode}`;
const options = (mode: string, extra: Record<string, unknown> = {}) =>
  resolveOptions(
    {},
    { stdio: target(mode), timeout: 2500, maxDuration: 15000, ...extra },
  );
describe("phase 2: safety and checks", () => {
  it("healthy server yields zero failures", async () => {
    const r = await testServer(options("healthy"));
    expect(r.findings.filter((f) => f.status === "fail")).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(
      r.findings.some(
        (f) => f.id === "MALFORMED_JSONRPC" && f.status === "pass",
      ),
    ).toBe(true);
  }, 20000);
  it.each([
    ["stdout", "STDOUT_PURITY"],
    ["throws", "INVALID_INPUT"],
    ["schema", "INPUT_SCHEMA"],
    ["output", "OUTPUT_SCHEMA"],
  ])(
    "detects %s as %s",
    async (mode, id) => {
      const r = await testServer(options(mode));
      expect(r.findings.some((f) => f.id === id && f.status === "fail")).toBe(
        true,
      );
      expect(r.exitCode).toBe(1);
    },
    20000,
  );
  it("reports slow calls and timeouts", async () => {
    const r = await testServer(
      // The timeout also bounds connect, so leave room for a cold server start;
      // it must stay below the fixture's 2400 ms delay so the call still times out.
      options("slow", {
        timeout: 2000,
        maxDuration: 6000,
        latencyBudget: 20,
        tool: "echo_text",
      }),
    );
    expect(
      r.findings.some((f) => f.id === "CALL_TIMEOUT" && f.status === "fail"),
    ).toBe(true);
    expect(r.findings.some((f) => f.id === "TOOL_LATENCY")).toBe(true);
  }, 10000);
  it("captures crash code and last stderr", async () => {
    const s = new Session(options("crash"));
    try {
      await s.connect();
      await expect(s.call("echo_text", { text: "CRASH" })).rejects.toThrow();
      const f = diagnosticFindings(s).find((f) => f.id === "PROCESS_EXIT");
      expect(f?.actual).toMatchObject({ code: 17, signal: null });
      expect(JSON.stringify(f)).toContain("crashing fixture");
    } finally {
      await s.close();
    }
  });
  it("crash fixture is discovered by generated hostile probe", async () => {
    const r = await testServer(options("crash"));
    expect(r.findings.some((f) => f.id === "PROCESS_EXIT")).toBe(true);
  }, 20000);
  it("never invokes destructive-annotated tool by default, even readOnly + allowlisted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcpprobe-"));
    const counter = join(dir, "count");
    try {
      const r = await testServer(
        options("destructive", {
          env: { COUNTER_FILE: counter },
          allowTool: ["echo_text"],
        }),
      );
      expect(
        r.findings.some(
          (f) => f.id === "SAFETY_SKIP" && f.tool === "echo_text",
        ),
      ).toBe(true);
      expect(await readFile(counter, "utf8")).not.toContain("echo_text");
    } finally {
      await rm(dir, { recursive: true });
    }
  }, 20000);
  it("applies independent unsafe and destructive gates and deny wins", () => {
    const base = options("healthy");
    const tool = { name: "x", inputSchema: { type: "object" as const } };
    expect(safetyDecision(tool, base).allowed).toBe(false);
    expect(safetyDecision(tool, { ...base, allowUnsafe: true }).allowed).toBe(
      true,
    );
    expect(
      safetyDecision(
        { ...tool, annotations: { destructiveHint: true } },
        { ...base, allowUnsafe: true },
      ).allowed,
    ).toBe(false);
    expect(
      safetyDecision(
        { ...tool, annotations: { destructiveHint: true } },
        { ...base, allowDestructive: true },
      ).allowed,
    ).toBe(true);
    expect(
      safetyDecision(tool, { ...base, allowTool: ["x"], denyTool: ["x"] })
        .allowed,
    ).toBe(false);
    expect(() => requireConsent({ ...base, allowUnsafe: true })).toThrow(
      "--yes",
    );
  });
  it("deterministic generator and recursive redaction", () => {
    const schema = {
      type: "object",
      properties: {
        s: { type: "string", minLength: 2, maxLength: 10 },
        n: { type: "integer", minimum: 2, maximum: 5 },
      },
      required: ["s", "n"],
      additionalProperties: false,
    };
    expect(generateInputs(schema, 12)).toEqual(generateInputs(schema, 12));
    expect(
      JSON.stringify(
        redact({ input: 'abc\n"secret', actual: ['abc\n"secret'] }, [
          'abc\n"secret',
        ]),
      ),
    ).not.toContain("secret");
  });
  it("unannotated tools are skipped unless explicitly permitted", async () => {
    const r = await testServer(options("unannotated"));
    expect(
      r.findings.some((f) => f.id === "SAFETY_SKIP" && f.tool === "echo_text"),
    ).toBe(true);
    expect(
      r.findings.some((f) => f.id === "VALID_INPUT" && f.tool === "echo_text"),
    ).toBe(false);
    const allowed = await testServer(
      options("unannotated", { allowTool: ["echo_text"] }),
    );
    expect(
      allowed.findings.some(
        (f) => f.id === "VALID_INPUT" && f.tool === "echo_text",
      ),
    ).toBe(true);
  }, 15000);
});

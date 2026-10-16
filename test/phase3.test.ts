import { describe, it, expect } from "vitest";
import {
  fuzz,
  bench,
  callTool,
  resolveOptions,
  percentile,
} from "../src/core/index.js";
const options = (mode = "healthy", more: Record<string, unknown> = {}) =>
  resolveOptions(
    {},
    {
      stdio: `"${process.execPath}" --import tsx test/fixtures/servers/server.ts ${mode}`,
      timeout: 2500,
      maxDuration: 10000,
      tool: "echo_text",
      runs: 25,
      iterations: 12,
      concurrency: 3,
      ...more,
    },
  );
describe("phase 3: fuzz and bench", () => {
  it("healthy fuzz input handling passes", async () => {
    const r = await fuzz(options());
    expect(r.summary.fail).toBe(0);
    expect(r.findings.some((f) => f.id === "FUZZ_RUNS")).toBe(true);
  }, 15000);
  it("shrinks failures, preserves check IDs, and repeats seeds", async () => {
    const a = await fuzz(options("throws"));
    const b = await fuzz(options("throws"));
    const af = a.findings.find((f) => f.id === "FUZZ_FAILURE");
    const bf = b.findings.find((f) => f.id === "FUZZ_FAILURE");
    expect(af?.input).toEqual({});
    expect(af?.input).toEqual(bf?.input);
    expect(
      a.findings.some((f) => f.id === "INVALID_INPUT" && f.status === "fail"),
    ).toBe(true);
  }, 25000);
  it("measures benchmark percentiles, throughput, and error rate", async () => {
    const r = await bench(options());
    expect(r.summary.fail).toBe(0);
    const b = r.benchmarks![0];
    expect(b.calls).toBe(12);
    expect(b.errors).toBe(0);
    expect(b.p99).toBeGreaterThanOrEqual(b.p50);
    expect(b.throughput).toBeGreaterThan(0);
    expect(percentile([1, 2, 3, 4, 5], 0.9)).toBe(5);
  }, 15000);
  it.each(["fuzz", "bench", "call"])(
    "safety gate applies to %s",
    async (mode) => {
      const o = options("destructive");
      const r =
        mode === "fuzz"
          ? await fuzz(o)
          : mode === "bench"
            ? await bench(o)
            : (await callTool(o, "echo_text", { text: "safe?" })).report;
      expect(r.findings.some((f) => f.id === "SAFETY_SKIP")).toBe(true);
      expect(r.findings.some((f) => f.id === "MANUAL_CALL")).toBe(false);
    },
    15000,
  );
  it("manual call returns a raw SDK result", async () => {
    const r = await callTool(options(), "echo_text", { text: "hi" });
    expect(r.result).toEqual({ content: [{ type: "text", text: "hi" }] });
  });
});

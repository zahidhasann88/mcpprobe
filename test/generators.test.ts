import { describe, it, expect } from "vitest";
import {
  generateInputs,
  validSamples,
  validator,
  resolveOptions,
  redact,
  commandParts,
} from "../src/core/index.js";
describe("generators and hardening", () => {
  it("honors formats, enum and numeric limits, with reproducible dates", () => {
    const schema = {
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        date: { type: "string", format: "date-time" },
        n: { type: "integer", minimum: 3, maximum: 6 },
        e: { enum: ["a", "b"] },
      },
      required: ["email", "date", "n", "e"],
      additionalProperties: false,
    };
    const a = validSamples(schema, 123, 5);
    const b = validSamples(schema, 123, 5);
    expect(a).toHaveLength(5);
    expect(a).toEqual(b);
    expect(a.every((v) => validator(schema)(v))).toBe(true);
  });
  it("mutates nested required fields and distinguishes invalid samples", () => {
    const schema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { n: { type: "integer", minimum: 1, maximum: 3 } },
          required: ["n"],
        },
      },
      required: ["nested"],
    };
    const samples = generateInputs(schema, 123);
    expect(
      samples.some((s) => s.kind === "nested-missing-required" && !s.valid),
    ).toBe(true);
    expect(
      samples.every((s) => s.valid === Boolean(validator(schema)(s.input))),
    ).toBe(true);
  });
  it("validates draft 2020-12 output shapes", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
      unevaluatedProperties: false,
    };
    expect(validator(schema)({ n: 1 })).toBe(true);
    expect(validator(schema)({ n: 1, x: 2 })).toBe(false);
  });
  it("masks URL query credentials and literal credential flags", () => {
    const o = resolveOptions(
      {},
      { http: "https://example.com/mcp?token=hidden-query" },
    );
    expect(redact(o.target.http, o.secrets)).not.toContain("hidden-query");
    const s = resolveOptions(
      {},
      { stdio: "node server.js --token literal-secret" },
    );
    expect(redact(s.target.stdio, s.secrets)).not.toContain("literal-secret");
  });
  it("does not execute shell operators", () => {
    expect(() => commandParts("node server.js | sh")).toThrow();
    expect(commandParts('node "space in file.js" --flag')).toEqual([
      "node",
      "space in file.js",
      "--flag",
    ]);
  });
});

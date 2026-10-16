import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv2019 } from "ajv/dist/2019.js";
import addFormats from "ajv-formats";
import jsf from "json-schema-faker";
export type Input = Record<string, unknown>;
export interface Sample {
  input: Input;
  valid: boolean;
  kind: string;
}
export function validator(schema: any) {
  const Ctor = String(schema?.$schema).includes("2020-12")
    ? Ajv2020
    : String(schema?.$schema).includes("2019-09")
      ? Ajv2019
      : Ajv;
  const ajv = new Ctor({
    strict: false,
    logger: false,
    allErrors: true,
    validateFormats: true,
  });
  (addFormats as unknown as (a: Ajv) => void)(ajv);
  if (!ajv.validateSchema(schema)) throw new Error(ajv.errorsText());
  return ajv.compile(schema);
}
export function random(seed: number): () => number {
  let x = seed | 0;
  return () => {
    x += 0x6d2b79f5;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function validSamples(schema: any, seed: number, count = 3): Input[] {
  const validate = validator(schema);
  const rng = random(seed);
  const result: Input[] = [];
  const getOption = jsf.option as unknown as (key: string) => unknown;
  const keys = [
    "random",
    "alwaysFakeOptionals",
    "maxLength",
    "maxItems",
    "failOnInvalidFormat",
    "minDateTime",
    "maxDateTime",
  ];
  const previous = Object.fromEntries(keys.map((k) => [k, getOption(k)]));
  try {
    jsf.option({
      random: rng,
      alwaysFakeOptionals: true,
      maxLength: 64,
      maxItems: 5,
      failOnInvalidFormat: true,
      minDateTime: "2020-01-01T00:00:00.000Z",
      maxDateTime: "2030-01-01T00:00:00.000Z",
    });
    for (
      let attempt = 0;
      attempt < Math.max(20, count * 10) && result.length < count;
      attempt++
    ) {
      try {
        const value = jsf.generate(schema) as Input;
        if (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          validate(value)
        )
          result.push(value);
      } catch {
        /* unsupported schema/format will be reported as generation warning */
      }
    }
  } finally {
    jsf.option(previous);
  }
  return result;
}
export const hostileStrings = [
  "x".repeat(16384),
  "🌍 café e\u0301 中文 العربية \u202eRTL",
  "\0",
  "\u0001\n\r\t",
  "../../etc/passwd",
  "'; DROP TABLE examples; --",
  "$(echo inert); | & `id`",
  "CRASH",
];
export function generateInputs(schema: any, seed: number, depth = 0): Sample[] {
  const validate = validator(schema);
  const valid = validSamples(schema, seed);
  const samples: Sample[] = valid.map((input) => ({
    input,
    valid: true,
    kind: "valid",
  }));
  const base = valid[0];
  if (!base) return samples;
  const push = (input: Input, kind: string) =>
    samples.push({ input, valid: Boolean(validate(input)), kind });
  for (const key of schema.required ?? []) {
    const input = { ...base };
    delete input[key];
    push(input, "missing-required");
  }
  if (schema.additionalProperties === false)
    push({ ...base, __mcpprobe_extra: true }, "extra-property");
  for (const [key, spec] of Object.entries<any>(schema.properties ?? {})) {
    const candidates: unknown[] = [
      null,
      true,
      0,
      -1,
      1e100,
      "",
      [],
      {},
      ["wrong-type"],
      ...hostileStrings,
    ];
    for (const n of [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
    ] as const)
      if (typeof spec[n] === "number")
        candidates.push(spec[n] - 1, spec[n], spec[n] + 1);
    for (const n of ["minLength", "maxLength"] as const)
      if (typeof spec[n] === "number")
        for (const length of [spec[n] - 1, spec[n], spec[n] + 1])
          if (length >= 0 && length <= 65536)
            candidates.push("x".repeat(length));
    for (const n of ["minItems", "maxItems"] as const)
      if (typeof spec[n] === "number")
        for (const length of [spec[n] - 1, spec[n], spec[n] + 1])
          if (length >= 0 && length <= 256)
            candidates.push(
              Array.from({ length }, () =>
                base[key] instanceof Array ? (base[key] as unknown[])[0] : null,
              ),
            );
    let nested: unknown = "leaf";
    for (let d = 0; d < 40; d++) nested = { child: nested };
    candidates.push(nested);
    for (const value of candidates)
      push({ ...base, [key]: value }, "boundary-or-hostile");
    if (depth < 3 && spec.type === "object") {
      for (const child of generateInputs(spec, seed, depth + 1))
        push({ ...base, [key]: child.input }, `nested-${child.kind}`);
    }
    if (
      depth < 3 &&
      spec.type === "array" &&
      spec.items?.type === "object" &&
      Array.isArray(base[key]) &&
      (base[key] as unknown[]).length
    ) {
      for (const child of generateInputs(spec.items, seed, depth + 1))
        push(
          {
            ...base,
            [key]: [child.input, ...(base[key] as unknown[]).slice(1)],
          },
          `array-item-${child.kind}`,
        );
    }
  }
  const seen = new Set<string>();
  return samples.filter((s) => {
    const key = JSON.stringify(s.input);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

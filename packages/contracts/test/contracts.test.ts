import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { validate } from "../src/validate.ts";
import type { Schema } from "../src/validate.ts";

const dir = new URL("../schemas/", import.meta.url);
const schema = (name: string) => JSON.parse(readFileSync(new URL(`${name}.schema.json`, dir), "utf8")) as Schema;

test("every schema file uses only keywords the validator enforces", () => {
  for (const file of readdirSync(dir)) {
    assert.doesNotThrow(() => validate(schema(file.replace(".schema.json", "")), {}), file);
  }
});

test("validator: types, required, enums, patterns, bounds, nesting", () => {
  const s: Schema = {
    type: "object",
    required: ["a"],
    additionalProperties: false,
    properties: { a: { type: "integer", minimum: 1 }, b: { enum: ["x", "y"] }, c: { type: "array", items: { type: "string", pattern: "^z" } } },
  };
  assert.deepEqual(validate(s, { a: 2, b: "x", c: ["zz"] }), []);
  assert.ok(validate(s, {}).some((e) => e.includes('missing required "a"')));
  assert.ok(validate(s, { a: 0 }).some((e) => e.includes("below 1")));
  assert.ok(validate(s, { a: 1.5 }).some((e) => e.includes("expected integer")));
  assert.ok(validate(s, { a: 1, b: "q" }).some((e) => e.includes("must be one of")));
  assert.ok(validate(s, { a: 1, c: ["nope"] }).some((e) => e.includes("$.c[0]")));
  assert.ok(validate(s, { a: 1, extra: true }).some((e) => e.includes('unexpected property "extra"')));
});

test("validator refuses schema keywords it does not enforce", () => {
  assert.throws(() => validate({ type: "string", format: "email" }, "a@b.c"), /Unsupported schema keyword "format"/);
});

test("datum schema accepts a real provider datum and rejects a bad licence class or negative delay", () => {
  const good = { provider: "ecb", url: "https://x", asOf: "2026-09-29", retrievedAt: "2026-09-30T03:40:00.000Z", licenceClass: "public", delayedBySeconds: 0, payload: { a: 1 } };
  assert.deepEqual(validate(schema("datum"), good), []);
  assert.ok(validate(schema("datum"), { ...good, licenceClass: "free-for-all" }).length > 0);
  assert.ok(validate(schema("datum"), { ...good, delayedBySeconds: -1 }).length > 0);
  assert.ok(validate(schema("datum"), { ...good, retrievedAt: "yesterday" }).length > 0);
});

test("claim schema requires at least one link", () => {
  const link = { sourceId: "s", kind: "field", fieldOrQuote: "latest.value", value: 1.1 };
  const claim = { text: "t", kind: "fact", producedBy: "p", runId: "r", links: [link] };
  assert.deepEqual(validate(schema("claim"), claim), []);
  assert.ok(validate(schema("claim"), { ...claim, links: [] }).some((e) => e.includes("fewer than 1")));
  assert.ok(validate(schema("claim"), { ...claim, kind: "guess" }).length > 0);
  assert.ok(validate(schema("claim"), { ...claim, confidence: 1.5 }).length > 0);
});

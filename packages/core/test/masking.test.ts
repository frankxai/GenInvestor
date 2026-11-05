import assert from "node:assert/strict";
import { test } from "node:test";
import { Masker } from "../src/masking.ts";

const TODAY = "2026-09-30";
const mk = (seed = "seed-1") => {
  const m = new Masker({ seed, today: TODAY });
  m.register({ ticker: "MSFT", name: "Microsoft Corporation", aliases: ["Microsoft"] });
  m.register({ ticker: "SNOW", name: "SNOWFLAKE INC." });
  m.register({ ticker: "F", name: "Ford Motor Company" });
  return m;
};

test("pseudonyms are stable per seed, differ across seeds, and never collide", () => {
  const a = mk("alpha");
  assert.equal(a.aliasFor("MSFT"), mk("alpha").aliasFor("MSFT"), "same seed, same alias");
  assert.notEqual(a.aliasFor("MSFT"), mk("beta").aliasFor("MSFT"), "a different seed gives different aliases");
  assert.match(a.aliasFor("MSFT") as string, /^ASSET-[0-9A-F]{4,}$/);
  const many = new Masker({ seed: "x", today: TODAY });
  const aliases = new Set<string>();
  for (let i = 0; i < 5000; i++) aliases.add(many.register({ ticker: `T${i}` }).ticker);
  assert.equal(aliases.size, 5000, "a bijection: no two tickers share an alias");
  assert.throws(() => new Masker({ seed: "", today: TODAY }), /seed is required/);
  assert.throws(() => new Masker({ seed: "s", today: "yesterday" }), /YYYY-MM-DD/);
});

test("names, tickers and dates in prose are masked, numbers are untouched", () => {
  const m = mk();
  const text = "Microsoft Corporation (MSFT) reported revenue of 245,122,000,000 USD for the year ended 2025-06-30, up 15.7% from 211,915,000,000 USD. MSFT filed on March 29, 2023.";
  const masked = m.maskText(text);
  assert.ok(!/Microsoft|MSFT|2025|2023|March/.test(masked), masked);
  assert.ok(masked.includes("245,122,000,000 USD") && masked.includes("15.7%") && masked.includes("211,915,000,000 USD"), "figures survive");
  assert.match(masked, /D-\d+/);
  assert.match(masked, new RegExp(`${m.aliasFor("MSFT")}`));
  assert.match(masked, /Company [0-9A-F]{4,}/);
});

test("date offsets are exact, and today is D+0", () => {
  const m = mk();
  assert.equal(m.maskDate("2026-09-30"), "D+0");
  assert.equal(m.maskDate("2026-09-29"), "D-1");
  assert.equal(m.maskDate("2026-10-05"), "D+5");
  assert.equal(m.maskDate("2025-09-30"), "D-365");
  assert.equal(m.maskText("filed 2026-01-31"), "filed D-242");
  assert.equal(m.maskText("in 2025"), "in Y-1");
  assert.equal(m.maskText("in 2025."), "in Y-1.", "a year at the end of a sentence is still a year");
  assert.equal(m.maskText("since March 2026"), "since M-6");
  assert.equal(m.maskText("period 2025-12"), "period M-9");
  const back = (y: number, mo: number, d: number) => Math.round((Date.UTC(2026, 8, 30) - Date.UTC(y, mo, d)) / 86_400_000); // independent of the module under test
  assert.equal(m.maskText("15 March 2023 and Mar. 3rd, 2024"), `D-${back(2023, 2, 15)} and D-${back(2024, 2, 3)}`);
  assert.equal(back(2024, 2, 3), 941);
});

test("figures that only look like years are left alone", () => {
  const m = mk();
  assert.equal(m.maskText("revenue was 2,025,000 USD and 1.2025 times"), "revenue was 2,025,000 USD and 1.2025 times");
  assert.equal(m.maskText("$2025 per share"), "$2025 per share");
});

test("short tickers are only masked when written as tickers, so ordinary words survive", () => {
  const m = mk();
  const text = "A sensible plan. F is (F) or $F, not a word. It is F1 racing and a Fiat.";
  const masked = m.maskText(text);
  assert.ok(masked.startsWith("A sensible plan."), "the article 'A' is not a ticker");
  assert.ok(!/\$F\b|\(F\)/.test(masked), "written as a ticker, it is masked");
  assert.match(masked, /F1 racing and a Fiat/);
});

test("a longer name wins over a shorter one it contains, and a ticker inside a longer word is not touched", () => {
  const m = new Masker({ seed: "s", today: TODAY });
  m.register({ ticker: "ACME", name: "ACME HOLDINGS INC", aliases: ["ACME"] });
  const masked = m.maskText("ACME HOLDINGS INC and ACME and ACMEWARE and ACMES");
  assert.equal(masked.includes("HOLDINGS"), false);
  assert.ok(masked.includes("ACMEWARE") && masked.includes("ACMES"), "whole words only");
});

test("the auditor finds every kind of leak, and a masked artifact is clean", () => {
  const m = mk();
  const leaks = m.audit("Microsoft grew. SNOW too, on 2024-03-26 and March 5, 2023 and 12 May 2022, in 2024 and Mar 2021 and 2020-11.");
  const kinds = new Set(leaks.map((l) => l.kind));
  assert.deepEqual([...kinds].sort(), ["date", "name", "ticker", "year"]);
  assert.ok(leaks.length >= 9, `found ${leaks.length}`);
  const dirty = "Microsoft Corporation (MSFT), SNOWFLAKE INC. and $F reported on 2025-06-30 (Mar 2024) in fiscal 2025.";
  assert.deepEqual(m.audit(m.maskText(dirty)), [], "masking then auditing leaves nothing");
});

test("masking then unmasking restores names, tickers and dates", () => {
  const m = mk();
  const text = "MSFT reported on 2025-06-30 and again in 2026-01-31.";
  const back = m.unmask(m.maskText(text));
  assert.equal(back, text);
  assert.equal(m.unmask(m.maskText("SNOWFLAKE INC. in 2024")), "SNOWFLAKE INC. in 2024");
  assert.equal(m.unmask("M-9"), "2025-12");
});

test("maskDeep masks every string in a structure and leaves keys and numbers alone", () => {
  const m = mk();
  const card = { ticker: "MSFT", name: "Microsoft Corporation", asOf: "2025-06-30", score: 0.42, whyPassed: [{ text: "Microsoft Corporation revenue was 245,122,000,000 USD at 2025-06-30", claimIds: ["abc"] }], nested: { when: "March 29, 2023" } };
  const masked = m.maskDeep(card);
  assert.equal(masked.score, 0.42);
  assert.deepEqual(Object.keys(masked), Object.keys(card));
  assert.deepEqual(m.audit(JSON.stringify(masked)), []);
  assert.equal(masked.whyPassed[0]?.claimIds[0], "abc", "claim ids are not text to mask");
  assert.ok(masked.whyPassed[0]?.text.includes("245,122,000,000 USD"));
});

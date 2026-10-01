#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runDailyScan, reviewDailyScan } from "../src/daily.ts";
const args = process.argv.slice(2);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
try {
  if (value("--review")) {
    console.log(
      JSON.stringify(
        reviewDailyScan(
          resolve(value("--home") ?? ".geninvestor"),
          value("--review")!,
        ),
      ),
    );
    process.exit(0);
  }
  const file = value("--config");
  if (!file)
    throw Error(
      "Usage: node packages/core/bin/daily-scan.ts --config FILE [--home DIR] [--live-sec] [--live-models]",
    );
  const absolute = resolve(file);
  const result = await runDailyScan(
    JSON.parse(readFileSync(absolute, "utf8")),
    {
      baseDir: dirname(absolute),
      home: resolve(value("--home") ?? ".geninvestor"),
      liveSec: args.includes("--live-sec"),
      liveModels: args.includes("--live-models"),
    },
  );
  console.log(JSON.stringify(result));
} catch {
  console.error(
    "Daily scan stopped. Inspect the configuration and local evidence; no dashboard snapshot was published.",
  );
  process.exitCode = 1;
}

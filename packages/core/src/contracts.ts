import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PolicyTable } from "./policy.ts";

const CONTRACTS = fileURLToPath(new URL("../../contracts/", import.meta.url));

export function loadPolicyTable(): PolicyTable {
  return JSON.parse(readFileSync(`${CONTRACTS}policy/policy.json`, "utf8")) as PolicyTable;
}

export function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${CONTRACTS}schemas/${name}.schema.json`, "utf8"));
}

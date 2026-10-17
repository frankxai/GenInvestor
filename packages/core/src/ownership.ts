import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { claimsAudit } from "./audit.ts";
import { loadSchema } from "./contracts.ts";
import { validate } from "../../contracts/src/validate.ts";
import type { Schema } from "../../contracts/src/validate.ts";
import type { Datum, EvidenceLedger, DisplayContext } from "./ledger.ts";
import type { BriefLine } from "./audit.ts";
export interface OwnershipSource {
  fetchOwnership(
    identifier: string,
    form: "4" | "13F-HR",
    asOf: string,
  ): Promise<Datum[]>;
}
export class EdgarSidecar implements OwnershipSource {
  private readonly python: string;
  private readonly valueUnit?: "USD" | "USD_THOUSANDS";
  constructor(python = "python3", valueUnit?: "USD" | "USD_THOUSANDS") {
    this.python = python;
    this.valueUnit = valueUnit;
  }
  async fetchOwnership(
    identifier: string,
    form: "4" | "13F-HR",
    asOf: string,
  ): Promise<Datum[]> {
    if (
      !/^[A-Za-z0-9.-]{1,10}$/.test(identifier) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
      !["4", "13F-HR"].includes(form)
    )
      throw Error("Invalid ownership query");
    const script = fileURLToPath(
      new URL("../../edgar-sidecar/ownership.py", import.meta.url),
    );
    let stdout: string;
    try {
      ({ stdout } = await promisify(execFile)(
        this.python,
        [
          script,
          "--identifier",
          identifier,
          "--form",
          form,
          "--as-of",
          asOf,
          ...(this.valueUnit ? ["--value-unit", this.valueUnit] : []),
        ],
        { timeout: 60000, maxBuffer: 20000000 },
      ));
    } catch {
      throw Error(
        "Ownership sidecar failed; no provider error or identity is exposed",
      );
    }
    const data = JSON.parse(stdout);
    if (!Array.isArray(data) || data.length > 100)
      throw Error("Invalid ownership envelope");
    for (const d of data) {
      if (
        validate(loadSchema("datum") as Schema, d).length ||
        d.payload?.filedAt > asOf ||
        d.payload?.knownAsOf !== asOf
      )
        throw Error("Ownership evidence contract or availability failed");
    }
    return data;
  }
}
export function ownershipClaims(
  ledger: EvidenceLedger,
  datum: Datum,
  context: DisplayContext,
): BriefLine[] {
  const source = ledger.addSource(datum);
  const p = datum.payload as Record<string, any>;
  const rows = p.form === "4" || p.form === "4/A" ? p.transactions : p.holdings;
  const key = p.form === "4" || p.form === "4/A" ? "transactions" : "holdings";
  if (!Array.isArray(rows)) throw Error("No ownership rows");
  const lines: BriefLine[] = [];
  rows.forEach((row, i) => {
    for (const [field, value] of Object.entries(row)) {
      if (typeof value !== "number") continue;
      if (!Number.isFinite(value)) throw Error("Invalid ownership figure");
      const text = `${field}: ${value}`;
      const c = ledger.addClaim({
        text,
        kind: "fact",
        producedBy: "ownership-parser",
        runId: `${source.id}:${i}`,
        links: [
          {
            sourceId: source.id,
            kind: "field",
            fieldOrQuote: `${key}.${i}.${field}`,
            value,
          },
        ],
      });
      lines.push({ text, claimIds: [c.id] });
    }
  });
  const audit = claimsAudit(
    { title: "Ownership evidence", generatedAt: datum.retrievedAt, lines },
    ledger,
    { context },
  );
  if (!audit.passed)
    throw Error("Ownership claims failed display or evidence audit");
  return lines;
}

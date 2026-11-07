import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type LicenceClass = "public" | "user_licensed" | "sim_only" | "restricted";
export type ClaimKind = "fact" | "inference" | "opinion";
export type LinkKind = "field" | "quote" | "computed";
export type DisplayContext = "local_user" | "hosted_paid" | "public" | "simulation";

export interface Datum {
  provider: string;
  url: string;
  asOf: string; // when the data describes, ISO 8601
  retrievedAt: string; // when we fetched it, ISO 8601
  licenceClass: LicenceClass;
  delayedBySeconds: number;
  payload: unknown; // stored verbatim; the hash covers it
}

export interface SourceRow extends Datum {
  id: string;
  sha256: string;
}

export interface LinkInput {
  sourceId: string;
  kind: LinkKind;
  fieldOrQuote: string; // dotted path into the payload for "field", literal text for "quote", a label for "computed"
  value?: number | string | null; // the value the claim asserts, for "field" and "computed"
}

export interface ClaimInput {
  text: string;
  kind: ClaimKind;
  producedBy: string;
  runId: string;
  confidence?: number | null;
  links: LinkInput[];
}

export interface ClaimRow {
  id: string;
  text: string;
  kind: ClaimKind;
  producedBy: string;
  runId: string;
  confidence: number | null;
  createdAt: string;
  links: (LinkInput & { claimId: string })[];
}

const DISPLAY_RULES: Record<DisplayContext, LicenceClass[]> = {
  local_user: ["public", "user_licensed", "sim_only"],
  simulation: ["public", "user_licensed", "sim_only"],
  hosted_paid: ["public"],
  public: ["public"],
};

/** Whether a datum may be shown in a context. `restricted` is never shown. */
export function canDisplay(licenceClass: LicenceClass, context: DisplayContext): boolean {
  return DISPLAY_RULES[context].includes(licenceClass);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function getPath(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, url TEXT NOT NULL, as_of TEXT NOT NULL,
  retrieved_at TEXT NOT NULL, licence_class TEXT NOT NULL, delayed_by_s INTEGER NOT NULL,
  sha256 TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL, produced_by TEXT NOT NULL,
  run_id TEXT NOT NULL, confidence REAL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  claim_id TEXT NOT NULL REFERENCES claims(id), source_id TEXT NOT NULL REFERENCES sources(id),
  kind TEXT NOT NULL, field_or_quote TEXT NOT NULL, value TEXT,
  PRIMARY KEY (claim_id, source_id, kind, field_or_quote)
);
CREATE TRIGGER IF NOT EXISTS sources_no_update BEFORE UPDATE ON sources BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS sources_no_delete BEFORE DELETE ON sources BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS claims_no_update BEFORE UPDATE ON claims BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS claims_no_delete BEFORE DELETE ON claims BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS links_no_update BEFORE UPDATE ON links BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS links_no_delete BEFORE DELETE ON links BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
`;

/**
 * Append-only evidence ledger. A claim cannot exist without at least one link to a
 * stored source, ids are content hashes so re-adding the same thing is a no-op,
 * and `verify()` re-hashes every stored payload to expose tampering.
 */
export class EvidenceLedger {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  addSource(datum: Datum): SourceRow {
    const payload = canonicalJson(datum.payload);
    const digest = sha256(payload);
    const id = sha256(`${datum.provider}|${datum.url}|${datum.asOf}|${digest}`).slice(0, 16);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sources
         (id, provider, url, as_of, retrieved_at, licence_class, delayed_by_s, sha256, payload)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, datum.provider, datum.url, datum.asOf, datum.retrievedAt, datum.licenceClass, datum.delayedBySeconds, digest, payload);
    return { ...datum, id, sha256: digest };
  }

  getSource(id: string): SourceRow | undefined {
    const r = this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string,
      provider: r.provider as string,
      url: r.url as string,
      asOf: r.as_of as string,
      retrievedAt: r.retrieved_at as string,
      licenceClass: r.licence_class as LicenceClass,
      delayedBySeconds: r.delayed_by_s as number,
      sha256: r.sha256 as string,
      payload: JSON.parse(r.payload as string),
    };
  }

  addClaim(input: ClaimInput): ClaimRow {
    if (input.links.length === 0) throw new Error("A claim needs at least one link to a source.");
    for (const link of input.links) {
      if (!this.getSource(link.sourceId)) throw new Error(`Unknown source ${link.sourceId}`);
    }
    const id = sha256(`${input.runId}|${input.kind}|${input.text}`).slice(0, 16);
    const createdAt = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO claims (id, text, kind, produced_by, run_id, confidence, created_at) VALUES (?,?,?,?,?,?,?)")
        .run(id, input.text, input.kind, input.producedBy, input.runId, input.confidence ?? null, createdAt);
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO links (claim_id, source_id, kind, field_or_quote, value) VALUES (?,?,?,?,?)",
      );
      for (const l of input.links) {
        insert.run(id, l.sourceId, l.kind, l.fieldOrQuote, l.value === undefined || l.value === null ? null : String(l.value));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getClaim(id) as ClaimRow;
  }

  getClaim(id: string): ClaimRow | undefined {
    const r = this.db.prepare("SELECT * FROM claims WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const links = (
      this.db.prepare("SELECT * FROM links WHERE claim_id = ? ORDER BY source_id, kind, field_or_quote").all(id) as Record<string, unknown>[]
    ).map((l) => ({
      claimId: l.claim_id as string,
      sourceId: l.source_id as string,
      kind: l.kind as LinkKind,
      fieldOrQuote: l.field_or_quote as string,
      value: l.value === null ? null : (l.value as string),
    }));
    return {
      id: r.id as string,
      text: r.text as string,
      kind: r.kind as ClaimKind,
      producedBy: r.produced_by as string,
      runId: r.run_id as string,
      confidence: (r.confidence as number | null) ?? null,
      createdAt: r.created_at as string,
      links,
    };
  }

  /** The evidence chain behind a claim: the claim, each link, and the source it points to. */
  explain(claimId: string) {
    const claim = this.getClaim(claimId);
    if (!claim) return undefined;
    return { claim, sources: claim.links.map((l) => ({ link: l, source: this.getSource(l.sourceId) })) };
  }

  /** Re-hash every stored payload. Returns the ids of sources whose bytes no longer match. */
  verify(): string[] {
    const bad: string[] = [];
    const rows = this.db.prepare("SELECT id, sha256, payload FROM sources").all() as { id: string; sha256: string; payload: string }[];
    for (const row of rows) {
      if (sha256(row.payload) !== row.sha256) bad.push(row.id);
    }
    return bad;
  }
}

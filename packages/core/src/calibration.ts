import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256 } from "./ledger.ts";

/** Below this many resolved calls no accuracy figure is shown at all. */
export const SAMPLE_FLOOR = 30;
/** A reliability band with fewer resolved calls than this is not shown. */
export const BAND_FLOOR = 10;

export interface CallInput {
  claim: string; // unambiguous and resolvable
  probability: number; // 0.01 to 0.99, the owner's own number
  resolvesOn: string; // YYYY-MM-DD, in the future when registered
  resolutionSource: string; // exactly how the outcome will be known
  baseline?: number | null; // base rate for events of this kind, if known
  sourceCard?: string | null; // the opportunity card or thesis this came from
}

export interface CallRow extends CallInput {
  id: string;
  registeredAt: string;
  outcome: 0 | 1 | null;
  resolvedAt: string | null;
  note: string | null;
}

export interface Band {
  band: string;
  n: number;
  stated: number;
  observed: number;
}

export interface Score {
  resolved: number;
  open: number;
  /** Present only at or above SAMPLE_FLOOR. */
  brier?: number;
  baselineBrier?: number;
  reliability?: Band[];
  note?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY, registered_at TEXT NOT NULL, claim TEXT NOT NULL, probability REAL NOT NULL,
  resolves_on TEXT NOT NULL, resolution_source TEXT NOT NULL, baseline REAL, source_card TEXT
);
CREATE TABLE IF NOT EXISTS resolutions (
  call_id TEXT PRIMARY KEY REFERENCES calls(id), resolved_at TEXT NOT NULL,
  outcome INTEGER NOT NULL CHECK (outcome IN (0,1)), note TEXT
);
CREATE TRIGGER IF NOT EXISTS calls_no_update BEFORE UPDATE ON calls BEGIN SELECT RAISE(ABORT, 'calls are append-only'); END;
CREATE TRIGGER IF NOT EXISTS calls_no_delete BEFORE DELETE ON calls BEGIN SELECT RAISE(ABORT, 'calls are append-only'); END;
CREATE TRIGGER IF NOT EXISTS resolutions_no_update BEFORE UPDATE ON resolutions BEGIN SELECT RAISE(ABORT, 'resolutions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS resolutions_no_delete BEFORE DELETE ON resolutions BEGIN SELECT RAISE(ABORT, 'resolutions are append-only'); END;
`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Forecasts registered before the outcome exists. The registration time comes from the ledger's own
 * clock, never from the caller, so a call cannot be back-dated. Entries and resolutions cannot be
 * edited or deleted. To change your mind, register a new call.
 */
export class CalibrationLedger {
  readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(path = ":memory:", now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.now = now;
  }

  close(): void {
    this.db.close();
  }

  register(input: CallInput): CallRow {
    const claim = input.claim?.trim() ?? "";
    if (claim.length === 0 || claim.length > 500) throw new Error("claim must be 1 to 500 characters");
    if (!(input.probability >= 0.01 && input.probability <= 0.99)) throw new Error("probability must be between 0.01 and 0.99: 0 and 1 are not forecasts");
    if (!DATE.test(input.resolvesOn)) throw new Error("resolvesOn must be YYYY-MM-DD");
    if (!input.resolutionSource || input.resolutionSource.trim().length < 5) throw new Error("a call needs a resolution source: how will the outcome be known?");
    if (input.baseline !== undefined && input.baseline !== null && !(input.baseline > 0 && input.baseline < 1)) throw new Error("baseline must be between 0 and 1");
    const registeredAt = this.now().toISOString();
    if (input.resolvesOn <= registeredAt.slice(0, 10)) throw new Error("resolvesOn must be in the future: a call cannot be registered after its outcome is knowable");

    const id = sha256(canonicalJson({ claim, p: input.probability, on: input.resolvesOn, at: registeredAt })).slice(0, 12);
    this.db
      .prepare("INSERT INTO calls (id, registered_at, claim, probability, resolves_on, resolution_source, baseline, source_card) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, registeredAt, claim, input.probability, input.resolvesOn, input.resolutionSource.trim(), input.baseline ?? null, input.sourceCard ?? null);
    return this.get(id) as CallRow;
  }

  resolve(id: string, outcome: 0 | 1, note?: string): CallRow {
    const call = this.get(id);
    if (!call) throw new Error(`no call ${id}`);
    if (call.outcome !== null) throw new Error(`call ${id} is already resolved: outcomes cannot be changed`);
    const today = this.now().toISOString().slice(0, 10);
    if (today < call.resolvesOn) throw new Error(`call ${id} cannot be resolved before ${call.resolvesOn}`);
    if (outcome !== 0 && outcome !== 1) throw new Error("outcome must be 0 (did not happen) or 1 (happened)");
    this.db.prepare("INSERT INTO resolutions (call_id, resolved_at, outcome, note) VALUES (?,?,?,?)").run(id, this.now().toISOString(), outcome, note ?? null);
    return this.get(id) as CallRow;
  }

  get(id: string): CallRow | undefined {
    const r = this.db
      .prepare(
        `SELECT c.*, r.outcome AS outcome, r.resolved_at AS resolved_at, r.note AS note
         FROM calls c LEFT JOIN resolutions r ON r.call_id = c.id WHERE c.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return r ? toRow(r) : undefined;
  }

  list(): CallRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, r.outcome AS outcome, r.resolved_at AS resolved_at, r.note AS note
         FROM calls c LEFT JOIN resolutions r ON r.call_id = c.id ORDER BY c.registered_at, c.id`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(toRow);
  }

  /** Calls whose date has arrived and that still need an outcome. */
  due(): CallRow[] {
    const today = this.now().toISOString().slice(0, 10);
    return this.list().filter((c) => c.outcome === null && c.resolvesOn <= today);
  }

  score(): Score {
    const all = this.list();
    const resolved = all.filter((c) => c.outcome !== null);
    const open = all.length - resolved.length;
    if (resolved.length < SAMPLE_FLOOR) {
      return { resolved: resolved.length, open, note: `below the sample floor of ${SAMPLE_FLOOR} resolved calls: no accuracy figure is shown` };
    }
    const brier = mean(resolved.map((c) => (c.probability - (c.outcome as number)) ** 2));
    const base = mean(resolved.map((c) => c.outcome as number));
    const baselineBrier = base * (1 - base); // always stating the observed base rate
    const bands: Band[] = [];
    for (let lo = 0; lo < 100; lo += 10) {
      const inBand = resolved.filter((c) => c.probability * 100 >= lo && c.probability * 100 < lo + 10);
      if (inBand.length >= BAND_FLOOR) {
        bands.push({
          band: `${lo}-${lo + 9}%`,
          n: inBand.length,
          stated: round(mean(inBand.map((c) => c.probability))),
          observed: round(mean(inBand.map((c) => c.outcome as number))),
        });
      }
    }
    return { resolved: resolved.length, open, brier: round(brier), baselineBrier: round(baselineBrier), reliability: bands };
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = (n: number) => Math.round(n * 1000) / 1000;

function toRow(r: Record<string, unknown>): CallRow {
  return {
    id: r.id as string,
    registeredAt: r.registered_at as string,
    claim: r.claim as string,
    probability: r.probability as number,
    resolvesOn: r.resolves_on as string,
    resolutionSource: r.resolution_source as string,
    baseline: (r.baseline as number | null) ?? null,
    sourceCard: (r.source_card as string | null) ?? null,
    outcome: r.outcome === null || r.outcome === undefined ? null : ((r.outcome as number) === 1 ? 1 : 0),
    resolvedAt: (r.resolved_at as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  };
}

import type { Datum } from "./ledger.ts";

export interface Observation {
  date: string;
  value: number;
}

/** level: relative change is meaningful. rate: change is in percentage points. event: only changes are recorded. */
export type SeriesKind = "level" | "rate" | "event";

export interface SeriesPayload {
  series: string;
  label: string;
  unit: string;
  kind?: SeriesKind; // defaults to "level"
  maxAgeDays?: number | null; // older than this is flagged stale; null means event data with no expected cadence
  observations: Observation[]; // ascending by date
  latest: Observation;
  prior: Observation | null;
}

export interface Provider {
  readonly name: string;
  fetchSeries(id: string): Promise<Datum>;
}

interface SdmxJson {
  dataSets: { series: Record<string, { observations: Record<string, (number | null)[]> }> }[];
  structure: {
    dimensions: { observation: { values: { id: string }[] }[] };
    attributes?: { series?: { id: string; values: { id?: string; name?: string }[] }[] };
  };
}

/** Parse an ECB Data Portal SDMX-JSON response (one series) into a SeriesPayload. */
export function parseSdmxJson(id: string, raw: unknown): SeriesPayload {
  const json = raw as SdmxJson;
  const seriesMap = json.dataSets?.[0]?.series;
  const key = seriesMap ? Object.keys(seriesMap)[0] : undefined;
  if (!seriesMap || key === undefined) throw new Error(`ECB response for ${id} has no series`);
  const periods = json.structure.dimensions.observation[0]?.values ?? [];
  const observations: Observation[] = [];
  for (const [index, cells] of Object.entries((seriesMap[key] as { observations: Record<string, (number | null)[]> }).observations)) {
    const value = cells[0];
    const period = periods[Number(index)];
    if (typeof value === "number" && period) observations.push({ date: period.id, value });
  }
  observations.sort((a, b) => (a.date < b.date ? -1 : 1));
  const latest = observations[observations.length - 1];
  if (!latest) throw new Error(`ECB response for ${id} has no numeric observations`);
  const attr = (attrId: string) => json.structure.attributes?.series?.find((a) => a.id === attrId)?.values?.[0];
  return {
    series: id,
    label: attr("TITLE")?.name ?? id,
    unit: attr("UNIT")?.id ?? attr("UNIT")?.name ?? "",
    observations,
    latest,
    prior: observations[observations.length - 2] ?? null,
  };
}

export interface EcbSeriesDef {
  flow: string;
  key: string;
  label: string;
  unit: string;
  kind: SeriesKind;
  maxAgeDays: number | null;
}

/** A small starter catalogue of ECB series, keys confirmed against the live API on 2026-09-30. */
export const ECB_SERIES: Record<string, EcbSeriesDef> = {
  "EXR.USD": { flow: "EXR", key: "D.USD.EUR.SP00.A", label: "EUR/USD reference rate", unit: "USD", kind: "level", maxAgeDays: 6 },
  "EST.ESTR": { flow: "EST", key: "B.EU000A2X2A25.WT", label: "Euro short-term rate (€STR)", unit: "%", kind: "rate", maxAgeDays: 6 },
  "ICP.HICP_ANR": { flow: "ICP", key: "M.U2.N.000000.4.ANR", label: "Euro area HICP inflation, annual rate", unit: "%", kind: "rate", maxAgeDays: 75 },
  "FM.DFR": { flow: "FM", key: "B.U2.EUR.4F.KR.DFR.LEV", label: "ECB deposit facility rate", unit: "%", kind: "event", maxAgeDays: null },
};

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class EcbProvider implements Provider {
  readonly name = "ecb";
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly last: number;

  constructor(fetchImpl: FetchLike = fetch as unknown as FetchLike, now: () => Date = () => new Date(), last = 3) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.last = last;
  }

  async fetchSeries(id: string): Promise<Datum> {
    const def = ECB_SERIES[id];
    if (!def) throw new Error(`Unknown ECB series ${id}`);
    const url = `https://data-api.ecb.europa.eu/service/data/${def.flow}/${def.key}?lastNObservations=${this.last}&format=jsondata`;
    const response = await this.fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`ECB ${id} returned HTTP ${response.status}`);
    const payload: SeriesPayload = {
      ...parseSdmxJson(id, await response.json()),
      label: def.label,
      unit: def.unit,
      kind: def.kind,
      maxAgeDays: def.maxAgeDays,
    };
    return {
      provider: this.name,
      url,
      asOf: payload.latest.date,
      retrievedAt: this.now().toISOString(),
      licenceClass: "public",
      delayedBySeconds: 0,
      payload,
    };
  }
}

/** Serves prepared payloads. Used by tests, demos and offline runs. */
export class FixtureProvider implements Provider {
  readonly name: string;
  private readonly series: Record<string, SeriesPayload>;
  private readonly opts: { licenceClass?: Datum["licenceClass"]; retrievedAt?: string };

  constructor(name: string, series: Record<string, SeriesPayload>, opts: { licenceClass?: Datum["licenceClass"]; retrievedAt?: string } = {}) {
    this.name = name;
    this.series = series;
    this.opts = opts;
  }

  async fetchSeries(id: string): Promise<Datum> {
    const payload = this.series[id];
    if (!payload) throw new Error(`Fixture has no series ${id}`);
    return {
      provider: this.name,
      url: `fixture://${this.name}/${id}`,
      asOf: payload.latest.date,
      retrievedAt: this.opts.retrievedAt ?? "2026-09-30T06:00:00.000Z",
      licenceClass: this.opts.licenceClass ?? "public",
      delayedBySeconds: 0,
      payload,
    };
  }
}

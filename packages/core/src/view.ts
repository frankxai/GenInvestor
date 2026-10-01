import { claimsAudit } from "./audit.ts";
import type { BriefLine, AuditOptions } from "./audit.ts";
import type { EvidenceLedger } from "./ledger.ts";
export interface EvidenceReceipt {
  claimId: string;
  text: string;
  kind: string;
  sources: {
    provider: string;
    url: string;
    asOf: string;
    retrievedAt: string;
    sha256: string;
    licenceClass: string;
    field: string;
    value: string | number | null | undefined;
    stale: boolean;
  }[];
}
export interface EvidenceFigure {
  text: string;
  receipts: EvidenceReceipt[];
}
function stale(
  source: { provider: string; asOf: string; payload: unknown },
  now: Date,
): boolean {
  const payload = source.payload as { maxAgeDays?: number | null };
  const maxAge =
    payload?.maxAgeDays !== undefined
      ? payload.maxAgeDays
      : ["recorded-price", "value-basis"].includes(source.provider)
        ? 7
        : source.provider.startsWith("sec-edgar")
          ? 550
          : null;
  return (
    typeof maxAge === "number" &&
    Number.isFinite(maxAge) &&
    maxAge >= 0 &&
    Number.isFinite(Date.parse(source.asOf)) &&
    now.getTime() - Date.parse(source.asOf) > maxAge * 86400000
  );
}
export function evidenceFigure(
  line: BriefLine,
  ledger: EvidenceLedger,
  options: AuditOptions,
  now = new Date(),
): EvidenceFigure | undefined {
  if (
    !line.claimIds.length ||
    !claimsAudit({ title: "", generatedAt: "", lines: [line] }, ledger, options)
      .passed
  )
    return undefined;
  const receipts = line.claimIds.map((id) => {
    const chain = ledger.explain(id)!;
    return {
      claimId: id,
      text: chain.claim.text,
      kind: chain.claim.kind,
      sources: chain.sources.map(({ link, source }) => ({
        provider: source!.provider,
        url: source!.url,
        asOf: source!.asOf,
        retrievedAt: source!.retrievedAt,
        sha256: source!.sha256,
        licenceClass: source!.licenceClass,
        field: link.fieldOrQuote,
        value: link.value,
        stale: stale(source!, now),
      })),
    };
  });
  return { text: line.text, receipts };
}

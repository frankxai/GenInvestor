import { canDisplay, EvidenceLedger, getPath } from "./ledger.ts";
import type { DisplayContext } from "./ledger.ts";

export interface BriefLine {
  text: string;
  claimIds: string[];
}

export interface Brief {
  title: string;
  generatedAt: string;
  lines: BriefLine[];
}

export type FindingCode =
  | "UNLINKED_NUMBER"
  | "UNKNOWN_CLAIM"
  | "NUMBER_NOT_IN_CLAIMS"
  | "SOURCE_TAMPERED"
  | "FIELD_MISMATCH"
  | "QUOTE_MISMATCH"
  | "RECOMPUTE_MISMATCH"
  | "LINK_VALUE_NOT_STATED"
  | "CITATION_NOT_SUPPORTING"
  | "DISPLAY_BLOCKED";

export interface Finding {
  code: FindingCode;
  line: number;
  detail: string;
}

export interface AuditResult {
  passed: boolean;
  findings: Finding[];
}

export interface AuditOptions {
  context: DisplayContext;
  /** Re-computes a "computed" link's value from the source payload. Keyed by the link's fieldOrQuote label. */
  recompute?: Record<string, (payload: unknown) => number>;
  tolerance?: number;
}

const ISO_DATE = /\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g;
const NUMBER = /-?\d+(?:[.,]\d+)*/g;

export function numbersIn(text: string): number[] {
  return (text.replace(ISO_DATE, " ").match(NUMBER) ?? []).map((t) => Number(t.replace(/,/g, "")));
}

/**
 * Equality for numbers that came from the same source. The floor absorbs floating-point noise only:
 * the allowance grows with magnitude by one part in 10^12, so on a figure of a billion dollars a
 * difference of a single dollar is still a difference. (It once scaled by 10^-9, which let a
 * one-dollar change to a $1.2 billion figure through.)
 */
function close(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= Math.max(tol, tol * 1e-3 * Math.max(Math.abs(a), Math.abs(b)));
}

/**
 * Blocks any brief line that carries a number the evidence does not back. This is the
 * rule "a sentence with no link cannot leave the system", plus the checks that make
 * a link mean something: the number must appear in a linked claim, the linked field must
 * hold that value, quotes must match byte for byte, computed values must recompute, and
 * the source must still hash to what was stored.
 */
export function claimsAudit(brief: Brief, ledger: EvidenceLedger, options: AuditOptions): AuditResult {
  const tol = options.tolerance ?? 1e-9;
  const findings: Finding[] = [];
  const tampered = new Set(ledger.verify());

  brief.lines.forEach((line, index) => {
    const add = (code: FindingCode, detail: string) => findings.push({ code, line: index, detail });
    const lineNumbers = numbersIn(line.text);

    if (line.claimIds.length === 0) {
      if (lineNumbers.length > 0) add("UNLINKED_NUMBER", `line has numbers but no claim: "${line.text}"`);
      return;
    }

    const claimNumbers: number[] = [];
    for (const id of line.claimIds) {
      const claim = ledger.getClaim(id);
      if (!claim) {
        add("UNKNOWN_CLAIM", `claim ${id} is not in the ledger`);
        continue;
      }
      claimNumbers.push(...numbersIn(claim.text));

      for (const link of claim.links) {
        const source = ledger.getSource(link.sourceId);
        if (!source) {
          add("UNKNOWN_CLAIM", `claim ${id} links to missing source ${link.sourceId}`);
          continue;
        }
        if (tampered.has(source.id)) add("SOURCE_TAMPERED", `source ${source.id} no longer matches its hash`);
        if (!canDisplay(source.licenceClass, options.context)) {
          add("DISPLAY_BLOCKED", `source ${source.id} is ${source.licenceClass}, not displayable in ${options.context}`);
        }
        const numericLink = (link.kind === "field" || link.kind === "computed") && link.value !== null && link.value !== undefined && link.value !== "" && Number.isFinite(Number(link.value));
        if (numericLink) {
          // A link may only cite a value the claim actually states (sign aside): otherwise a claim could
          // say one number in its text and point at evidence for another.
          const linked = Math.abs(Number(link.value));
          if (!numbersIn(claim.text).some((n) => close(Math.abs(n), linked, tol))) {
            add("LINK_VALUE_NOT_STATED", `claim ${id} links ${link.fieldOrQuote} = ${String(link.value)} but its text does not state that value`);
          }
        }
        if (link.kind === "field") {
          const actual = getPath(source.payload, link.fieldOrQuote);
          if (actual === undefined) add("FIELD_MISMATCH", `${link.fieldOrQuote} is missing from source ${source.id}`);
          else if (numericLink) {
            if (!(typeof actual === "number" && close(actual, Number(link.value), tol))) {
              add("FIELD_MISMATCH", `${link.fieldOrQuote} is ${String(actual)} in source ${source.id}, claim states ${String(link.value)}`);
            }
          } else if (link.value !== null && link.value !== undefined && String(actual) !== String(link.value)) {
            add("FIELD_MISMATCH", `${link.fieldOrQuote} is ${String(actual)} in source ${source.id}, claim states ${String(link.value)}`);
          }
        } else if (link.kind === "quote") {
          const haystack = typeof source.payload === "string" ? source.payload : JSON.stringify(source.payload);
          if (!haystack.includes(link.fieldOrQuote)) add("QUOTE_MISMATCH", `quote not found byte for byte in source ${source.id}`);
        } else if (link.kind === "computed") {
          const fn = options.recompute?.[link.fieldOrQuote];
          if (!fn) add("RECOMPUTE_MISMATCH", `no recompute function registered for "${link.fieldOrQuote}"`);
          else {
            const again = fn(source.payload);
            if (link.value === null || link.value === undefined || !close(again, Number(link.value), tol)) {
              add("RECOMPUTE_MISMATCH", `"${link.fieldOrQuote}" recomputes to ${again}, claim states ${String(link.value)}`);
            }
          }
        }
      }
    }

    for (const n of lineNumbers) {
      if (!claimNumbers.some((c) => close(c, n, tol))) {
        add("NUMBER_NOT_IN_CLAIMS", `${n} in "${line.text}" appears in none of its linked claims`);
      }
    }

    // A citation has to support the line. It does if the line is the claim's own text, or if the two
    // share a figure. Without this, a line that contains no numbers could cite any claim at all.
    const claimTexts = line.claimIds.map((id) => ledger.getClaim(id)?.text).filter((t): t is string => t !== undefined);
    const verbatim = claimTexts.includes(line.text);
    const anchored = lineNumbers.some((n) => claimNumbers.some((c) => close(c, n, tol)));
    if (claimTexts.length > 0 && !verbatim && !anchored) {
      add("CITATION_NOT_SUPPORTING", `"${line.text}" cites claims that do not state it and share no figure with it`);
    }
  });

  return { passed: findings.length === 0, findings };
}

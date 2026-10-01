import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { EvidenceLedger } from "../../../packages/core/src/ledger.ts";
import { evidenceFigure } from "../../../packages/core/src/view.ts";
import type { EvidenceFigure } from "../../../packages/core/src/view.ts";
import { SCOUT_RECOMPUTE } from "../../../packages/core/src/scout.ts";
import { RECOMPUTE } from "../../../packages/core/src/today.ts";
import { loadSchema } from "../../../packages/core/src/contracts.ts";
import { validate } from "../../../packages/contracts/src/validate.ts";
import type { Schema } from "../../../packages/contracts/src/validate.ts";
export interface Workspace {
  status: "empty" | "ready" | "blocked";
  reason: string;
  date?: string;
  cards: {
    ticker: string;
    name: string;
    style: string;
    sections: { title: string; figures: EvidenceFigure[]; notes: string[] }[];
  }[];
  summary: EvidenceFigure[];
  macro: EvidenceFigure[];
}
export function loadWorkspace(): Workspace {
  const home = resolve(
    /* turbopackIgnore: true */ process.env.GENINVESTOR_HOME ??
      "../../.geninvestor",
  );
  const ledgerPath = join(home, "ledger.db");
  const file = join(home, "opportunities", "opportunities.json");
  const empty: Workspace = {
    status: "empty",
    reason: "Run a local scan to bring your evidence into this workspace.",
    cards: [],
    summary: [],
    macro: [],
  };
  if (!existsSync(ledgerPath)) return empty;
  const ledger = new EvidenceLedger(ledgerPath);
  try {
    const options = {
      context: "local_user" as const,
      recompute: { ...SCOUT_RECOMPUTE, ...RECOMPUTE },
    };
    if (ledger.verify().length)
      return {
        ...empty,
        status: "blocked",
        reason: "Source integrity failed. Figures are withheld.",
      };
    const read = (path: string) => {
      if (statSync(path).size > 10000000)
        throw Error("Oversized workspace file");
      return JSON.parse(readFileSync(path, "utf8"));
    };
    const macroFile = join(home, "briefs", "brief.json");
    const macroLines = existsSync(macroFile)
      ? (read(macroFile).lines ?? [])
      : [];
    const macroFigures = macroLines.map((l: any) =>
      evidenceFigure(l, ledger, options),
    );
    if (macroFigures.some((f: any) => !f))
      return {
        ...empty,
        status: "blocked",
        reason: "The daily brief failed its evidence audit.",
      };
    const macro = macroFigures as EvidenceFigure[];
    if (!existsSync(file))
      return { ...empty, macro, status: macro.length ? "ready" : "empty" };
    const data = read(file);
    if (validate(loadSchema("opportunities") as Schema, data).length)
      return {
        ...empty,
        status: "blocked",
        reason: "The scan does not match the evidence contract.",
      };
    const summary = (data.screen.claimIds ?? [])
      .map((id: string) => {
        const c = ledger.getClaim(id);
        return c
          ? evidenceFigure({ text: c.text, claimIds: [id] }, ledger, options)
          : undefined;
      })
      .filter(Boolean);
    let rejected =
      summary.length !== (data.screen.claimIds ?? []).length || !summary.length;
    const cards = data.cards.map((c: any) => ({
      ticker: c.ticker,
      name: c.name,
      style: c.style,
      sections: [
        ["Why it passed", c.whyPassed],
        ["What would prove it wrong", c.wouldProveWrong],
        ["The case against", c.caseAgainst],
      ].map(([title, lines]) => {
        const figures: EvidenceFigure[] = [];
        const notes: string[] = [];
        for (const l of lines) {
          if (l.claimIds.length) {
            const figure = evidenceFigure(l, ledger, options);
            if (figure) figures.push(figure);
            else rejected = true;
          } else {
            if (/\d/.test(l.text)) rejected = true;
            else notes.push(l.text);
          }
        }
        return { title, figures, notes };
      }),
    }));
    if (rejected)
      return {
        ...empty,
        status: "blocked",
        reason:
          "A displayed line failed its claims audit. Figures are withheld.",
      };
    return {
      status: "ready",
      reason: cards.length
        ? "Candidates for research. Every marked figure opens its evidence."
        : "No candidates passed the current rules. This is a valid result.",
      date: data.date,
      cards,
      summary,
      macro,
    };
  } catch {
    return {
      ...empty,
      status: "blocked",
      reason: "Local evidence could not be read. No figures are inferred.",
    };
  } finally {
    ledger.close();
  }
}

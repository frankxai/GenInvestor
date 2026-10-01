"use client";
import { useEffect, useState } from "react";
import { Command } from "cmdk";
import {
  ArrowUpRight,
  BookOpen,
  CircleCheck,
  Command as CommandIcon,
  Database,
  FileCheck2,
  Layers,
  Moon,
  Search,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Workspace } from "@/lib/workspace";
import type { EvidenceFigure } from "../../../packages/core/src/view";
export function WorkspaceUI({ workspace }: { workspace: Workspace }) {
  const [palette, setPalette] = useState(false);
  const [selected, setSelected] = useState<EvidenceFigure>();
  const [theme, setTheme] = useState("dark");
  const [filter, setFilter] = useState("");
  const [section, setSection] = useState("Overview");
  useEffect(() => {
    const stored = localStorage.getItem("geninvestor-theme");
    if (stored === "light") setTheme(stored);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("geninvestor-theme", theme);
  }, [theme]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const go = (name: string) => {
    setSection(name);
    setPalette(false);
    document
      .getElementById(name.toLowerCase())
      ?.scrollIntoView({ behavior: "instant", block: "start" });
  };
  const figure = (f: EvidenceFigure, i: number) => (
    <button
      className="evidence-line"
      key={`${f.text}-${i}`}
      onClick={() => setSelected(f)}
      aria-label={`Open evidence: ${f.text}`}
    >
      <span>{f.text}</span>
      <CircleCheck aria-hidden="true" className="receipt-mark" />
    </button>
  );
  const cards = workspace.cards.filter((c) =>
    `${c.name} ${c.ticker}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#overview">
        Skip to research
      </a>
      <aside className="rail" aria-label="Workspace navigation">
        <a className="brand" href="/" aria-label="GenInvestor home">
          <span className="brand-mark">g</span>
          <span>
            GenInvestor<span className="brand-sub">Evidence workspace</span>
          </span>
        </a>
        <p className="rail-label">Your research</p>
        <nav aria-label="Research rooms">
          {[
            ["Overview", Layers],
            ["Candidates", Search],
            ["Evidence", FileCheck2],
            ["Connectors", Database],
          ].map(([name, Icon]) => {
            const Label = name as string;
            const Glyph = Icon as typeof Layers;
            return (
              <button
                key={Label}
                aria-label={Label}
                className={`nav-item ${section === Label ? "active" : ""}`}
                onClick={() => go(Label)}
              >
                <Glyph size={17} />
                {Label}
                {section === Label && <span className="nav-dot" />}
              </button>
            );
          })}
        </nav>
        <div className="rail-bottom">
          <ShieldCheck size={19} />
          <div>
            Simulation only<small>You remain the decision maker.</small>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="crumb">
            Research <span>/</span> {section}
          </div>
          <div className="top-actions">
            <span className="local-chip">
              <i />
              Local workspace
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label="Toggle color theme"
            >
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </Button>
            <Button
              variant="outline"
              aria-label="Search workspace"
              onClick={() => setPalette(true)}
            >
              <Search size={15} />
              <span>Search workspace</span>
              <kbd>⌘ K</kbd>
            </Button>
          </div>
        </header>
        <main id="overview">
          <div className="page-heading">
            <div>
              <div className="eyebrow">Research, with receipts</div>
              <h1>
                See the evidence.
                <br />
                <span>Keep your own judgment.</span>
              </h1>
              <p>{workspace.reason}</p>
            </div>
            <div className={`status-seal ${workspace.status}`}>
              <ShieldCheck size={22} />
              <span>
                {workspace.status === "blocked"
                  ? "Audit blocked"
                  : workspace.status === "ready"
                    ? "Evidence available"
                    : "Awaiting a scan"}
                <small>{workspace.date ?? "Local data only"}</small>
              </span>
            </div>
          </div>
          <div className="summary-grid">
            {workspace.summary.map((f, i) => (
              <div className="summary-tile" key={i}>
                {figure(f, i)}
                <span className="micro-label">Audited run record</span>
              </div>
            ))}
            {!workspace.summary.length && (
              <div className="empty-summary">
                <FileCheck2 />
                <span>
                  Your run record appears here after a local scan.
                  <small>Missing data stays missing.</small>
                </span>
              </div>
            )}
          </div>
          <div className="content-grid">
            <div className="research-column">
              <section id="candidates" className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Candidates for research</h2>
                    <p>Read the case. Read the counter-case.</p>
                  </div>
                  <label className="inline-search">
                    <Search size={15} />
                    <input
                      placeholder="Filter candidates…"
                      aria-label="Filter candidates"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                  </label>
                </div>
                {!cards.length && (
                  <div className="empty-state">
                    <BookOpen size={30} />
                    <h3>
                      {filter
                        ? "No matching candidates"
                        : workspace.status === "ready"
                          ? "No candidates passed"
                          : "Bring your research here"}
                    </h3>
                    <p>
                      {filter
                        ? "Clear the filter to return to your scan."
                        : "Run the local daily scan with your mandate and recorded sources. This workspace displays audited evidence when it is available."}
                    </p>
                    <Button variant="outline" onClick={() => go("Connectors")}>
                      Inspect connectors <ArrowUpRight size={15} />
                    </Button>
                  </div>
                )}
                {cards.map((card) => (
                  <article className="candidate" key={card.ticker}>
                    <div className="candidate-heading">
                      <div className="ticker-avatar">
                        {card.ticker.slice(0, 2)}
                      </div>
                      <div>
                        <h3>{card.name}</h3>
                        <span className="ticker-label">
                          {card.ticker} · {card.style} screen
                        </span>
                      </div>
                      <span className="research-badge">Research candidate</span>
                    </div>
                    {card.sections.map((s) => (
                      <div className="case-section" key={s.title}>
                        <h4>{s.title}</h4>
                        {s.figures.map(figure)}
                        {s.notes.map((n, i) => (
                          <p className="case-note" key={i}>
                            {n}
                          </p>
                        ))}
                      </div>
                    ))}
                  </article>
                ))}
              </section>
              <section id="evidence" className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Source desk</h2>
                    <p>The latest local brief, checked against its ledger.</p>
                  </div>
                  <FileCheck2 size={20} />
                </div>
                {workspace.macro.length ? (
                  workspace.macro.map(figure)
                ) : (
                  <p className="panel-empty">
                    No audited daily brief is available. A missing source never
                    becomes a number.
                  </p>
                )}
              </section>
            </div>
            <aside className="context-column" aria-label="Research context">
              <section className="panel process-panel">
                <div className="eyebrow">How a figure earns its mark</div>
                <h2>Follow the receipt.</h2>
                <p>
                  Every marked line opens a claim, its exact source field and
                  the document fingerprint.
                </p>
                <div className="receipt-preview">
                  <CircleCheck />
                  <span>Claim → Source → Audit</span>
                </div>
                <dl>
                  <div>
                    <dt>Computation</dt>
                    <dd>Deterministic code</dd>
                  </div>
                  <div>
                    <dt>Model roles</dt>
                    <dd>Distinct providers required</dd>
                  </div>
                  <div>
                    <dt>Authority</dt>
                    <dd>Simulation only</dd>
                  </div>
                  <div>
                    <dt>Missing evidence</dt>
                    <dd>Withheld</dd>
                  </div>
                </dl>
              </section>
              <section id="connectors" className="panel connector-panel">
                <div className="panel-heading">
                  <h2>Connectors</h2>
                  <Database size={17} />
                </div>
                {[
                  [
                    "SEC fundamentals",
                    "Recorded or user-identified live",
                    "Live access unverified",
                  ],
                  [
                    "SEC ownership",
                    "edgartools sidecar",
                    "Parser tested · live unverified",
                  ],
                  [
                    "Recorded prices",
                    "User-owned data rights",
                    "Offline adapter tested",
                  ],
                  [
                    "Research models",
                    "OpenAI · Anthropic · Google",
                    "Offline contracts tested",
                  ],
                ].map(([name, detail, state]) => (
                  <div className="connector" key={name}>
                    <div className="connector-icon">
                      <Database size={16} />
                    </div>
                    <div>
                      <h3>{name}</h3>
                      <p>{detail}</p>
                      <span>{state}</span>
                    </div>
                  </div>
                ))}
                <p className="connector-note">
                  Credentials stay in your environment. Data rights travel with
                  the evidence.
                </p>
              </section>
              <section className="quiet-note">
                <CommandIcon size={16} />
                <span>
                  Press <kbd>⌘ K</kbd> or <kbd>Ctrl K</kbd> to move through your
                  workspace.
                </span>
              </section>
            </aside>
          </div>
          <footer>
            Information, not advice. No orders, transfers, signatures or
            generated forecasts.<span>Own the data. Inspect the claim.</span>
          </footer>
        </main>
      </div>
      <Dialog open={palette} onOpenChange={setPalette}>
        <DialogContent className="command-dialog">
          <DialogTitle className="sr-only">Search workspace</DialogTitle>
          <DialogDescription className="sr-only">
            Jump to a research room or inspect a candidate.
          </DialogDescription>
          <Command>
            <Command.Input
              autoFocus
              placeholder="Where do you want to go?"
              aria-label="Search commands"
            />
            <Command.List>
              <Command.Empty>No matching command.</Command.Empty>
              <Command.Group heading="Research rooms">
                {["Overview", "Candidates", "Evidence", "Connectors"].map(
                  (name) => (
                    <Command.Item key={name} onSelect={() => go(name)}>
                      <Layers size={16} />
                      {name}
                      <ArrowUpRight size={14} />
                    </Command.Item>
                  ),
                )}
              </Command.Group>
              <Command.Group heading="Your candidates">
                {workspace.cards.map((c) => (
                  <Command.Item
                    key={c.ticker}
                    onSelect={() => {
                      setFilter(c.ticker);
                      go("Candidates");
                    }}
                  >
                    {c.name}
                    <span>{c.ticker}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        <DialogContent className="evidence-drawer">
          <div className="eyebrow">The receipt</div>
          <DialogTitle>Evidence behind this line</DialogTitle>
          <DialogDescription>
            Source fields, retrieval metadata and integrity fingerprint.
          </DialogDescription>
          <p className="drawer-line">{selected?.text}</p>
          {selected?.receipts.map((r) => (
            <div className="receipt" key={r.claimId}>
              <div className="receipt-top">
                <span>{r.kind}</span>
                <span className="audit-badge">
                  <CircleCheck size={13} />
                  Audit passed
                </span>
              </div>
              <p>{r.text}</p>
              <div className="claim-id">Claim {r.claimId}</div>
              {r.sources.map((s, i) => (
                <div className="source-receipt" key={`${s.sha256}-${i}`}>
                  <div className="source-title">
                    <strong>{s.provider}</strong>
                    <span className={s.stale ? "stale" : "fresh"}>
                      {s.stale ? "Stale evidence" : "Check source cadence"}
                    </span>
                  </div>
                  {/^https?:\/\//.test(s.url) ? (
                    <a href={s.url} target="_blank" rel="noreferrer">
                      Open source <ArrowUpRight size={14} />
                    </a>
                  ) : (
                    <span className="local-source">Local recorded source</span>
                  )}
                  <dl>
                    <div>
                      <dt>Source URL</dt>
                      <dd>{s.url}</dd>
                    </div>
                    <div>
                      <dt>As of</dt>
                      <dd>{s.asOf}</dd>
                    </div>
                    <div>
                      <dt>Retrieved</dt>
                      <dd>{s.retrievedAt}</dd>
                    </div>
                    <div>
                      <dt>Data rights</dt>
                      <dd>{s.licenceClass}</dd>
                    </div>
                    <div>
                      <dt>Why this line</dt>
                      <dd>{s.field}</dd>
                    </div>
                    <div>
                      <dt>Linked value</dt>
                      <dd>{String(s.value ?? "Quoted text")}</dd>
                    </div>
                    <div>
                      <dt>SHA-256</dt>
                      <dd className="hash">{s.sha256}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            </div>
          ))}
        </DialogContent>
      </Dialog>
    </div>
  );
}

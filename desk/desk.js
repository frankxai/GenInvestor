// GenInvestor desk view. Reads state/desk.json (a live cycle) or sample/desk.json
// (seeded synthetic). Read-only: the page cannot approve anything. Approval is a
// command the owner runs, so a browser can never move even paper cash.
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Headlines come from third-party feeds: only plain web links survive.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? esc(u) : "#");
const fmt = (n, d = 2) => (n == null || Number.isNaN(n) ? "n/a" : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const signed = (n, d = 2, unit = "") => (n == null ? "n/a" : (n > 0 ? "+" : "") + fmt(n, d) + unit);
const pct = (p) => (p == null ? "n/a" : Math.round(p * 100) + "%");
const dir = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const setupLabel = (s) => s.replaceAll("_", " ").replace("20d", "20-day");

let DESK = null;
let chart = null;

async function load() {
  if (window.DESK_DATA) return window.DESK_DATA;
  for (const path of ["state/desk.json", "sample/desk.json"]) {
    try {
      const r = await fetch(path, { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch (_) { /* try the next source */ }
  }
  throw new Error("No desk data. Run `python desk/cycle.py run` (or `run --demo`), then serve this folder.");
}


/* ---------- brand mark, badges, icons ---------- */

function logo(size = 30) {
  return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <defs><linearGradient id="lg-a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--up)"/><stop offset="1" stop-color="var(--info)"/></linearGradient></defs>
    <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#lg-a)"/>
    <rect x="1.5" y="1.5" width="29" height="29" rx="8.5" fill="none" stroke="rgba(255,255,255,.45)"/>
    <circle cx="16" cy="16" r="9.2" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.4" stroke-dasharray="44 14" stroke-linecap="round" transform="rotate(-30 16 16)"/>
    <rect x="10.6" y="16.5" width="2.6" height="5" rx="1.2" fill="#fff"/><rect x="14.7" y="13.5" width="2.6" height="8" rx="1.2" fill="#fff"/><rect x="18.8" y="10.5" width="2.6" height="11" rx="1.2" fill="#fff"/>
  </svg>`;
}

const SECTOR = {
  semis: ["Semiconductors", ["NVDA", "AMD", "AVGO"], "#7c5cff", "#b18cff"],
  platforms: ["Platforms", ["AAPL", "MSFT", "GOOGL", "META", "AMZN", "NFLX", "ORCL", "CRM", "PLTR"], "#2f6bff", "#5fb0ff"],
  consumer: ["Consumer", ["COST", "TSLA", "UBER", "SHOP"], "#e08a00", "#ffc35c"],
  health: ["Health care", ["LLY", "UNH"], "#0c9a7a", "#4fd8b0"],
  energy: ["Energy", ["XOM"], "#d4542b", "#ff9a5c"],
  finance: ["Financials", ["JPM"], "#1f8a4c", "#6fd38f"],
  macro: ["Index and macro", ["SPY", "QQQ", "IWM", "^VIX", "TLT", "GLD"], "#4b5873", "#8a98b8"],
};
const sectorOf = (sym) => Object.values(SECTOR).find(([, list]) => list.includes(sym)) || ["Other", [], "#4b5873", "#8a98b8"];

function badge(sym, size = "") {
  const [name, , a, b] = sectorOf(sym);
  const text = sym.replace("^", "").slice(0, sym === "Cash" ? 1 : 4);
  return `<span class="badge ${size}" title="${esc(name)}" style="--a:${a};--b:${b}" aria-hidden="true">${esc(text)}</span>`;
}

const ICONS = {
  gauge: '<path d="M4 15a8 8 0 1 1 16 0"/><path d="M12 15l4-5"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".6"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4"/><path d="M12 17v.5"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  hand: '<path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11m0-5.5a1.5 1.5 0 0 1 3 0V11m0-3.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a5 5 0 0 1-4.3-2.5L4 14.5a1.5 1.5 0 0 1 2.5-1.6L8 15"/>',
};
const icon = (k) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k] || ""}</svg>`;

function briefSec(s) {
  if (!s?.brief) return "";
  return `<section class="brief glass strong rise" aria-labelledby="h-brief">
    <div class="sec-head"><h2 id="h-brief">Today in 30 seconds</h2><p>${esc(s.author)} · ${esc(s.as_of)}</p></div>
    <ul>${s.brief.map((b) => `<li><span class="ib">${icon(b.icon)}</span><div><b>${esc(b.label)}</b><p>${esc(b.text)}</p></div></li>`).join("")}</ul>
  </section>`;
}

/* ---------- small charts ---------- */

function mini(values, i) {
  const W = 160, H = 36, lo = Math.min(...values), hi = Math.max(...values);
  const pts = values.map((v, k) => [(k / (values.length - 1)) * W, H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6)]);
  const d = pts.map(([x, y], k) => `${k ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const up = values[values.length - 1] >= values[0];
  let len = 0;
  for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  return `<svg class="mini" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path class="ln draw" d="${d}" style="stroke:var(${up ? "--up" : "--down"});--len:${Math.ceil(len)};--i:${i}"/></svg>`;
}

function gauge(reg) {
  const angle = Math.max(-90, Math.min(90, (reg.score / 7) * 90));
  const label = reg.label.replace("_", " ");
  const cls = reg.label === "risk_on" ? "up" : reg.label === "risk_off" ? "down" : "";
  return `<div class="gauge glass rise" style="--i:1">
    <span class="eyebrow">Market regime</span>
    <svg viewBox="0 0 280 160" role="img" aria-label="Regime score ${reg.score} of plus or minus 7: ${esc(label)}">
      <defs><linearGradient id="g-reg" x1="0" x2="1"><stop offset="0" stop-color="${css("--down")}"/><stop offset=".5" stop-color="${css("--warn")}"/><stop offset="1" stop-color="${css("--up")}"/></linearGradient></defs>
      <path class="track" d="M30,140 A110,110 0 0 1 250,140"/><path class="arc" d="M30,140 A110,110 0 0 1 250,140" opacity=".85"/>
      <line class="needle" x1="140" y1="140" x2="140" y2="48" data-angle="${angle}" style="transform:rotate(-90deg)"/>
      <circle class="hub" cx="140" cy="140" r="6"/>
      <text x="22" y="158">risk off</text><text x="226" y="158">risk on</text>
    </svg>
    <span class="label ${cls}">${esc(label)} <span class="mono muted" style="font-size:14px">${signed(reg.score, 0)}</span></span>
    <span class="why">${esc(reg.why)}</span></div>`;
}

/* ---------- sections ---------- */

function statusBar(d) {
  const m = d.meta;
  const waiting = d.candidates.filter((c) => c.status === "awaiting").length;
  return `<header class="bar glass strong">
      <div class="brand">${logo()}<h1>GenInvestor desk</h1><small>${esc(m.as_of)} close</small></div>
      <nav class="views" aria-label="Views"><a href="#desk" class="${location.hash.startsWith("#fund") ? "" : "on"}">Desk</a><a href="#funds" class="${location.hash.startsWith("#fund") ? "on" : ""}">Funds and trades</a></nav>
      <span class="pill ${waiting ? "warn live" : ""}"><span class="d"></span>${waiting} awaiting your yes</span>
      <span class="pill up"><span class="d"></span>paper</span>
      <span class="pill">${esc(m.ceiling)}</span>
      <span class="pill">${m.synthetic ? "synthetic" : "live"} · ${fmt(m.seconds, 1)}s</span>
    </header>
    ${m.synthetic ? `<p class="banner"><b>Synthetic sample.</b> Every price is a seeded random walk so the desk can be inspected without market data. Run <code>python desk/cycle.py run</code> for a live cycle.</p>` : ""}`;
}

function hero(d) {
  const pass = d.candidates.filter((c) => c.risk.verdict === "PASS").length;
  const waiting = d.candidates.filter((c) => c.status === "awaiting").length;
  const watch = d.candidates.filter((c) => c.setups.includes("watch")).map((c) => c.symbol);
  const line = waiting
    ? `<em>${waiting} ticket${waiting === 1 ? "" : "s"}</em> wait for your yes`
    : pass ? "Every passing ticket has an answer" : `<em class="down">Nothing cleared risk</em> this cycle`;
  return `<div class="hero">
    <div class="headline glass rise" style="--i:0">
      <span class="eyebrow">Today at the desk</span>
      <h2>${line}.</h2>
      <p>${d.candidates.length} names reached the desk from a ${d.meta.config.watchlist.length}-stock watchlist${watch.length ? ` plus your focus list (${watch.map(esc).join(", ")})` : ""}.
        ${pass} passed the Risk Manager. The agents argue, size and check; you decide. Approval moves paper cash only.</p>
    </div>${gauge(d.regime)}</div>`;
}

function tape(reg) {
  const ticks = reg.rows.map((r, i) => `<div class="tick glass rise" style="--i:${i + 2}">
      <div class="top"><span class="who">${badge(r.symbol, "sm")}<span class="sym">${esc(r.symbol)}</span></span><span class="ch ${dir(r.d1)}">${signed(r.d1, 2, "%")}</span></div>
      <span class="px">${fmt(r.last)}</span>
      <div class="ma"><span>${signed(r.d20, 1, "%")} 20d</span><b class="${r.above50 ? "on" : "off"}">50d</b><b class="${r.above200 ? "on" : "off"}">200d</b></div>
      ${r.spark ? mini(r.spark, i) : ""}</div>`).join("");
  return `<section aria-labelledby="h-tape"><div class="sec-head"><h2 id="h-tape">Market</h2>
    <p>Green chips: price above that moving average. The regime score adds those up and weighs the VIX.</p></div>
    <div class="tape">${ticks}</div></section>`;
}

function team(d) {
  const said = Object.fromEntries(d.log.map((s) => [s.agent, s]));
  const crews = d.team.crews.map((crew, ci) => {
    const members = d.team.agents.filter((a) => a.crew === crew.id).map((a, ai) => {
      const s = said[a.id] || { status: "idle", summary: "Did not run this cycle" };
      return `<article class="agent glass rise ${a.runs_on === "human" ? "human" : ""}" style="--i:${ci + ai}">
        <div class="head"><span class="dot ${esc(s.status)}" title="${esc(s.status)}"></span><span class="name">${esc(a.name)}</span></div>
        <span class="skill">${esc(a.skill)}</span><span class="said">${esc(s.summary)}</span>
        <span class="runs">${esc(a.runs_on)}${s.ms ? " · " + s.ms + " ms" : ""}</span></article>`;
    }).join("");
    return `<div class="crew"><div class="crew-head"><h3><span class="step">0${ci + 1}</span>${esc(crew.name)}</h3><p>${esc(crew.job)}</p></div>${members}</div>`;
  }).join("");
  return `<section aria-labelledby="h-team"><div class="sec-head"><h2 id="h-team">The team</h2><p>${esc(d.team.principle)}</p></div>
    <div class="pulse-line" aria-hidden="true"></div><div class="relay">${crews}</div></section>`;
}

function guide() {
  const steps = [
    ["Is the market with you?", "Check the regime gauge first. Risk off blocks every new long. Neutral means size down or wait for the best ticket only."],
    ["Does the replay give an edge?", "Expectancy above +0.1R is the bar. Target-first odds below stop-first odds mean the edge relies on the open paths: thinner than it looks."],
    ["Who wins the argument?", "Read the bear case first. One hard fact (earnings inside the plan, a broken 200-day, a news shock) outweighs three soft bull points."],
    ["Can you live with the stop?", "Max loss is fixed before entry. If you would move the stop, skip the trade. Then approve with the command, or let it expire."],
  ];
  return `<section aria-labelledby="h-guide"><div class="sec-head"><h2 id="h-guide">How to decide</h2>
    <p>Four questions, in this order. A no at any step ends it.</p></div>
    <div class="guide">${steps.map(([h, p], i) => `<article class="glass rise" style="--i:${i}"><span class="q">Question ${i + 1}</span><h3>${esc(h)}</h3><p>${esc(p)}</p></article>`).join("")}</div></section>`;
}

/* ---------- focus ---------- */

function caseBlock(c) {
  const li = (xs) => xs.map((x) => `<li>${esc(x)}</li>`).join("") || "<li>No case made</li>";
  const by = c.debate.author === "rules" ? "rules (run /trading-desk for Claude's debate)" : c.debate.author;
  return `<div class="case"><div class="b"><h4>Bull</h4><ul>${li(c.debate.bull)}</ul></div>
    <div class="r"><h4>Bear</h4><ul>${li(c.debate.bear)}</ul></div>
    <span class="by">Debate by ${esc(by)} · lean ${esc(c.debate.lean)}</span></div>`;
}

function facts(c, synthetic) {
  const o = c.odds || {}, h = c.history, p = c.plan, pass = c.risk.verdict === "PASS";
  const histLine = !h ? "Focus name: no setup fired, so there is no history replay." : h.fired
    ? `${h.fired} past firings: ${h.target} target first, ${h.stop} stop first, ${h.open} neither` : "This setup never fired in its own history";
  const heads = (c.news || []).slice(0, 4).map((n) => `<li><time>${esc((n.time || "").slice(5, 16).replace("T", " "))}</time><a href="${safeUrl(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a></li>`).join("");
  const cmd = `python desk/cycle.py approve ${c.id}`;
  return `<div class="plan">
      <div><span>entry</span><b>${fmt(p.entry)}</b></div><div><span>stop</span><b class="down">${fmt(p.stop)}</b></div>
      <div><span>target</span><b class="up">${fmt(p.target)}</b></div><div><span>shares</span><b>${c.shares}</b></div></div>
    <div class="odds"><div class="ev"><span class="eyebrow">Expectancy</span><b class="${dir(o.ev_r)}">${signed(o.ev_r)}R</b>
        <span class="muted mono" style="font-size:12px">max loss $${fmt(c.max_loss)}</span></div>
      <div class="bar3" role="img" aria-label="Time Machine: ${pct(o.p_target)} target first, ${pct(o.p_stop)} stop first, ${pct(o.p_open)} still open">
        <i class="t" style="width:${(o.p_target || 0) * 100}%"></i><i class="s" style="width:${(o.p_stop || 0) * 100}%"></i><i class="o" style="width:${(o.p_open || 0) * 100}%"></i></div>
      <div class="row"><span class="up">target first <b>${pct(o.p_target)}</b></span><span class="down">stop first <b>${pct(o.p_stop)}</b></span>
        <span class="muted">open after ${o.horizon ?? "n/a"} sessions <b>${pct(o.p_open)}</b></span></div>
      <div class="row muted">${esc(histLine)}</div></div>
    ${judgeLine(c)}
    ${caseBlock(c)}
    ${heads ? `<ul class="headlines">${heads}</ul>` : ""}
    <div class="verdict">${pass ? `<span class="pill up"><span class="d"></span>risk pass</span>` : `<span class="pill down"><span class="d"></span>risk block</span><ul>${c.risk.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`}
      ${pass && c.status === "awaiting" && !synthetic ? `<div class="cmd"><code>${esc(cmd)}</code><button class="btn" type="button" data-copy="${esc(cmd)}">Copy</button></div>` : ""}</div>`;
}

function statusPill(c) {
  if (c.status === "awaiting") return `<span class="pill warn"><span class="d"></span>your call</span>`;
  if (c.status === "approved") return `<span class="pill info"><span class="d"></span>approved</span>`;
  if (c.status === "rejected") return `<span class="pill">rejected</span>`;
  return `<span class="pill down"><span class="d"></span>blocked</span>`;
}

function focusShell(d) {
  const tabs = d.candidates.map((c) => `<button class="tab" role="tab" type="button" data-sym="${esc(c.symbol)}" aria-selected="false">${esc(c.symbol)}<span class="v">${signed((c.odds || {}).ev_r, 2)}R</span></button>`).join("");
  return `<section aria-labelledby="h-focus"><div class="sec-head"><h2 id="h-focus">Focus</h2>
      <p>Daily candles for the last 120 sessions with the plan drawn on: entry, stop and target, plus the 50-day average.</p></div>
    <div class="tabs" role="tablist" aria-label="Choose a ticket">${tabs}</div>
    <div class="focus glass rise" id="focus"></div></section>`;
}

function renderFocus(sym) {
  const c = DESK.candidates.find((x) => x.symbol === sym) || DESK.candidates[0];
  if (!c) { $("#focus").innerHTML = `<p class="empty" style="margin:20px">No tickets this cycle.</p>`; return; }
  $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.sym === c.symbol)));
  $$(".card").forEach((t) => t.setAttribute("aria-current", String(t.dataset.sym === c.symbol)));
  const last = c.ohlc?.length ? c.ohlc[c.ohlc.length - 1].c : c.plan.entry;
  $("#focus").innerHTML = `<div class="chart-side">
      <div class="f-head">${badge(c.symbol, "lg")}<span class="sym">${esc(c.symbol)}</span><span class="px">${fmt(last)}</span>
        <span class="mono ${dir(c.plan.d1)}">${signed(c.plan.d1, 2, "%")}</span>
        <span class="muted mono" style="font-size:12px">${esc(c.setups.map(setupLabel).join(" · "))} · RSI ${fmt(c.plan.rsi, 0)}</span>${statusPill(c)}</div>
      <div class="chart" id="chart" role="img" aria-label="${esc(c.symbol)} daily candles with entry, stop and target lines"></div>
      <div class="legend-row"><span style="color:var(--ink-2)"><i></i>entry</span><span style="color:var(--down)"><i></i>stop</span><span style="color:var(--up)"><i></i>target</span><span style="color:var(--info)"><i style="border-top-style:solid"></i>50-day average</span></div>
    </div><div class="facts">${facts(c, DESK.meta.synthetic)}</div>`;
  drawChart(c);
  try { if (!location.hash.startsWith("#fund")) history.replaceState(null, "", "#" + c.symbol.replace(/[^A-Za-z0-9-]/g, "")); } catch (_) { /* framed */ }
}

function sma(bars, n) {
  const out = [];
  for (let i = n - 1; i < bars.length; i++) {
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += bars[k].c;
    out.push({ time: bars[i].t, value: +(s / n).toFixed(2) });
  }
  return out;
}

function drawChart(c) {
  const el = $("#chart");
  if (chart) { chart.remove(); chart = null; }
  if (!window.LightweightCharts || !c.ohlc?.length) { el.innerHTML = fallbackSpark(c); return; }
  const LC = window.LightweightCharts;
  chart = LC.createChart(el, {
    autoSize: true,
    layout: { background: { type: "solid", color: "transparent" }, textColor: css("--ink-3"), fontFamily: css("--mono"), fontSize: 11 },
    grid: { vertLines: { visible: false }, horzLines: { color: css("--hair") } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.22 } },
    timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
    crosshair: { mode: 0, vertLine: { color: css("--ink-3"), labelBackgroundColor: css("--ink") }, horzLine: { color: css("--ink-3"), labelBackgroundColor: css("--ink") } },
    handleScroll: false, handleScale: false,
  });
  const up = css("--up"), down = css("--down");
  const candles = chart.addCandlestickSeries({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false, priceLineVisible: false });
  candles.setData(c.ohlc.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c })));
  const vol = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", priceLineVisible: false, lastValueVisible: false });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  vol.setData(c.ohlc.map((b, i) => ({ time: b.t, value: b.v, color: (i && b.c < c.ohlc[i - 1].c ? down : up) + "55" })));
  if (c.ohlc.length >= 50) {
    chart.addLineSeries({ color: css("--info"), lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(sma(c.ohlc, 50));
  }
  const line = (price, color, title) => candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title });
  line(c.plan.target, up, "target");
  line(c.plan.entry, css("--ink-2"), "entry");
  line(c.plan.stop, down, "stop");
  chart.timeScale().fitContent();
}

function fallbackSpark(c) {
  const pts = c.spark || [], W = 600, H = 300;
  if (pts.length < 2) return "";
  const lo = Math.min(...pts, c.plan.stop), hi = Math.max(...pts, c.plan.target);
  const y = (v) => 8 + (1 - (v - lo) / (hi - lo || 1)) * (H - 16);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${((i / (pts.length - 1)) * W).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const lv = (v, color) => `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="${color}" stroke-dasharray="5 4"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="var(--ink)" stroke-width="1.6"/>
    ${lv(c.plan.target, "var(--up)")}${lv(c.plan.entry, "var(--ink-3)")}${lv(c.plan.stop, "var(--down)")}</svg>`;
}

/* ---------- queue, book, ledger ---------- */

function queue(d) {
  if (!d.candidates.length) return `<section><h2>Your queue</h2><p class="empty">No candidates this cycle. The desk does nothing when nothing clears the bar.</p></section>`;
  const cards = d.candidates.map((c, i) => {
    const o = c.odds || {};
    return `<button class="card glass rise" type="button" data-sym="${esc(c.symbol)}" style="--i:${i}" aria-current="false">
      <div class="top">${badge(c.symbol)}<div class="nm"><span class="sym">${esc(c.symbol)}</span><span class="setup">${esc(c.setups.map(setupLabel).join(" · "))}</span></div>${statusPill(c)}</div>
      ${mini(c.spark, i)}
      <div class="stats"><span>target first<b>${pct(o.p_target)}</b></span><span>expectancy<b class="${dir(o.ev_r)}">${signed(o.ev_r)}R</b></span><span>max loss<b>$${fmt(c.max_loss, 0)}</b></span></div>
    </button>`;
  }).join("");
  return `<section aria-labelledby="h-q"><div class="sec-head"><h2 id="h-q">Your queue</h2>
    <p>Every name that reached the desk, passing tickets first. Open one to see its chart, the argument and, if it passed, the approve command.</p></div>
    <div class="queue">${cards}</div></section>`;
}

function equitySvg(eq) {
  if (eq.length < 2) return "";
  const W = 600, H = 90, v = eq.map((e) => e.equity), lo = Math.min(...v), hi = Math.max(...v);
  const pts = v.map((e, i) => [(i / (v.length - 1)) * W, H - 4 - ((e - lo) / (hi - lo || 1)) * (H - 8)]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="90" preserveAspectRatio="none" role="img" aria-label="Paper equity curve">
    <defs><linearGradient id="g-eq" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${css("--up")}" stop-opacity=".35"/><stop offset="1" stop-color="${css("--up")}" stop-opacity="0"/></linearGradient></defs>
    <path d="${d}L${W},${H}L0,${H}Z" fill="url(#g-eq)"/><path d="${d}" fill="none" stroke="var(--up)" stroke-width="2"/></svg>`;
}

function bookAndLedger(d) {
  const b = d.book, cal = d.calibration;
  const equity = b.equity.length ? b.equity[b.equity.length - 1].equity : b.cash;
  const ret = (equity / b.start_cash - 1) * 100;
  const open = b.positions.map((p) => `<tr><td><b>${esc(p.symbol)}</b></td><td class="n">${p.shares}</td><td class="n">${fmt(p.entry)}</td>
    <td class="n">${fmt(p.last ?? p.entry)}</td><td class="n down">${fmt(p.stop)}</td><td class="n up">${fmt(p.target)}</td><td class="n">${pct(p.p_target)}</td><td>${esc(p.opened)}</td></tr>`).join("");
  const closed = b.closed.slice(-8).reverse().map((c) => `<tr><td><b>${esc(c.symbol)}</b></td><td>${esc(c.outcome)}</td>
    <td class="n ${dir(c.pnl)}">${signed(c.pnl)}</td><td class="n">${signed(c.r)}R</td><td class="n">${pct(c.p_target)}</td><td>${esc(c.closed)}</td></tr>`).join("");
  const buckets = cal.buckets.map((k) => `<tr><td>${Math.round(k.from * 100)}–${Math.round(k.from * 100) + 10}%</td><td class="n">${k.n}</td><td class="n">${pct(k.hit_rate)}</td></tr>`).join("");
  return `<div class="split">
    <section class="panel glass" aria-labelledby="h-book"><div class="sec-head"><h2 id="h-book">Paper book</h2><p>Marked on daily closes. Stops and targets fill at their price.</p></div>
      <div class="kpis"><div><span>equity</span><b class="count" data-to="${equity}" data-prefix="$">$${fmt(equity)}</b></div>
        <div><span>since start</span><b class="${dir(ret)}">${signed(ret, 2, "%")}</b></div>
        <div><span>cash</span><b>$${fmt(b.cash)}</b></div><div><span>realized</span><b class="${dir(cal.realized_pnl)}">${signed(cal.realized_pnl)}</b></div></div>
      ${equitySvg(b.equity)}
      ${open ? `<div class="tbl"><table><thead><tr><th>Open</th><th class="n">Sh</th><th class="n">Entry</th><th class="n">Last</th><th class="n">Stop</th><th class="n">Target</th><th class="n">Odds</th><th>Opened</th></tr></thead><tbody>${open}</tbody></table></div>`
        : `<p class="empty">No open paper positions. Approve a ticket to open one.</p>`}
      ${closed ? `<div class="tbl"><table><thead><tr><th>Closed</th><th>Outcome</th><th class="n">P&amp;L</th><th class="n">R</th><th class="n">Odds</th><th>Closed</th></tr></thead><tbody>${closed}</tbody></table></div>` : ""}
    </section>
    <section class="panel glass" aria-labelledby="h-cal"><div class="sec-head"><h2 id="h-cal">Calibration ledger</h2><p>Were the Time Machine's odds any good?</p></div>
      <div class="kpis"><div><span>scored trades</span><b>${cal.n}</b></div><div><span>Brier score</span><b>${cal.brier ?? "n/a"}</b></div></div>
      ${cal.n ? `<div class="tbl"><table><thead><tr><th>Said</th><th class="n">Trades</th><th class="n">Hit target</th></tr></thead><tbody>${buckets}</tbody></table></div>`
        : `<p class="empty">Nothing scored yet. Every closed paper trade scores the odds it opened on. Lower is better; always guessing 50% earns 0.25. Wait for twenty trades before reading anything into it.</p>`}
    </section></div>`;
}

function footer(d) {
  const m = d.meta;
  const ed = d.editorial;
  return `<footer class="glass">${ed ? `<p><span class="pill ${ed.findings.length ? "warn" : "up"}"><span class="d"></span>Editor: ${ed.checked} passages checked, ${ed.findings.length} findings</span></p>` : ""}<p>${esc(m.disclaimer)}</p>
    <p>Sources: ${m.sources.map(esc).join(" · ")}. Generated ${esc(m.generated)}.</p>
    <p>Built on</p><ul>${d.team.lineage.map((l) => `<li><a href="${safeUrl(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a>: ${esc(l.took)}</li>`).join("")}</ul></footer>`;
}

/* ---------- intelligence, strategy, hindsight ---------- */

function bigPicture(intel) {
  if (!intel) return "";
  const cols = intel.sections.map((s, i) => `<article class="intel glass rise" style="--i:${i}">
      <h3>${esc(s.title)}</h3>
      ${s.signals.map((g) => `<div class="sig">
        <p class="what">${esc(g.signal)}</p>
        <p class="so"><b>Reading.</b> ${esc(g.reading)}</p>
        <p class="so"><b>For us.</b> ${esc(g.implication)}</p>
        <p class="src">${/^https?:/.test(g.source) ? `<a href="${safeUrl(g.source)}" target="_blank" rel="noopener">${esc(new URL(g.source).hostname.replace("www.", ""))}</a>` : esc(g.source)} · ${esc(g.confidence)}</p>
      </div>`).join("")}</article>`).join("");
  return `<section aria-labelledby="h-intel"><div class="sec-head"><h2 id="h-intel">Big picture</h2>
      <p>${esc(intel.author)} · as of ${esc(intel.as_of)}</p></div>
    <div class="thesis glass strong rise"><span class="eyebrow">The thesis</span><p>${esc(intel.thesis)}</p>
      <p class="call"><b>Regime call.</b> ${esc(intel.regime_call)}</p></div>
    <div class="intel-grid">${cols}</div>
    ${intel.unverified?.length ? `<p class="muted" style="margin:0;font-size:12.5px">Not yet verified: ${intel.unverified.map(esc).join(" · ")}.</p>` : ""}</section>`;
}

const CALL_CLASS = { bet: "up", wait: "warn", pass: "down", hold: "info" };

function strategy(s, regime) {
  if (!s) return "";
  const li = (xs) => (xs || []).map((x) => `<li>${esc(x)}</li>`).join("");
  const calls = s.calls.map((c, i) => `<article class="callcard glass rise ${esc(c.call)}" style="--i:${i}">
      <div class="top">${badge(c.symbol)}<div class="nm"><span class="sym">${esc(c.symbol)}</span><span class="size mono">${esc(c.size)}</span></div>
        <span class="verdict-word ${CALL_CLASS[c.call] || ""}">${esc(c.call)}</span></div>
      <div class="cols"><div><h4 class="up">Why</h4><ul>${li(c.why)}</ul></div><div><h4 class="down">Risk</h4><ul>${li(c.risk)}</ul></div></div>
      <p class="inv"><b>Exit plan.</b> ${esc(c.exit)}</p></article>`).join("");
  const label = { risk_on: "risk on", neutral: "neutral", risk_off: "risk off" }[regime.label];
  const play = s.playbook.map((p) => `<li class="${p.regime.startsWith(label) ? "now" : ""}"><b>${esc(p.regime)}</b><span>${esc(p.do)}</span></li>`).join("");
  const principles = s.principles.map((p, i) => `<li><span class="n mono">${String(i + 1).padStart(2, "0")}</span><div><b>${esc(p.name)}.</b> ${esc(p.rule)}<span class="lin">${esc(p.lineage)}</span></div></li>`).join("");
  return `<section aria-labelledby="h-strat"><div class="sec-head"><h2 id="h-strat">Strategy and calls</h2>
      <p>${esc(s.author)} · ${esc(s.as_of)} · stance: ${esc(s.stance)}</p></div>
    <div class="thesis glass strong rise"><span class="eyebrow">In one line</span><p>${esc(s.one_line)}</p></div>
    <div class="panel glass"><h3>Opportunities, ranked</h3><ol class="opps">${(s.opportunities || []).map((o) => `<li>
        <span class="rank mono">${Number(o.rank) || ""}</span>
        <div><div class="oh">${badge(o.layer === "Crypto" ? "BTC-USD" : o.layer === "AI chips" ? "NVDA" : o.layer === "Cash" ? "Cash" : o.layer === "Day trading" ? "QQQ" : "SPY", "sm")}<b>${esc(o.what)}</b><span class="pill">${esc(o.layer)}</span></div>
        <p><b>When.</b> ${esc(o.when)}</p><p><b>Why.</b> ${esc(o.why)}</p><p class="math mono">${esc(o.math)}</p></div></li>`).join("")}</ol></div>
    <div class="calls">${calls}</div>
    <div class="split">
      <div class="panel glass"><h3>Principles</h3><ol class="principles">${principles}</ol></div>
      <div class="panel glass"><h3>Playbook by regime</h3><ul class="playbook">${play}</ul>
        <h3 style="margin-top:8px">Research queue</h3><ul class="queue-list">${s.research_queue.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></div>
    </div></section>`;
}

function rBar(v) {
  if (v == null) return `<span class="muted">n/a</span>`;
  const w = Math.min(100, Math.abs(v) / 2 * 100);
  return `<span class="rbar"><i class="${v >= 0 ? "pos" : "neg"}" style="width:${w}%"></i></span><span class="mono ${dir(v)}">${signed(v)}R</span>`;
}

function hindsightSec(h, review) {
  if (!h || !h.n) return "";
  const row = (x) => x ? `${rBar(x.avg_r)} <span class="muted mono">n ${x.n}</span>` : `<span class="muted">none</span>`;
  const table = h.table.map((t) => `<tr><td><b>${esc(setupLabel(t.setup))}</b></td><td>${row(t.all)}</td><td>${row(t.above200)}</td><td>${row(t.below200)}</td></tr>`).join("");
  const pair = (p) => `<li>${badge(p.symbol, "sm")}<b>${esc(p.symbol)}</b> <span class="muted">${esc(setupLabel(p.setup))}</span>${rBar(p.avg_r)}<span class="muted mono">n ${p.n} · ${pct(p.target)} target first</span></li>`;
  return `<section aria-labelledby="h-hind"><div class="sec-head"><h2 id="h-hind">Hindsight</h2>
      <p>Every past firing of every rule on the watchlist, ${esc((h.window || []).join(" to "))}, run with today's plan (1.5 ATR stop, 2R target, ${DESK.meta.config.horizon_sessions} sessions). ${h.n} trades graded.</p></div>
    <div class="split">
      <div class="panel glass"><h3>Average result per rule</h3><div class="tbl"><table>
        <thead><tr><th>Rule</th><th>All</th><th>Market above 200-day</th><th>Market below 200-day</th></tr></thead><tbody>${table}</tbody></table></div></div>
      <div class="panel glass"><h3>Best records</h3><ul class="pairs">${h.best.map(pair).join("")}</ul>
        <h3>Worst records, now blocked</h3><ul class="pairs">${h.worst.map(pair).join("")}</ul></div>
    </div>
    ${review ? `<div class="review">${review.map((q, i) => `<article class="glass rise" style="--i:${i}"><span class="q">${esc(q.question)}</span><p>${esc(q.answer)}</p></article>`).join("")}</div>` : ""}
  </section>`;
}

function books(d) {
  const mine = d.book, his = d.model_book;
  if (!his) return "";
  const eq = (b) => (b.equity.length ? b.equity[b.equity.length - 1].equity : b.cash);
  const ret = (b) => (eq(b) / b.start_cash - 1) * 100;
  const pos = his.positions.map((p) => `<tr><td><b>${esc(p.symbol)}</b></td><td class="n">${p.shares}</td><td class="n">${fmt(p.entry)}</td><td class="n">${fmt(p.last ?? p.entry)}</td><td class="n down">${fmt(p.stop)}</td><td class="n up">${fmt(p.target)}</td><td>${esc(p.why || "")}</td></tr>`).join("");
  const bm = d.benchmark;
  return `<section aria-labelledby="h-books"><div class="sec-head"><h2 id="h-books">Scoreboard</h2>
      <p>Your book, the Strategist's book, and doing nothing. After 20 closed trades, a book that trails SPY shrinks its risk.</p></div>
    <div class="kpis board">
      <div class="glass"><span>your book</span><b class="${dir(ret(mine))}">${signed(ret(mine), 2, "%")}</b><em>${mine.positions.length} open · ${mine.closed.length} closed</em></div>
      <div class="glass"><span>Strategist book</span><b class="${dir(ret(his))}">${signed(ret(his), 2, "%")}</b><em>${his.positions.length} open · ${his.closed.length} closed</em></div>
      <div class="glass"><span>SPY${bm ? " since " + esc(bm.since) : ""}</span><b class="${dir(bm?.return_pct)}">${bm ? signed(bm.return_pct, 2, "%") : "n/a"}</b><em>the do-nothing benchmark</em></div>
    </div>
    ${pos ? `<div class="panel glass"><h3>Strategist positions</h3><div class="tbl"><table><thead><tr><th>Bet</th><th class="n">Sh</th><th class="n">Entry</th><th class="n">Last</th><th class="n">Stop</th><th class="n">Target</th><th>Why</th></tr></thead><tbody>${pos}</tbody></table></div></div>` : ""}
  </section>`;
}

function judgeLine(c) {
  const j = c.judge, r = c.record;
  const parts = [];
  if (j && j.event_risk != null) parts.push(`<span class="pill ${j.event_risk >= 0.7 ? "down" : j.event_risk >= 0.5 ? "warn" : ""}">Clef event risk ${pct(j.event_risk)}</span><span class="pill">headlines ${esc(j.direction || "n/a")}</span>`);
  if (r) parts.push(`<span class="pill ${r.avg_r >= 0 ? "up" : "down"}">record ${signed(r.avg_r)}R over ${r.n}</span>`);
  return parts.length ? `<div class="verdict">${parts.join("")}</div>` : "";
}


/* ---------- markets, arena, day lab, money gate ---------- */

function crossSec(x) {
  if (!x) return "";
  const cls = (st) => st.startsWith("washed") ? "down" : st.includes("uptrend") || st === "trending up" ? "up" : st === "stretched up" ? "warn" : "";
  const layers = x.layers.map((L, li) => `<article class="layer glass rise" style="--i:${li}"><h3>${esc(L.layer)}</h3>
    ${L.assets.map((a, i) => `<div class="asset">
      <div class="row1">${badge(a.symbol, "sm")}<b>${esc(a.label)}</b><span class="mono muted">${esc(a.symbol.replace("-USD", "").replace("^", ""))}</span><span class="mono ${dir(a.d20)}" style="margin-left:auto">${signed(a.d20, 1, "%")}</span></div>
      ${mini(a.spark, li * 3 + i)}
      <div class="row2"><span class="pill ${cls(a.state)}">${esc(a.state)}</span><span class="mono muted">RSI ${Number(a.rsi) || 0} · stretch ${a.stretch == null ? "n/a" : signed(a.stretch, 1) + " sd"}</span></div>
      ${a.base_rate ? `<p class="br">After ${a.base_rate.n} past oversold readings: median ${signed(a.base_rate.median_pct, 1, "%")} over 20 sessions, up ${pct(a.base_rate.win)} of the time</p>` : ""}
    </div>`).join("")}</article>`).join("");
  const links = x.links.map((l) => `<li><b>${esc(l.pair)}</b><span class="mono ${l.corr60 > 0.4 ? "warn" : ""}">${l.corr60 == null ? "n/a" : signed(l.corr60, 2)}</span></li>`).join("");
  return `<section aria-labelledby="h-cross"><div class="sec-head"><h2 id="h-cross">Every market, one lens</h2>
      <p>Trend against the 50 and 200-day averages. Stretch is the 20-session move in units of the asset's own volatility (sd). Base rates come from each asset's own history.</p></div>
    <div class="layers">${layers}</div>
    <div class="panel glass"><h3>How the markets move together (60-day correlation)</h3><ul class="links">${links}</ul></div></section>`;
}

function curveSvg(c, color) {
  const W = 160, H = 40, lo = Math.min(...c), hi = Math.max(...c);
  const d = c.map((v, i) => `${i ? "L" : "M"}${((i / (c.length - 1)) * W).toFixed(1)},${(H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6)).toFixed(1)}`).join("");
  return `<svg class="mini" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path class="ln" d="${d}" style="stroke:${color}"/></svg>`;
}

function arenaSec(a, fwd) {
  if (!a) return "";
  const bench = a.agents.find((x) => x.id === "benchmark")?.stats?.total_pct ?? 0;
  const rows = [...a.agents].sort((x, y) => (y.stats?.sharpe ?? -9) - (x.stats?.sharpe ?? -9)).map((g, i) => {
    const st = g.stats || {}, f = fwd?.summary?.[g.id];
    const holds = Object.entries(g.holds).slice(0, 4).map(([s, w]) => `${esc(s.replace("-USD", ""))} ${Math.round(w * 100)}%`).join(", ") || "all cash";
    const beat = st.total_pct > bench && g.id !== "benchmark";
    return `<tr class="${i === 0 ? "lead" : ""}"><td><b>${esc(g.name)}</b><span class="lin">${esc(g.lineage)}</span></td>
      <td>${curveSvg(g.curve, st.total_pct >= 0 ? "var(--up)" : "var(--down)")}</td>
      <td class="n ${dir(st.total_pct)}">${signed(st.total_pct, 1, "%")}${beat ? ' <span class="pill up">beat SPY</span>' : ""}</td>
      <td class="n">${st.sharpe == null ? "n/a" : Number(st.sharpe)}</td><td class="n down">${Number(st.max_dd_pct)}%</td>
      <td class="n">${a.meta[g.id] ? Math.round(a.meta[g.id] * 100) + "%" : "0%"}</td>
      <td class="n">${f ? signed(f.total_pct, 2, "%") + ` <span class="muted">${f.days}d</span>` : '<span class="muted">starts tomorrow</span>'}</td>
      <td class="holds">${holds}${g.cash > 0.01 && Object.keys(g.holds).length ? ` · cash ${Math.round(g.cash * 100)}%` : ""}</td></tr>`;
  }).join("");
  return `<section aria-labelledby="h-arena"><div class="sec-head"><h2 id="h-arena">Strategy arena</h2>
      <p>Seven agents, one rule each, ${esc(a.window.join(" to "))}, ${a.cost_bps} bps per trade, cash earning ${(a.cash_yield * 100).toFixed(2)}%. Decisions use the close and earn the next day, so nothing sees the future. Meta weight is the self-learning allocator: weight by trailing 60-day Sharpe, capped at 40%.</p></div>
    <div class="panel glass"><div class="tbl"><table class="arena"><thead><tr><th>Agent</th><th>Last year</th><th class="n">Return</th><th class="n">Sharpe</th><th class="n">Worst drop</th><th class="n">Meta weight</th><th class="n">Forward</th><th>Holds for tomorrow</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted" style="margin:0;font-size:12.5px">The stock list is today's large caps, chosen with hindsight, so every backtest here is flattered. The forward column is the honest one: it scores each day's holdings on the next close, from today on.</p></div></section>`;
}

function labSec(lab) {
  if (!lab) return "";
  const cell = (r) => {
    if (!r || !r.n) return `<td class="n muted">none</td>`;
    const t = r.t_stat ?? 0, cls = t >= 2 ? "edge-up" : t <= -2 ? "edge-down" : "";
    return `<td class="n heat ${cls}" style="--h:${Math.min(1, Math.abs(t) / 2.5)}" data-sign="${t >= 0 ? "pos" : "neg"}"><b>${signed(r.avg_bps, 1)}</b> bps<span class="muted"> · t ${signed(t, 2)} · n ${r.n}</span></td>`;
  };
  const rows = lab.symbols.filter((s) => !s.error).map((s) => `<tr><td>${badge(s.symbol, "sm")} <b>${esc(s.symbol)}</b></td>${lab.rules.map((r) => cell(s[r.id])).join("")}</tr>`).join("");
  return `<section aria-labelledby="h-lab"><div class="sec-head"><h2 id="h-lab">Day-trading lab</h2>
      <p>Hourly bars, last 60 sessions to ${esc(lab.through)}, flat by the close, ${lab.cost_bps} bps per side. Average result per trade in basis points. A real edge needs t above 2.</p></div>
    <div class="panel glass"><div class="tbl"><table><thead><tr><th>Symbol</th>${lab.rules.map((r) => `<th class="n">${esc(r.name)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div></div></section>`;
}

function moneyGate(d) {
  const fwdDays = Math.max(0, ...Object.values(d.arena_forward?.summary || {}).map((v) => v.days));
  const items = [
    [fwdDays >= 20, `20 or more forward-tested sessions for the chosen agent (now ${fwdDays})`],
    [false, "Forward result beats SPY after costs over that window"],
    [false, "Worst forward drawdown smaller than the limit you set"],
    [false, "A different model reviews the rule and the code (maker is not the checker)"],
    [false, "You name the amount, the broker and the maximum loss, and place the first order yourself"],
  ];
  return `<section class="gate glass strong" aria-labelledby="h-gate"><div class="sec-head"><h2 id="h-gate">Before real money</h2>
      <p>A strategy earns real money by passing all five, in order. One good day is noise. The desk will not suggest a live order before this list is complete.</p></div>
    <ul>${items.map(([ok, t]) => `<li class="${ok ? "ok" : ""}"><span class="tick-box">${ok ? "&#10003;" : ""}</span>${esc(t)}</li>`).join("")}</ul></section>`;
}


function absorbSec(a) {
  if (!a) return "";
  const cls = { absorb: "up", integrate: "info", learn: "", check: "warn" };
  const rows = a.repos.map((r) => `<tr><td><b>${esc(r.repo)}</b></td><td class="n mono">${(r.stars / 1000).toFixed(1)}k</td>
    <td class="mono">${esc(r.license)}</td><td><span class="pill ${cls[r.verdict] || ""}">${esc(r.verdict)}</span></td>
    <td>${esc(r.take)}</td><td class="muted">${esc(r.status)}: ${esc(r.next)}</td></tr>`).join("");
  return `<section aria-labelledby="h-absorb"><div class="sec-head"><h2 id="h-absorb">Built on, and absorbing next</h2><p>${esc(a.method)}</p></div>
    <div class="panel glass"><div class="tbl"><table><thead><tr><th>Project</th><th class="n">Stars</th><th>License</th><th>Verdict</th><th>What we take</th><th>Status and next step</th></tr></thead><tbody>${rows}</tbody></table></div></div></section>`;
}

function arbSec(a) {
  if (!a) return "";
  const rows = a.routes.filter((r) => r.net_bps != null).map((r) => `<tr><td>${badge(r.asset + "-USD", "sm")} <b>${esc(r.asset)}</b></td>
    <td>buy ${esc(r.buy)} ${fmt(r.ask)}</td><td>sell ${esc(r.sell)} ${fmt(r.bid)}</td>
    <td class="n">${signed(r.gross_bps, 1)} bps</td><td class="n">${Number(r.fees_bps) || 0} bps</td>
    <td class="n ${r.net_bps > 0 ? "up" : "down"}"><b>${signed(r.net_bps, 1)} bps</b></td></tr>`).join("");
  return `<section aria-labelledby="h-arb"><div class="sec-head"><h2 id="h-arb">Arbitrage scout</h2><p>${esc(a.note)}.</p></div>
    <div class="panel glass"><div class="tbl"><table><thead><tr><th>Asset</th><th>Cheapest ask</th><th>Richest bid</th><th class="n">Gross</th><th class="n">Fees</th><th class="n">Net</th></tr></thead><tbody>${rows}</tbody></table></div></div></section>`;
}


/* ---------- funds page ---------- */

function dayBars(vals, days) {
  if (!vals?.length) return "";
  const W = 600, H = 120, mid = H / 2, m = Math.max(0.01, ...vals.map((v) => Math.abs(v)));
  const bw = W / vals.length;
  const bars = vals.map((v, i) => {
    const h = (Math.abs(v) / m) * (mid - 8);
    return `<rect x="${(i * bw + 2).toFixed(1)}" y="${(v >= 0 ? mid - h : mid).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="2" fill="var(${v >= 0 ? "--up" : "--down"})"><title>${esc(days[i] || "")}: ${signed(v, 2, "%")}</title></rect>`;
  }).join("");
  return `<svg class="daybars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Daily result of each decision over the last ${vals.length} sessions">
    <line x1="0" x2="${W}" y1="${mid}" y2="${mid}" stroke="var(--hair)"/>${bars}</svg>
    <div class="axis mono"><span>${esc(days[0] || "")}</span><span>best ${signed(Math.max(...vals), 2, "%")} · worst ${signed(Math.min(...vals), 2, "%")}</span><span>${esc(days[days.length - 1] || "")}</span></div>`;
}

function fundCard(f, a) {
  const st = a?.stats || {};
  const act = f.tomorrow.length ? `${f.tomorrow.length} order${f.tomorrow.length > 1 ? "s" : ""} tomorrow` : "no change tomorrow";
  return `<a class="fundcard glass" href="#fund-${esc(f.id)}"><span class="fmark" aria-hidden="true">${esc(f.fund.split(" ").map((w) => w[0]).join("").slice(0, 2))}</span>
    <b>${esc(f.fund)}</b><span class="muted">${esc(f.style)}</span>
    <span class="mono ${dir(st.total_pct)}">${signed(st.total_pct, 1, "%")} · Sharpe ${st.sharpe == null ? "n/a" : Number(st.sharpe)}</span>
    <span class="pill ${f.tomorrow.length ? "warn" : ""}">${act}</span></a>`;
}

function fundSec(f, a, i) {
  const st = a?.stats || {};
  const orders = f.tomorrow.map((o) => `<li><b>${esc(o.symbol.replace("-USD", ""))}</b> ${Math.round(o.from * 100)}% → ${Math.round(o.to * 100)}% <span class="pill ${o.to > o.from ? "up" : "down"}">${o.to === 0 ? "close" : o.from === 0 ? "open" : o.to > o.from ? "add" : "trim"}</span></li>`).join("");
  const trades = [...f.trades].reverse().map((t) => `<tr><td class="mono">${esc(t.date)}</td><td>${badge(t.symbol, "sm")} <b>${esc(t.symbol.replace("-USD", ""))}</b></td>
    <td><span class="pill ${t.side === "open" || t.side === "buy" ? "up" : "down"}">${esc(t.side)}</span></td>
    <td class="n mono">${signed(t.weight_change * 100, 1)} pts</td><td class="n mono">${Math.round(t.weight * 100)}%</td><td class="n mono">${fmt(t.price)}</td></tr>`).join("");
  return `<section class="fund glass rise" id="fund-${esc(f.id)}" style="--i:${i}" aria-labelledby="h-${esc(f.id)}">
    <div class="fhead"><span class="fmark lg" aria-hidden="true">${esc(f.fund.split(" ").map((w) => w[0]).join("").slice(0, 2))}</span>
      <div><h2 id="h-${esc(f.id)}">${esc(f.fund)}</h2><p class="muted">${esc(f.style)} · ${esc(f.lineage)} · agent: ${esc(f.agent)}</p></div>
      <div class="fstats mono"><span class="${dir(st.total_pct)}">${signed(st.total_pct, 1, "%")} year</span><span>Sharpe ${st.sharpe == null ? "n/a" : Number(st.sharpe)}</span><span class="down">${Number(st.max_dd_pct)}% worst</span></div></div>
    <div class="fgrid">
      <div class="fcol"><h3>How this fund thinks</h3>
        <p><b>Expertise.</b> ${esc(f.expertise)}</p><p><b>Edge.</b> ${esc(f.edge)}</p><p><b>Risk rules.</b> ${esc(f.risk)}</p><p class="warnline"><b>Fails when.</b> ${esc(f.fails_when)}</p>
        <h3>Workflow</h3><ol class="wf">${f.workflow.map((w) => `<li>${esc(w)}</li>`).join("")}</ol></div>
      <div class="fcol"><h3>Last ${f.daily.length} sessions</h3>${dayBars(f.daily, f.days)}
        <h3>Tomorrow's decision</h3>${orders ? `<ul class="orders">${orders}</ul>` : `<p class="muted">Holds its current positions; no order.</p>`}
        <h3>Coach</h3><ul class="coach">${f.coaching.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>
    </div>
    <details><summary>${f.trades.length} trades in the last ${f.daily.length} sessions</summary>
      ${trades ? `<div class="tbl"><table><thead><tr><th>Date</th><th>Asset</th><th>Action</th><th class="n">Change</th><th class="n">New weight</th><th class="n">Price</th></tr></thead><tbody>${trades}</tbody></table></div>` : `<p class="muted">No trades: the fund held its positions.</p>`}</details>
  </section>`;
}

function fundsPage(d) {
  const a = d.arena;
  if (!a?.funds) return statusBar(d) + `<p class="empty">No fund data in this cycle.</p>`;
  const byId = Object.fromEntries(a.agents.map((x) => [x.id, x]));
  const ranked = [...a.funds].sort((x, y) => (byId[y.id]?.stats?.sharpe ?? -9) - (byId[x.id]?.stats?.sharpe ?? -9));
  return statusBar(d) + `<section class="thesis glass strong rise"><span class="eyebrow">Funds</span>
      <p>Seven funds, one strategy each, all run on the same data with ${a.cost_bps} bps costs. Each shows how it thinks, every trade of the last ${ranked[0].daily.length} sessions, what it does tomorrow, and what its own record says it should change. Ranked by Sharpe over ${esc(a.window.join(" to "))}.</p></section>
    <div class="fundcards">${ranked.map((f) => fundCard(f, byId[f.id])).join("")}</div>
    ${ranked.map((f, i) => fundSec(f, byId[f.id], i)).join("")}` + footer(d);
}

/* ---------- motion and wiring ---------- */

function countUp() {
  if (reduced) return;
  $$(".count").forEach((el) => {
    const to = +el.dataset.to, prefix = el.dataset.prefix || "", t0 = performance.now(), dur = 800;
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = prefix + fmt(to * e);
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function sheen() {
  if (reduced || matchMedia("(hover: none)").matches) return;
  document.addEventListener("pointermove", (e) => {
    const g = e.target.closest(".glass");
    if (!g) return;
    const r = g.getBoundingClientRect();
    g.style.setProperty("--mx", `${e.clientX - r.left}px`);
    g.style.setProperty("--my", `${e.clientY - r.top}px`);
  }, { passive: true });
}

function render(d) {
  DESK = d;
  if (location.hash.startsWith("#fund")) {
    if (chart) { chart.remove(); chart = null; }
    $("#app").innerHTML = fundsPage(d);
    document.title = "Funds · " + d.meta.as_of;
    const target = location.hash.length > 6 && document.getElementById(location.hash.slice(1));
    if (target) target.scrollIntoView({ block: "start" });
    countUp();
    return;
  }
  $("#app").innerHTML = statusBar(d) + briefSec(d.strategy) + hero(d) + strategy(d.strategy, d.regime) + bigPicture(d.intel) + crossSec(d.cross) + arenaSec(d.arena, d.arena_forward) + labSec(d.daylab) + arbSec(d.arbitrage) + moneyGate(d)
    + tape(d.regime) + team(d) + guide() + focusShell(d) + queue(d) + books(d) + hindsightSec(d.hindsight, d.strategy?.decision_review)
    + bookAndLedger(d) + absorbSec(d.absorb) + footer(d);
  document.title = `Desk · ${d.regime.label.replace("_", " ")} · ${d.meta.as_of}`;
  const wanted = (location.hash || "").slice(1).toUpperCase();
  const first = d.candidates.find((c) => c.symbol.toUpperCase() === wanted) || d.candidates.find((c) => c.risk.verdict === "PASS") || d.candidates[0];
  if (first) renderFocus(first.symbol); else renderFocus(null);
  requestAnimationFrame(() => $$(".needle").forEach((n) => { n.style.transform = `rotate(${n.dataset.angle}deg)`; }));
  countUp();
}

document.addEventListener("click", async (e) => {
  const pick = e.target.closest("[data-sym]");
  if (pick && !e.target.closest("[data-copy]")) {
    renderFocus(pick.dataset.sym);
    if (pick.classList.contains("card")) $("#h-focus").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    return;
  }
  const btn = e.target.closest("button[data-copy]");
  if (!btn) return;
  try { await navigator.clipboard.writeText(btn.dataset.copy); btn.textContent = "Copied"; }
  catch (_) { getSelection().selectAllChildren(btn.previousElementSibling); btn.textContent = "Selected"; }
  setTimeout(() => { btn.textContent = "Copy"; }, 1600);
});

let lastView = "";
addEventListener("hashchange", () => {
  const view = location.hash.startsWith("#fund") ? "funds" : "desk";
  if (DESK && (view !== lastView || location.hash === "#desk" || location.hash === "#funds")) { lastView = view; render(DESK); scrollTo(0, 0); }
  else if (view === "funds") { const t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView({ block: "start" }); }
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (DESK) render(DESK); });
sheen();
load().then(render).catch((err) => { $("#app").innerHTML = `<p class="empty">${esc(err.message)}</p>`; });

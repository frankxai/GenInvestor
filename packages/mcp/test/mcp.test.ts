import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FixtureProvider, loadPolicyTable } from "../../core/src/index.ts";
import type { PolicyTable, SeriesPayload } from "../../core/src/index.ts";
import { createServer, SUPPORTED_PROTOCOLS } from "../src/server.ts";
import { buildTools, INSTRUCTIONS } from "../src/tools.ts";

const table = loadPolicyTable();
const series = (id: string, prior: number, latest: number): SeriesPayload => ({
  series: id, label: id, unit: "USD", observations: [], latest: { date: "2026-09-29", value: latest }, prior: { date: "2026-09-28", value: prior },
});

function make(over: { table?: PolicyTable } = {}) {
  const home = mkdtempSync(join(tmpdir(), "gi-mcp-"));
  const provider = new FixtureProvider("ecb-fixture", { "EXR.USD": series("EXR.USD", 1.1378, 1.1355), "EST.ESTR": series("EST.ESTR", 2.44, 2.44), "ICP.HICP_ANR": series("ICP.HICP_ANR", 2, 1.9), "FM.DFR": series("FM.DFR", 2.25, 2.5) });
  const tools = buildTools({ home, table: over.table ?? table, provider, now: () => new Date("2026-09-30T06:00:00Z") });
  const server = createServer({ name: "geninvestor", title: "GenInvestor", version: "0.1.0", instructions: INSTRUCTIONS, tools });
  let id = 0;
  const rpc = async (method: string, params?: unknown) => {
    const reply = await server.handle(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }));
    return JSON.parse(reply as string) as { result?: any; error?: { code: number; message: string } };
  };
  return { home, server, rpc, tools };
}

test("initialize negotiates a supported protocol version and states the no-advice stance", async () => {
  const { rpc } = make();
  const ok = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(ok.result.protocolVersion, "2025-03-26");
  assert.equal(ok.result.serverInfo.name, "geninvestor");
  assert.match(ok.result.instructions, /Information, not advice/);
  const fallback = await rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(fallback.result.protocolVersion, SUPPORTED_PROTOCOLS[0]);
});

test("tools are refused before initialize, unknown methods and bad JSON get proper JSON-RPC errors", async () => {
  const { rpc, server } = make();
  assert.equal((await rpc("tools/list")).error?.code, -32002);
  await rpc("initialize", {});
  assert.equal((await rpc("nope")).error?.code, -32601);
  assert.equal(JSON.parse((await server.handle("{not json")) as string).error.code, -32700);
  assert.equal(JSON.parse((await server.handle("[]")) as string).error.code, -32600);
  assert.equal(await server.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })), null, "notifications get no reply");
  assert.deepEqual((await rpc("ping")).result, {});
});

test("tools/list exposes read-only evidence tools and no tool can approve, sign, trade or move money", async () => {
  const { rpc } = make();
  await rpc("initialize", {});
  const { tools } = (await rpc("tools/list")).result as { tools: { name: string; annotations: any; inputSchema: any }[] };
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_action", "explain_claim", "get_latest_brief", "run_today", "verify_ledger"]);
  for (const t of tools) {
    assert.equal(t.annotations.destructiveHint, false, t.name);
    assert.equal(t.inputSchema.type, "object");
  }
  const forbidden = /approve|trade|order|transfer|sign|withdraw|buy|sell|execute/i;
  assert.ok(tools.every((t) => !forbidden.test(t.name)), "no tool name suggests a state-changing financial action");
  assert.deepEqual(tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name), ["run_today"]);
});

test("invalid tool arguments are rejected with the schema error before the handler runs", async () => {
  const { rpc } = make();
  await rpc("initialize", {});
  const missing = await rpc("tools/call", { name: "check_action", arguments: {} });
  assert.equal(missing.error?.code, -32602);
  assert.match(missing.error?.message ?? "", /missing required "action_type"/);
  const extra = await rpc("tools/call", { name: "verify_ledger", arguments: { surprise: 1 } });
  assert.match(extra.error?.message ?? "", /unexpected property/);
  assert.equal((await rpc("tools/call", { name: "ghost", arguments: {} })).error?.code, -32602);
});

test("check_action answers exactly as the shared gate table says", async () => {
  const { rpc } = make();
  await rpc("initialize", {});
  for (const c of table.cases) {
    const r = await rpc("tools/call", { name: "check_action", arguments: c.action });
    if (c.action.action_type === "") {
      // the gate fails closed on an empty verb; the tool schema is stricter and refuses it as malformed input
      assert.equal(r.error?.code, -32602, c.id);
      continue;
    }
    assert.ok(r.result, `${c.id}: ${JSON.stringify(r.error)}`);
    assert.equal(r.result.structuredContent.verdict, c.expect, c.id);
  }
});

test("run_today publishes a brief, then get_latest_brief, explain_claim and verify_ledger work off the same home", async () => {
  const { rpc, home } = make();
  await rpc("initialize", {});
  const run = await rpc("tools/call", { name: "run_today", arguments: {} });
  assert.equal(run.result.isError, false, run.result.content[0].text);
  assert.equal(run.result.structuredContent.status, "completed");
  assert.match(run.result.content[0].text, /Information, not advice/);

  const brief = await rpc("tools/call", { name: "get_latest_brief", arguments: {} });
  assert.match(brief.result.content[0].text, /# Today, 2026-09-29/);
  const claimId = brief.result.structuredContent.lines[0].claimIds[0] as string;

  const why = await rpc("tools/call", { name: "explain_claim", arguments: { claim_id: claimId } });
  assert.equal(why.result.isError, false);
  assert.match(why.result.content[0].text, /source ecb-fixture/);
  assert.match(why.result.content[0].text, /sha256 [0-9a-f]{64}/);

  const missing = await rpc("tools/call", { name: "explain_claim", arguments: { claim_id: "deadbeef" } });
  assert.equal(missing.result.isError, true);

  assert.equal((await rpc("tools/call", { name: "verify_ledger", arguments: {} })).result.structuredContent.ok, true);
  assert.ok(readFileSync(join(home, "briefs", "brief.json"), "utf8").includes("disclosure"));
});

test("get_latest_brief before any run says so instead of inventing content", async () => {
  const { rpc } = make();
  await rpc("initialize", {});
  const r = await rpc("tools/call", { name: "get_latest_brief", arguments: {} });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /No brief has been published/);
});

test("if the gate stops allowing research, every tool refuses instead of carrying on", async () => {
  const closed: PolicyTable = { ...table, allowedByMode: { ...table.allowedByMode, [table.ceiling]: [] } };
  const { rpc } = make({ table: closed });
  await rpc("initialize", {});
  for (const name of ["check_action", "verify_ledger", "get_latest_brief", "run_today"]) {
    const r = await rpc("tools/call", { name, arguments: name === "check_action" ? { action_type: "research" } : {} });
    assert.equal(r.result.isError, true, name);
    assert.match(r.result.content[0].text, /human_gate|blocked/, name);
  }
});

test("a real subprocess speaks the protocol over stdio and keeps stdout clean", async () => {
  const bin = fileURLToPath(new URL("../bin/geninvestor-mcp.ts", import.meta.url));
  const home = mkdtempSync(join(tmpdir(), "gi-mcp-proc-"));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "--home", home], { stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  const send = (o: unknown) => child.stdin.write(`${JSON.stringify(o)}\n`);
  const waitFor = async (n: number) => {
    for (let t = 0; t < 200 && lines.length < n; t++) await new Promise((r) => setTimeout(r, 25));
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check_action", arguments: { action_type: "live_trade" } } });
  await waitFor(2);
  child.stdin.end();
  await new Promise((r) => child.on("close", r));
  assert.equal(lines.length, 2, "one reply per request, none for the notification");
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), "every stdout line is JSON");
  assert.equal(JSON.parse(lines[1] as string).result.structuredContent.verdict, "human_gate");
});

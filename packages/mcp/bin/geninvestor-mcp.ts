#!/usr/bin/env node
import { join } from "node:path";
import { loadPolicyTable } from "../../core/src/index.ts";
import { createServer, serveStdio } from "../src/server.ts";
import { buildTools, INSTRUCTIONS } from "../src/tools.ts";

const args = process.argv.slice(2);
const homeFlag = args.indexOf("--home");
const home = homeFlag >= 0 ? (args[homeFlag + 1] as string) : (process.env.GENINVESTOR_HOME ?? join(process.cwd(), ".geninvestor"));

const server = createServer({
  name: "geninvestor",
  title: "GenInvestor",
  version: "0.1.0",
  instructions: INSTRUCTIONS,
  tools: buildTools({ home, table: loadPolicyTable() }),
});

process.stderr.write(`geninvestor-mcp ready (home: ${home})\n`);
await serveStdio(server);

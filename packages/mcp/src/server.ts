// Minimal MCP server core: JSON-RPC 2.0 over newline-delimited stdio, tools only.
// Zero dependencies on purpose, so the same file runs in a local kit, a container or a worker.
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { validate } from "../../contracts/src/validate.ts";
import type { Schema } from "../../contracts/src/validate.ts";

export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolResult {
  text: string;
  structured?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
}

export interface ServerOptions {
  name: string;
  title: string;
  version: string;
  instructions: string;
  tools: ToolDef[];
}

type Json = Record<string, unknown>;

const err = (id: unknown, code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
const ok = (id: unknown, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });

export function createServer(options: ServerOptions) {
  const tools = new Map(options.tools.map((t) => [t.name, t]));
  if (tools.size !== options.tools.length) throw new Error("Duplicate tool names");
  let initialized = false;

  /** Handle one incoming line. Returns the response line, or null for notifications. */
  async function handle(line: string): Promise<string | null> {
    let msg: Json;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return err(null, -32600, "Invalid Request: batches and non-objects are not supported");
      msg = parsed as Json;
    } catch {
      return err(null, -32700, "Parse error");
    }

    const hasId = "id" in msg;
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return hasId ? err(msg.id, -32600, "Invalid Request") : null;
    if (!hasId) return null; // notifications (initialized, cancelled, ...) need no reply

    const id = msg.id;
    const params = (msg.params ?? {}) as Json;

    switch (msg.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        initialized = true;
        return ok(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.name, title: options.title, version: options.version },
          instructions: options.instructions,
        });
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        if (!initialized) return err(id, -32002, "Server not initialized");
        return ok(id, {
          tools: options.tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
        });
      case "tools/call": {
        if (!initialized) return err(id, -32002, "Server not initialized");
        const tool = typeof params.name === "string" ? tools.get(params.name) : undefined;
        if (!tool) return err(id, -32602, `Unknown tool: ${String(params.name)}`);
        const args = (params.arguments ?? {}) as Json;
        const problems = validate(tool.inputSchema, args);
        if (problems.length > 0) return err(id, -32602, `Invalid arguments for ${tool.name}: ${problems.join("; ")}`);
        try {
          const result = await tool.handler(args);
          return ok(id, {
            content: [{ type: "text", text: result.text }],
            ...(result.structured ? { structuredContent: result.structured } : {}),
            isError: result.isError ?? false,
          });
        } catch (error) {
          return ok(id, { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
        }
      }
      default:
        return err(id, -32601, `Method not found: ${msg.method}`);
    }
  }

  return { handle };
}

/** Serve over stdio. stdout carries protocol messages only; diagnostics go to stderr. */
export function serveStdio(server: ReturnType<typeof createServer>, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let chain: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      const reply = await server.handle(line);
      if (reply !== null) output.write(`${reply}\n`);
    });
  });
  return new Promise((resolve) => rl.on("close", () => chain.then(resolve)));
}

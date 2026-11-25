import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { TOOL_DEFS, type ToolResult } from "./tools.js";

/**
 * Minimal MCP stdio server. It runs as a child of the agent CLI and forwards every tool call
 * to the main tryrepo process over the loopback bridge. Nothing but JSON-RPC goes to stdout.
 */

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const FALLBACK_PROTOCOL = "2025-06-18";

export class BridgeClient {
  private socket?: Socket;
  private connecting?: Promise<Socket>;
  private nextId = 1;
  private readonly pending = new Map<number, (r: ToolResult) => void>();
  private buffer = "";

  constructor(
    private readonly port: number,
    private readonly token: string,
  ) {}

  private getSocket(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<Socket>((resolve, reject) => {
      const s = connect({ host: "127.0.0.1", port: this.port });
      s.setEncoding("utf8");
      s.once("connect", () => {
        this.socket = s;
        this.connecting = undefined;
        resolve(s);
      });
      s.once("error", (err) => {
        this.connecting = undefined;
        reject(err);
      });
      s.on("data", (chunk: string) => this.onData(chunk));
      s.on("close", () => {
        for (const [, done] of this.pending) done({ text: "tryrepo: lost connection to the main process", isError: true });
        this.pending.clear();
      });
    });
    return this.connecting;
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      try {
        const msg = JSON.parse(line) as { id: number; text: string; isError: boolean };
        const done = this.pending.get(msg.id);
        if (done) {
          this.pending.delete(msg.id);
          done({ text: String(msg.text ?? ""), isError: msg.isError === true });
        }
      } catch {
        /* ignore malformed lines */
      }
    }
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    let socket: Socket;
    try {
      socket = await this.getSocket();
    } catch (err) {
      return { text: `tryrepo: cannot reach the main process (${(err as Error).message})`, isError: true };
    }
    const id = this.nextId++;
    return new Promise<ToolResult>((resolve) => {
      this.pending.set(id, resolve);
      socket.write(`${JSON.stringify({ token: this.token, id, name, args })}\n`);
    });
  }

  close() {
    this.socket?.destroy();
  }
}

export function handleMessage(
  msg: JsonRpcMessage,
  callTool: (name: string, args: unknown) => Promise<ToolResult>,
  version: string,
): Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined {
  // Notifications (no id) never get a response.
  if (msg.id === undefined || msg.id === null) return undefined;
  const id = msg.id;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      return reply({
        protocolVersion: typeof requested === "string" && requested ? requested : FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "tryrepo", version },
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOL_DEFS });
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (typeof name !== "string") {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: "tools/call requires a tool name" } };
      }
      return callTool(name, args).then((r) => reply({ content: [{ type: "text", text: r.text }], isError: r.isError }));
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(msg.method)}` } };
  }
}

export function runMcpProxy(port: number, token: string, version: string): void {
  const client = new BridgeClient(port, token);
  const write = (obj: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let open = 0;
  let inputClosed = false;
  const maybeExit = () => {
    if (inputClosed && open === 0) {
      client.close();
      process.exit(0);
    }
  };
  const handle = (msg: JsonRpcMessage) => {
    const out = handleMessage(msg, (n, a) => client.call(n, a), version);
    if (out instanceof Promise) {
      open++;
      out
        .then((r) => r && write(r))
        .catch((err: Error) => write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err.message } }))
        .finally(() => {
          open--;
          maybeExit();
        });
    } else if (out) {
      write(out);
    }
  };
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      if (m && typeof m === "object") handle(m as JsonRpcMessage);
    }
  });
  rl.on("close", () => {
    inputClosed = true;
    maybeExit();
  });
}

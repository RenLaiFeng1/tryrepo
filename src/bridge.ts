import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";
import type { ToolResult } from "./tools.js";

/**
 * Loopback channel between the MCP proxy process (spawned by the agent CLI) and the main
 * tryrepo process, which owns the sandbox and all state. Newline-delimited JSON, token-checked.
 */
export interface Bridge {
  port: number;
  token: string;
  close(): Promise<void>;
}

export type BridgeHandler = (name: string, args: unknown) => Promise<ToolResult>;

const MAX_LINE = 32 * 1024 * 1024;

function tokenMatches(expected: Buffer, got: unknown): boolean {
  if (typeof got !== "string") return false;
  const buf = Buffer.from(got, "utf8");
  return buf.length === expected.length && timingSafeEqual(buf, expected);
}

export function startBridge(handler: BridgeHandler): Promise<Bridge> {
  const token = randomBytes(24).toString("hex");
  const expected = Buffer.from(token, "utf8");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) {
        socket.destroy();
        return;
      }
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) void handleLine(socket, line);
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });

  async function handleLine(socket: Socket, line: string) {
    let msg: { token?: unknown; id?: unknown; name?: unknown; args?: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      socket.destroy();
      return;
    }
    if (!tokenMatches(expected, msg.token)) {
      socket.destroy();
      return;
    }
    let result: ToolResult;
    try {
      result = await handler(typeof msg.name === "string" ? msg.name : "", msg.args);
    } catch (err) {
      result = { text: `tryrepo bridge error: ${(err as Error).message}`, isError: true };
    }
    if (!socket.destroyed) socket.write(`${JSON.stringify({ id: msg.id, ...result })}\n`);
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("bridge failed to listen"));
        return;
      }
      resolve({
        port: addr.port,
        token,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

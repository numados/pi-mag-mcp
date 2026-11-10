/**
 * Generic stdio MCP child client: spawn -> initialize handshake -> tools/call,
 * JSON-RPC over stdio, per-call timeout, resynchronised after the child exits.
 *
 * Used by the two providers that are themselves MCP servers (auggie, serena).
 * Unlike subprocess.ts this child inherits the environment: those CLIs
 * authenticate through it (tokens, subscription cache), and the search side
 * cannot know which variables they need.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

interface MCPResponse {
  jsonrpc: string;
  id?: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export class McpChildClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready = false;
  private startPromise: Promise<void> | null = null;
  private readonly label: string;

  constructor(
    private readonly cmd: string,
    private readonly args: string[],
    private readonly cwd?: string,
    private readonly callTimeoutMs = 90_000,
    clientName = "search-mcp",
  ) {
    this.label = `${cmd} (${clientName})`;
  }

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    this.kill();
    const proc = spawn(this.cmd, this.args, {
      ...(this.cwd ? { cwd: this.cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.proc = proc;

    if (proc.stdout) {
      const lines = createInterface({ input: proc.stdout });
      lines.on("line", (line: string) => {
        let message: MCPResponse;
        try {
          message = JSON.parse(line) as MCPResponse;
        } catch {
          return; // non-JSON noise on the child's stdout is ignored
        }
        if (message.id === undefined) return;
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${this.label} error: ${message.error.message}`));
        else entry.resolve(message.result);
      });
    }

    // Drain the child's stderr so a chatty CLI cannot block on a full pipe.
    proc.stderr?.on("data", () => undefined);

    proc.on("exit", (code) => {
      this.ready = false;
      const error = new Error(`${this.label} exited (code ${code})`);
      for (const [, entry] of this.pending) entry.reject(error);
      this.pending.clear();
    });

    try {
      await this.send(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "search-mcp", version: "0.1.0" },
        },
        20_000,
      );
    } catch (error) {
      this.kill();
      throw new Error(`failed to initialize ${this.label}: ${(error as Error).message}`);
    }
    this.notify("notifications/initialized");
    this.ready = true;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    await this.start();
    return this.send("tools/call", { name, arguments: args }, this.callTimeoutMs);
  }

  kill(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.ready = false;
  }

  private send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    const proc = this.proc;
    if (!proc?.stdin) return Promise.reject(new Error(`${this.label} is not running`));

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        reject(error as Error);
        return;
      }
      setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.reject(new Error(`${this.label} call timed out (${timeoutMs}ms)`));
      }, timeoutMs);
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    const stdin = this.proc?.stdin;
    if (!stdin) return;
    try {
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // the child is dying; the next call reports it
    }
  }
}

/** Extract plausible file paths from free text (MCP tool text results). */
export function extractPaths(text: string, max = 30): string[] {
  const pattern = /(?:\/[\w.\-]+){2,}\.[A-Za-z0-9]+|~\/[\w.\-/]+\.[A-Za-z0-9]+/g;
  const out: string[] = [];
  for (const match of text.matchAll(pattern)) {
    if (!out.includes(match[0])) out.push(match[0]);
    if (out.length >= max) break;
  }
  return out;
}

/** MCP CallToolResult -> the text content blocks joined. */
export function resultText(result: any): string {
  if (!result?.content) return result ? JSON.stringify(result) : "";
  return result.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

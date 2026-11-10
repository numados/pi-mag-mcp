/**
 * Bounded subprocess execution for the search providers.
 *
 * Rules this module owns:
 * - no shell: every argument is a literal argv entry, so a query containing
 *   spaces, quotes or `; rm -rf` can never become a command;
 * - it never throws for a failed child: the caller inspects `code` (0 = ok,
 *   1 = "no matches" for rg/fd, -1 = spawn failure or timeout), which is what
 *   every provider already branches on;
 * - a timeout kills the child instead of leaving it running;
 * - output is byte-capped so one pathological match cannot flood the host.
 *
 * The environment is inherited on purpose: rg/fd/ast-grep read their own
 * configuration through it (RIPGREP_CONFIG_PATH and friends), and the child's
 * output already goes back to the same agent. Credential-bearing MCP children
 * (auggie, serena) are spawned separately in providers/mcpchild.ts.
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Exit code; -1 when the child could not be spawned or was killed on timeout. */
  code: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8_000_000;

export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;

    const child = spawn(cmd, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });

    const settle = (code: number, extraStderr = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: extraStderr ? `${stderr}${extraStderr}` : stderr, code });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(-1, `\n[timeout after ${timeoutMs}ms]`);
    }, timeoutMs);

    const collect = (chunk: Buffer, target: "stdout" | "stderr"): void => {
      const text = chunk.toString();
      bytes += Buffer.byteLength(text);
      if (target === "stdout") stdout += text;
      else stderr += text;
      if (bytes > maxOutputBytes) {
        child.kill("SIGKILL");
        settle(-1, `\n[output over ${maxOutputBytes} bytes, call aborted]`);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.on("error", (error) => settle(-1, `\n${String(error)}`));
    child.on("close", (code) => settle(code ?? -1));
  });
}

/**
 * Resolve an executable on PATH without spawning it. Used by the doctor report
 * and by probes for binaries that could hang on `--version`.
 */
export function findOnPath(cmd: string): string | null {
  if (cmd.includes("/")) {
    try {
      accessSync(cmd, constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  const path = process.env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

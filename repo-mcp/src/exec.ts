import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { accessSync, constants, existsSync } from "node:fs";

const signals = new AsyncLocalStorage<AbortSignal | undefined>();
// Carry the MCP cancellation scope through every preflight and dry-run call.
export function withGitSignal<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  return signals.run(signal, run);
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
  aborted: boolean;
  spawnError?: string;
}
export interface GitOpts {
  cwd: string;
  args: string[];
  signal?: AbortSignal | undefined;
  maxOutput?: number;
  /** Optional fixed input for plumbing commands such as cat-file --batch-check. */
  stdin?: string | undefined;
}
export const MAX_OUTPUT = 1_000_000;
export const GIT_INSTALL_HINT = "brew install git  # or on macOS: xcode-select --install";
export const GH_INSTALL_HINT = "brew install gh && gh auth login  # gh not required by repo-mcp tools, listed for future GitHub integration";

export function redact(s: string): string {
  return (s || "")
    .replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s\/@:'"]{1,64}:[^\s\/@:'"]{1,256}@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|access_token|private_token|pat|password|apikey|api_key|secret)=)[^\s&"']{1,256}/gi, "$1[redacted]")
    .replace(/\b(?:ghp_[A-Za-z0-9]{20,64}|gho_[A-Za-z0-9]{20,64}|ghu_[A-Za-z0-9]{20,64}|ghs_[A-Za-z0-9]{20,64}|glpat-[A-Za-z0-9_-]{10,64}|xox[baprs]-[A-Za-z0-9-]{10,64})\b/g, "[redacted]");
}

function cancelled(): GitResult {
  return { stdout: "", stderr: "cancelled", code: 1, truncated: false, aborted: true };
}

async function runGit(opts: GitOpts): Promise<GitResult> {
  if (opts.signal?.aborted) return cancelled();
  const max = opts.maxOutput ?? MAX_OUTPUT;
  return new Promise((resolve) => {
    const grouped = process.platform !== "win32";
    const proc = spawn("git", opts.args, {
      shell: false, detached: grouped, cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    let aborted = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Drain output beyond the cap. Killing a noisy mutation would leave its
    // result ambiguous; only cancellation terminates the process.
    const cap = (chunk: Buffer, cur: Buffer): Buffer => {
      const remaining = max - cur.length;
      if (chunk.length > remaining) truncated = true;
      return remaining > 0 ? Buffer.concat([cur, chunk.subarray(0, remaining)]) : cur;
    };
    proc.stdout.on("data", (d: Buffer) => { stdout = cap(d, stdout); });
    proc.stderr.on("data", (d: Buffer) => { stderr = cap(d, stderr); });
    proc.stdin.on("error", () => {});
    proc.stdin.end(opts.stdin ?? "");
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (grouped && proc.pid) process.kill(-proc.pid, sig);
        else proc.kill(sig);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") proc.kill(sig);
      }
    };
    const abort = () => {
      if (settled || aborted) return;
      aborted = true;
      kill("SIGTERM");
      timer = setTimeout(() => { if (!settled) kill("SIGKILL"); }, 5000);
      timer.unref();
    };
    const finish = (code: number, spawnError?: string, err?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      // A child can close its pipes before a descendant exits. Clean up the
      // remaining process group on cancellation, even after Git itself exits.
      if (aborted) kill("SIGKILL");
      resolve({ stdout: redact(stdout.toString()), stderr: redact(err || stderr.toString()),
        code, truncated, aborted, ...(spawnError ? { spawnError } : {}) });
    };
    proc.on("close", (code) => finish(code ?? 1));
    proc.on("error", (err: NodeJS.ErrnoException) => finish(1, err.code,
      err.code === "ENOENT" ? `git missing — ${GIT_INSTALL_HINT}` : err.message));
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
  });
}
export type GitRunner = typeof runGit;
let activeRunner: GitRunner = runGit;
export function setGitRunner(r: GitRunner | null): void { activeRunner = r ?? runGit; }
export async function git(opts: GitOpts): Promise<GitResult> {
  opts = { ...opts, signal: opts.signal ?? signals.getStore() };
  if (opts.signal?.aborted) return cancelled();
  const r = await activeRunner(opts);
  if (r.spawnError === "ENOENT") r.stderr = `git missing — ${GIT_INSTALL_HINT}`;
  return r;
}
export function lookupCommand(command: string): string | null {
  if (command.includes("/")) return command;
  for (const dir of (process.env.PATH || "").split(":").filter(Boolean)) {
    const p = `${dir}/${command}`;
    try { accessSync(p, constants.X_OK); if (existsSync(p)) return p; } catch {}
  }
  return null;
}

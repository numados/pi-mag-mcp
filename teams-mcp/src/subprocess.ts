/**
 * Argv-only subprocess execution for the local PDF toolchain.
 *
 * Rules this module owns, so no caller restates them:
 * - no shell: every argument is passed literally, so a filename containing
 *   spaces, quotes or `; rm -rf` cannot become a command;
 * - the child sees an allowlisted environment, never Confluence/Teams secrets;
 * - output is byte-capped and the whole process group is terminated on timeout
 *   or cancellation, so OCR/ImageMagick descendants cannot outlive the call.
 */
import { spawn } from "node:child_process";
import { LIMITS } from "./contract.js";

export type SubprocessFailureKind = "timeout" | "cancelled" | "not-found" | "output-overflow" | "exit";

export class SubprocessError extends Error {
  readonly kind: SubprocessFailureKind;
  readonly stderr: string;
  constructor(kind: SubprocessFailureKind, message: string, stderr = "") {
    super(message);
    this.name = "SubprocessError";
    this.kind = kind;
    this.stderr = stderr;
  }
}

/**
 * Environment variables a local media tool may need. Everything else — tokens,
 * API keys, e-mail addresses — is withheld from the child.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TESSDATA_PREFIX",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
] as const;

/** Build a child environment from an allowlist instead of inheriting everything. */
export function sanitizedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Milliseconds between the polite signal and the forced kill of the group. */
const KILL_GRACE_MS = 2_000;

/**
 * Run a command without a shell and resolve with its output.
 *
 * Rejects with `SubprocessError` for a missing executable, a non-zero exit, a
 * timeout, cancellation or output overflow. A cancelled call is reported as
 * cancelled even when the child exits non-zero afterwards.
 */
export function runCommand(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  const maxBytes = options.maxOutputBytes ?? LIMITS.subprocessOutputMaxBytes;

  return new Promise<RunResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let overflow = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(command, args, {
      // Own process group, so terminating the group also stops grandchildren
      // (OCRmyPDF spawns tesseract; ImageMagick spawns delegates).
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? sanitizedEnv(),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });

    function stopGroup(signal: NodeJS.Signals): void {
      if (child.pid === undefined) return;
      try {
        // Negative pid targets the whole group; fall back to the child alone.
        process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    }

    function finish(error: SubprocessError | null, result?: RunResult): void {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result ?? { stdout: "", stderr: "" });
    }

    function terminate(kind: "timeout" | "cancelled" | "output-overflow", message: string): void {
      if (kind === "timeout") timedOut = true;
      if (kind === "cancelled") cancelled = true;
      if (kind === "output-overflow") overflow = true;
      stopGroup("SIGTERM");
      killTimer = setTimeout(() => stopGroup("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
      // Do not resolve here: wait for `close`, so no descendant keeps writing.
      void message;
    }

    const deadline = setTimeout(
      () => terminate("timeout", `timed out after ${options.timeoutMs} ms`),
      options.timeoutMs,
    );
    deadline.unref?.();

    const onAbort = (): void => terminate("cancelled", "cancelled by the caller");
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxBytes) {
        if (!overflow) terminate("output-overflow", "stdout exceeded the output budget");
        return;
      }
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxBytes) {
        if (!overflow) terminate("output-overflow", "stderr exceeded the output budget");
        return;
      }
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      const missing = error.code === "ENOENT";
      finish(
        new SubprocessError(
          missing ? "not-found" : "exit",
          missing ? `${command} is not installed or not on PATH` : `${command} could not start: ${error.message}`,
        ),
      );
    });

    child.on("close", (code, signal) => {
      const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
      if (cancelled) return finish(new SubprocessError("cancelled", "cancelled by the caller", tail));
      if (timedOut) return finish(new SubprocessError("timeout", `timed out after ${options.timeoutMs} ms`, tail));
      if (overflow) return finish(new SubprocessError("output-overflow", "command output exceeded the budget", tail));
      if (code !== 0) {
        return finish(new SubprocessError("exit", `${command} exited with ${code ?? signal ?? "no status"}`, tail));
      }
      finish(null, { stdout, stderr });
    });
  });
}

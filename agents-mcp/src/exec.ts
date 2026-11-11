/** Subprocess runner with abort escalation (SIGTERM → SIGKILL after 5s) —
 *  the single spawn mechanic every adapter goes through. External commands
 *  always run as an argv array, never a shell string. */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  /** true when the process died from our abort escalation */
  aborted: boolean;
}

export function runProcess(opts: {
  command: string;
  args: string[];
  stdin: string;
  envSet?: Record<string, string>;
  envClear?: string[];
  cwd?: string;
  signal?: AbortSignal;
}): Promise<RunResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of opts.envClear || []) delete env[k];
    if (opts.envSet) for (const [k, v] of Object.entries(opts.envSet)) env[k] = v;

    const proc = spawn(opts.command, opts.args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd || process.cwd(),
    });

    let stdout = "";
    let stderr = "";
    let aborted = false;

    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    // Always close stdin (write the task first when there is one) so children
    // that read stdin never wait on an open pipe.
    if (opts.stdin) proc.stdin.write(opts.stdin);
    proc.stdin.end();

    const killProc = (): void => {
      aborted = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
    };

    if (opts.signal) {
      if (opts.signal.aborted) killProc();
      else opts.signal.addEventListener("abort", killProc, { once: true });
    }

    proc.on("close", (code) => {
      if (opts.signal) opts.signal.removeEventListener("abort", killProc);
      resolve({ stdout, stderr, code: code ?? 1, aborted });
    });

    proc.on("error", (err) => {
      if (opts.signal) opts.signal.removeEventListener("abort", killProc);
      // spawn failures (ENOENT and friends) surface as code 1 + message
      resolve({ stdout, stderr: stderr || err.message, code: 1, aborted });
    });
  });
}

/** PATH lookup for agents_status — is the CLI actually invocable here? */
export function lookupCommand(command: string): string | null {
  if (command.includes("/")) return command;
  const dirs = (process.env.PATH || "").split(":").filter(Boolean);
  for (const dir of dirs) {
    const p = `${dir}/${command}`;
    try {
      accessSync(p, constants.X_OK);
      if (existsSync(p)) return p;
    } catch {
      /* keep walking */
    }
  }
  return null;
}

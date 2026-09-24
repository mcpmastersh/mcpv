// `mcpv run` — resolve in memory, inject into ONE child process's
// environment, mask the child's output. The value never becomes a file, never
// becomes our stdout, and never reaches an argv. That is what makes it the one
// invocation an AI coding agent can be handed: the agent sees the command, the
// key names and the (masked) output, never a secret.

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { Writable } from "node:stream";
import { Masker } from "./mask.ts";

/** Variables the child must never inherit, whatever the parent had. */
const WITHHELD = ["MCPV_KEY"];

export class CommandNotFoundError extends Error {
  readonly command: string;
  constructor(command: string) {
    super(`Command not found: ${command}`);
    this.command = command;
  }
}

/** Shell convention: death by signal N exits 128 + N, so `|| exit $?` keeps the reason. */
function exitCodeFor(signal: NodeJS.Signals): number {
  const number = osConstants.signals[signal];
  return typeof number === "number" ? 128 + number : 1;
}

function pipeMasked(source: NodeJS.ReadableStream, target: Writable, masker: Masker): Promise<void> {
  return new Promise((resolve) => {
    source.on("data", (chunk: Buffer) => {
      const out = masker.push(chunk);
      if (out.length) target.write(out);
    });
    source.on("end", () => {
      const rest = masker.flush();
      if (rest.length) target.write(rest);
      resolve();
    });
    source.on("error", () => resolve());
  });
}

export type RunResult = { exitCode: number; signal?: NodeJS.Signals };

export function runWithEnv(
  command: string[],
  env: Record<string, string>,
  options: { mask: boolean; secretValues: string[] },
): Promise<RunResult> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const name of WITHHELD) delete childEnv[name];

  const masker = new Masker(options.secretValues);
  const masking = options.mask && masker.active;

  return new Promise<RunResult>((resolve, reject) => {
    const [bin, ...args] = command;
    const child = spawn(bin, args, {
      env: childEnv,
      // stdin stays the terminal's, so interactive children still read input.
      stdio: masking ? ["inherit", "pipe", "pipe"] : "inherit",
    });

    // The terminal delivers Ctrl+C to the whole process group, child included —
    // so we just outlive it long enough to flush its masked output. A signal
    // aimed at us alone (kill, a supervisor) is passed on.
    const ignore = () => {};
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const handlers: [NodeJS.Signals, () => void][] = [
      ["SIGINT", ignore],
      ["SIGTERM", forward("SIGTERM")],
      ["SIGHUP", forward("SIGHUP")],
    ];
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const release = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };

    const drained = masking
      ? Promise.all([pipeMasked(child.stdout!, process.stdout, masker), pipeMasked(child.stderr!, process.stderr, new Masker(options.secretValues))])
      : Promise.resolve();

    child.on("error", (error: NodeJS.ErrnoException) => {
      release();
      reject(error.code === "ENOENT" ? new CommandNotFoundError(bin) : error);
    });

    child.on("exit", (code, signal) => {
      void drained.then(() => {
        release();
        resolve(signal ? { exitCode: exitCodeFor(signal), signal } : { exitCode: code ?? 0 });
      });
    });
  });
}

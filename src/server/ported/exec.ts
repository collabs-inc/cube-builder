// The one child-process seam every cubed module that shells out shares.
// Callers inject an ExecCommand in tests (see github-auth.test.ts's fakeExec)
// and take makeExec() in production. Never throws on a non-zero exit — a
// failed command is data, not an exception, because every caller here has to
// report the failure rather than propagate it.
import { execFile } from "node:child_process";

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The binary itself was not found (ENOENT) — distinct from a non-zero exit. */
  enoent?: boolean;
}

export type ExecCommand = (
  cmd: string,
  args: string[],
  /**
   * `timeoutMs` overrides the timeout the command was built with, per call.
   * A module whose commands differ by orders of magnitude — a `git worktree
   * list` that must answer on a client's attach path, a `git worktree add`
   * that clones a repo — needs one seam, not one exec per duration.
   * `stdin`, when set, is written to the child and the stream closed —
   * for commands like `gh auth login --with-token` that read a secret from
   * stdin rather than argv (argv is visible in `ps`; stdin is not).
   */
  opts?: { cwd?: string; timeoutMs?: number; stdin?: string; env?: Record<string, string> },
) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export function makeExec(
  opts: { timeoutMs?: number; maxBuffer?: number; signal?: AbortSignal } = {},
): ExecCommand {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return (cmd, args, callOpts) =>
    new Promise((resolvePromise) => {
      const child = execFile(
        cmd,
        args,
        {
          timeout: callOpts?.timeoutMs ?? timeout,
          maxBuffer,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(callOpts?.cwd ? { cwd: callOpts.cwd } : {}),
          ...(callOpts?.env ? { env: callOpts.env } : {}),
        },
        (err, stdout, stderr) => {
          resolvePromise({
            ok: !err,
            stdout: String(stdout),
            stderr: String(stderr),
            enoent: (err as NodeJS.ErrnoException | null)?.code === "ENOENT",
          });
        },
      );
      if (callOpts?.stdin !== undefined && child.stdin) {
        // A failed spawn (ENOENT) destroys the stream mid-write; without a
        // handler that EPIPE/ERR_STREAM_DESTROYED becomes an uncaught error.
        child.stdin.on("error", () => {});
        child.stdin.end(callOpts.stdin);
      }
    });
}

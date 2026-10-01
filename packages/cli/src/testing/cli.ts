/**
 * The `pikit` CLI run as a user runs it, for tests: `main.ts` as a child of this Bun, awaited.
 *
 * Not `Bun.spawnSync`. On Bun 1.4.2 a spawnSync can lose its child's exit: it waits on a private
 * event loop, a GC finalizer that runs during the wait releases a main-loop poll against that loop,
 * its poll count drifts below zero, and a later spawnSync then spins at 100% CPU forever with its
 * child a zombie (oven-sh/bun#34069, fixed by oven-sh/bun#40078, unreleased). Every spawnSync is a
 * window for the drift, and a CLI run is a long one: with the suite's CLI runs on spawnSync, a full
 * `bun test` hung in about half of the runs, in whichever file's spawnSync came next. `Bun.spawn`
 * waits on the main loop and has no such failure.
 */

import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "main.ts");

export type CliRun = { code: number; out: string; err: string };

/** Runs `pikit <args>` in `cwd` with no stdin; `env` is added to this process's environment. */
export async function runCli(args: string[], cwd: string, options: { env?: Record<string, string> } = {}): Promise<CliRun> {
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(options.env !== undefined && { env: { ...process.env, ...options.env } }),
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

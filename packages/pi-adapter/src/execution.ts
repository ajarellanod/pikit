/**
 * @pikit/pi-adapter/execution: what an `execution` provider needs to implement pi-durable's
 * `ExecutionEnv` (files plus shell) without importing Pi, and the `env` a pi-durable `Harness` takes.
 * Neutral: `execution-do` uses it in a Cloudflare Durable Object; `./node` has the server's.
 *
 * pi-durable's environment differs from Pi 0.99's (what pikit's `execution` was before) in three ways:
 * - `FileSystem` has a `readonly id` (equal ids see the same files at the same paths: `edit` and
 *   `write` serialize changes to one file by `id` and path), and `truncateFile` and `flushFile`;
 * - `Shell.exec` streams every raw chunk to `onOutput(text, context)` and no longer bounds the output
 *   (the Harness keeps the tail a tool shows): no `capture`, no `onUpdate`, no truncation in its result;
 * - past `spill`'s thresholds the whole output goes to a temporary file, whose path is the result's
 *   `spillPath` (also on a timeout or abort error). The result is `{ exitCode, spillPath? }`.
 *
 * `harnessEnv` builds `HarnessOptions.env`: per call, the conversation's workspace when a provider
 * has one, otherwise `execution`; at the agent's `cwd` when its configuration sets one (`atCwd`).
 */

import type { Context } from "@earendil-works/chord";
import type { EnvTarget } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export { err, ExecutionError, FileError, getOrThrow, getOrUndefined, ok, toError } from "@earendil-works/pi-durable/env";
export type {
  ExecutionEnv,
  ExecutionErrorCode,
  FileErrorCode,
  FileInfo,
  FileKind,
  FileSystem,
  Result,
  Shell,
  ShellExecOptions,
  ShellExecResult,
  ShellSpillOptions,
  TextLine,
  TextLineReader,
} from "@earendil-works/pi-durable/env";
export type { EnvTarget } from "@earendil-works/pi-durable";
/** Chord's `Context`, which every pi-durable call takes (not `@pikit/core`'s: a separate type), and its helpers. */
export type { Context } from "@earendil-works/chord";
export { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";

/** What `harnessEnv` reads, at each use, from the app's capabilities. */
export interface HarnessEnvSources {
  /** The environment of a conversation without a workspace: `execution`, or `undefined` when none is installed. */
  execution(): ExecutionEnv | undefined;
  /**
   * The conversation's own environment, when a `workspace` provider is installed (`undefined`
   * otherwise). The runtime maps pi-durable's `conversationId` to the pikit conversation it serves.
   * A throw fails the call that needed it, never the run.
   */
  workspace?(target: EnvTarget, context: Context): Promise<ExecutionEnv | undefined>;
}

/**
 * `HarnessOptions.env`: the environment of one tool call, section rendering or `runtime.env()`.
 * Without either source the built-in tools fail with an error result, as pi-durable's do without an
 * environment.
 */
export function harnessEnv(sources: HarnessEnvSources): (target: EnvTarget, context: Context) => Promise<ExecutionEnv | undefined> {
  return async (target, context) => {
    const env = (await sources.workspace?.(target, context)) ?? sources.execution();
    if (env === undefined || target.cwd === undefined) return env;
    return atCwd(env, target.cwd, context);
  };
}

/**
 * `env` with `cwd` as its working directory (absolute, or relative to `env.cwd`): the same files, the
 * same `id`, the same shell, another `cwd`. A view, not a copy: its methods are `env`'s, called with
 * the view as `this`. So it suits an environment whose methods read `this.cwd` at each call, as
 * pi-durable's `NodeExecutionEnv` and execution-do's do; one that captured its `cwd` when it was built
 * ignores it. `cleanup` on the view cleans `env` up.
 */
export async function atCwd(env: ExecutionEnv, cwd: string, context: Context): Promise<ExecutionEnv> {
  const absolute = await env.absolutePath(cwd, context);
  if (!absolute.ok) throw absolute.error;
  if (absolute.value === env.cwd) return env;
  return Object.create(env, { cwd: { value: absolute.value, writable: true, enumerable: true, configurable: true } }) as ExecutionEnv;
}

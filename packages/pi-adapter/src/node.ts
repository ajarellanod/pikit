/**
 * @pikit/pi-adapter/node: pi-durable's `NodeExecutionEnv` as the execution environment of a
 * server, for `execution-local` and `workspace-local`. Server only:
 * nothing here runs on Cloudflare (it spawns processes).
 *
 * The same difference from Pi's default as `@pikit/pi-adapter/node`'s `createLocalExecution`:
 * commands start from `env`, the variables the caller chose, never from this process's environment
 * (pi-durable merges `process.env` into every command, and its `shellEnv` option only adds to it), so
 * a `bash` tool cannot print the server's secrets with `env`. A command's own `env` still applies on
 * top, and `inheritEnv: false` still means only what the command was given.
 *
 * `id` is pi-durable's `node:local`, shared by every local environment: they all see this machine's
 * files at the same paths. Not a sandbox: commands run as this process's OS user.
 */

import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv, ShellExecOptions } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

export { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

export interface LocalExecutionOptions {
  /** Absolute working directory: relative paths and commands start here. */
  cwd: string;
  /** The variables every command starts with, instead of this process's environment. */
  env: Readonly<Record<string, string>>;
}

// No `#private` fields: `atCwd`'s view calls these methods with itself as `this`.
class LocalExecutionEnv extends NodeExecutionEnv {
  constructor(
    private readonly defaults: Readonly<Record<string, string>>,
    cwd: string,
  ) {
    super({ cwd });
  }

  override exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): ReturnType<ExecutionEnv["exec"]> {
    const inherit = options?.inheritEnv ?? true;
    return super.exec(command, { ...options, inheritEnv: false, env: { ...(inherit ? this.defaults : {}), ...options?.env } }, context);
  }
}

/** A server's environment in `options.cwd`. `cleanup(ctx)` kills the commands still running. */
export function createLocalExecution(options: LocalExecutionOptions): ExecutionEnv {
  return new LocalExecutionEnv({ ...options.env }, options.cwd);
}

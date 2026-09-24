/**
 * Pi's `NodeExecutionEnv` (SPEC §8.3) as the execution environment of a server: this machine's
 * filesystem and shell, in a working directory.
 *
 * One difference from Pi's default: commands start from `env`, the variables the caller chose, not
 * from this process's whole environment. Pi merges `process.env` into every command, so a `bash`
 * tool could print the server's secrets (`PIKIT_HTTP_TOKEN`, `ANTHROPIC_API_KEY`) with `env`. Pi's
 * contract lets an environment define its "default variables" (`ShellExecOptions.inheritEnv`), and
 * these are them. A command's own `env` still applies on top, and `inheritEnv: false` still means
 * only what the command was given.
 *
 * This is not a sandbox: commands run as this process's OS user, and can read what that user can.
 */

import type { Context, ExecutionEnv, ShellExecOptions } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

export interface LocalExecutionOptions {
  /** Absolute working directory: relative paths and commands start here. */
  cwd: string;
  /** The variables every command starts with, instead of this process's environment. */
  env: Readonly<Record<string, string>>;
}

class LocalExecutionEnv extends NodeExecutionEnv {
  constructor(private readonly defaults: Readonly<Record<string, string>>, cwd: string) {
    super({ cwd });
  }

  override exec(command: string, options: ShellExecOptions | undefined, context: Context): ReturnType<ExecutionEnv["exec"]> {
    const inherit = options?.inheritEnv ?? true;
    return super.exec(command, { ...options, inheritEnv: false, env: { ...(inherit ? this.defaults : {}), ...options?.env } }, context);
  }
}

/** `cleanup(ctx)` kills the commands still running. */
export function createLocalExecution(options: LocalExecutionOptions): ExecutionEnv {
  return new LocalExecutionEnv({ ...options.env }, options.cwd);
}

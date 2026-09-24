/**
 * execution-local: the agent's tools work on this server's filesystem and shell (SPEC §8.3).
 *
 * It provides both `execution` (files) and `execution.shell` (commands) with Pi's own
 * `NodeExecutionEnv`, in a working directory. Relative paths and commands start there.
 *
 * Commands do not inherit the server's environment. They start from an allowlist of variables
 * (`PATH`, `HOME`, `LANG`…), so `env` in a command does not print the server's secrets. Add a
 * variable to `variables` when a command needs it (a `GITHUB_TOKEN` for `gh`), knowing that the
 * agent can then read it.
 *
 * NOT A SANDBOX. Commands run as the server's OS user and can read and change whatever that user
 * can, outside the working directory too: other projects, `~/.ssh`, this app's credentials file.
 * Paths are not confined, because a shell would step outside anyway. For isolation, run commands
 * elsewhere with another `execution-*` component (a container, a VM), or run the server as a user
 * that owns nothing else.
 *
 * Target: `server`.
 */

import { mkdir, access, constants } from "node:fs/promises";
import { resolve } from "node:path";
import { defineComponent } from "@pikit/core";
import type { ExecutionEnv } from "@pikit/pi-adapter";
import { createLocalExecution } from "@pikit/pi-adapter/node";
import Type from "typebox";

/** What common tools need to run, and nothing that is usually a secret. */
export const DEFAULT_VARIABLES = ["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TERM", "TMPDIR", "TZ", "USER"];

const Config = Type.Object({
  /** The working directory, relative to the server's. Created at start. */
  root: Type.String({ minLength: 1, default: ".pikit/workspace" }),
  /** The server's variables a command starts with; every other one is left out. */
  variables: Type.Array(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), { default: DEFAULT_VARIABLES }),
});

export default defineComponent({
  name: "execution-local",
  config: Config,
  setup(pikit, config) {
    // Building the environment acquires nothing: no directory is made and no process runs until
    // start and the first command. One environment serves both capabilities.
    const env: ExecutionEnv = createLocalExecution({ cwd: resolve(config.root), env: pick(process.env, config.variables) });
    pikit.provide("execution", env);
    pikit.provide("execution.shell", env);

    return {
      async start() {
        // Fail at start: tools with nowhere to work are a broken deployment.
        await mkdir(env.cwd, { recursive: true });
        await access(env.cwd, constants.R_OK | constants.W_OK);
      },
      async stop(ctx) {
        // Kill the commands still running, so none outlives the app.
        await env.cleanup(ctx);
      },
    };
  },
});

function pick(from: Readonly<Record<string, string | undefined>>, names: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = from[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

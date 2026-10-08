/**
 * execution-local: the agent's tools work on this server's filesystem and shell (pi-durable's `ExecutionEnv`,
 * held by `createDurableExecutionConformance`).
 *
 * It provides both `execution` (files) and `execution.shell` (commands) with Pi's own
 * `NodeExecutionEnv`, in a working directory. Relative paths and commands start there.
 *
 * Commands do not inherit the server's environment. They start from an allowlist of variables
 * (`PATH`, `HOME`, `LANG`…), so `env` in a command does not print the server's secrets, and a program
 * a command runs does not pick them up by accident. It hides nothing from a command that looks: on
 * Linux, `cat /proc/$PPID/environ` prints the server's whole environment (the same OS user may read
 * it), and its `.env` is a file like any other. A variable added to `variables` (a `GITHUB_TOKEN` for
 * `gh`) is in every command's environment. `workspace-local` builds on this environment: its agents'
 * directories are inside `root`, and their commands get these `variables`.
 *
 * `git` in a command is this component's own (`git.ts`), run by the server: clone, status, diff,
 * commit, log, push and pr, pushing only to `git.pushRepositories` on branches under
 * `git.branchPrefix`, with the GitHub token read through `secrets` and never given to the shell.
 * The shell reaches it through a `git` program first on its `PATH` (`shim.ts`).
 *
 * NOT A SANDBOX. Commands run as the server's OS user and can read and change whatever that user
 * can, outside the working directory too: other projects, `~/.ssh`, this app's credentials file.
 * Paths are not confined, because a shell would step outside anyway. For isolation, run commands
 * elsewhere with another `execution-*` component (a container, a VM), or run the server as a user
 * that owns nothing else.
 *
 * Target: `server`.
 */

import { randomUUID } from "node:crypto";
import { access, constants, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { defineComponent } from "@pikit/core";
import type { ExecutionEnv } from "@pikit/pi-adapter";
import { createLocalExecution } from "@pikit/pi-adapter/node";
import Type from "typebox";
import { createGit } from "./git.ts";
import { createGitShim } from "./shim.ts";

/** What common tools need to run, and nothing that is usually a secret. */
export const DEFAULT_VARIABLES = ["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TERM", "TMPDIR", "TZ", "USER"];

const Config = Type.Object({
  /** The working directory, relative to the server's. Created at start. */
  root: Type.String({ minLength: 1, default: ".pikit/workspace" }),
  /** The server's variables a command starts with; every other one is left out. */
  variables: Type.Array(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), { default: DEFAULT_VARIABLES }),
  git: Type.Object(
    {
      /** The secret holding the GitHub token, read through `secrets`. Without it, public clones only. */
      tokenSecret: Type.String({ minLength: 1, default: "GITHUB_TOKEN" }),
      /** `owner/name`: the only repositories `git push` and `git pr` may reach. */
      pushRepositories: Type.Array(Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }), { default: [] }),
      /** What a pushed branch must start with: the agent never pushes `main`. */
      branchPrefix: Type.String({ minLength: 1, default: "pikit/self/" }),
    },
    { default: {} },
  ),
});

export default defineComponent({
  name: "execution-local",
  config: Config,
  setup(pikit, config) {
    if (config.variables.includes(config.git.tokenSecret)) {
      throw new Error(`execution-local: variables lists ${config.git.tokenSecret}, the GitHub token: only git may read it, never a command`);
    }
    const secrets = pikit.useOptional("secrets");
    const root = resolve(config.root);
    // Building the environment acquires nothing: no directory is made, no port opened and no process
    // runs until start and the first command. The `git` program's directory is chosen now, because
    // the commands' variables are.
    const shimDir = join(tmpdir(), `pikit-git-${randomUUID()}`);
    const variables = pick(process.env, config.variables);
    variables.PATH = variables.PATH === undefined ? shimDir : `${shimDir}${delimiter}${variables.PATH}`;
    const env: ExecutionEnv = createLocalExecution({ cwd: root, env: variables });
    pikit.provide("execution", env);
    pikit.provide("execution.shell", env);

    const git = createGit({
      token: async () => (await secrets.get()?.get(config.git.tokenSecret)) || undefined,
      pushRepositories: config.git.pushRepositories,
      branchPrefix: config.git.branchPrefix,
    });
    const shim = createGitShim({ dir: shimDir, root, run: git.run });

    return {
      async start() {
        // Fail at start: tools with nowhere to work are a broken deployment.
        await mkdir(env.cwd, { recursive: true });
        await access(env.cwd, constants.R_OK | constants.W_OK);
        await shim.start();
      },
      async stop(ctx) {
        // Kill the commands still running, so none outlives the app.
        try {
          await env.cleanup(ctx);
        } finally {
          await shim.stop();
        }
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

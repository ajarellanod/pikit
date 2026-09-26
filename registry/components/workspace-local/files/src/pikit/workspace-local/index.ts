/**
 * workspace-local: each agent's tools work in a directory of their own on this server (SPEC §8.2).
 *
 * It provides `workspace`. The tool components (`tool-read`, `tool-write`, `tool-edit`, `tool-bash`)
 * ask it, on every call in a run, for the workspace of the run's conversation, and this component
 * answers with the agent's directory: `<root>/<agent>/`, created on the first call. Every
 * conversation of one agent shares it; two agents never do. Without this component, every agent
 * works in `execution`'s one directory, as before.
 *
 * Each directory is Pi's own `NodeExecutionEnv` (through `createLocalExecution`), with a shell.
 * Commands start from an allowlist of the server's variables, as `execution-local`'s do, so `env` in
 * a command does not print the server's secrets.
 *
 * ORDER, NOT ISOLATION. The directory is where an agent's tools start, not a wall. Paths are not
 * confined, and `bash` runs as the server's OS user: it can `cd ..`, read another agent's files and
 * this app's `.pikit/credentials.json`. Isolation needs each agent's tools in a sandbox of their own
 * (an `execution-docker`, planned after M2).
 *
 * Target: `server`.
 */

import { access, constants, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ConversationRef, defineComponent } from "@pikit/core";
import type { Workspace, WorkspaceProvider } from "@pikit/pi-adapter";
import { createLocalExecution } from "@pikit/pi-adapter/node";
import Type from "typebox";

/** What common tools need to run, and nothing that is usually a secret (as `execution-local`). */
export const DEFAULT_VARIABLES = ["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TERM", "TMPDIR", "TZ", "USER"];

const Config = Type.Object({
  /** Where the agents' directories go, relative to the server's working directory. Created at start. */
  root: Type.String({ minLength: 1, default: ".pikit/workspaces" }),
  /** The server's variables a command starts with; every other one is left out. */
  variables: Type.Array(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), { default: DEFAULT_VARIABLES }),
});

/**
 * An agent name that is safe as one directory name. `defineAgent` already requires kebab-case, but a
 * `ConversationRef` comes from records and routing: here it becomes a path, so it is checked again.
 * No `/`, no `..`, never empty: a name that could leave `root` is refused, never cleaned up.
 */
const AGENT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export default defineComponent({
  name: "workspace-local",
  config: Config,
  setup(pikit, config) {
    const root = resolve(config.root);
    const variables = pick(process.env, config.variables);
    // Per agent, the workspace once its directory exists. A cache: the directories are the state.
    const workspaces = new Map<string, Promise<Workspace>>();

    async function open(agent: string): Promise<Workspace> {
      const cwd = join(root, agent);
      await mkdir(cwd, { recursive: true });
      return { env: createLocalExecution({ cwd, env: variables }) };
    }

    const provider: WorkspaceProvider = {
      async resolve(conversation: ConversationRef) {
        const agent = conversation.agent;
        if (!AGENT_NAME.test(agent)) {
          throw new Error(`workspace-local: agent name ${JSON.stringify(agent)} is not a safe directory name (kebab-case)`);
        }
        let workspace = workspaces.get(agent);
        if (workspace === undefined) {
          const opening = open(agent);
          workspace = opening;
          workspaces.set(agent, opening);
          // A directory that could not be made is not remembered: the next call tries again.
          opening.catch(() => {
            if (workspaces.get(agent) === opening) workspaces.delete(agent);
          });
        }
        return workspace;
      },
    };
    pikit.provide("workspace", provider);

    return {
      async start() {
        // Fail at start: tools with nowhere to work are a broken deployment.
        await mkdir(root, { recursive: true });
        await access(root, constants.R_OK | constants.W_OK);
      },
      async stop(ctx) {
        // Kill the commands still running in any agent's directory, so none outlives the app.
        const opened = await Promise.allSettled(workspaces.values());
        workspaces.clear();
        for (const result of opened) if (result.status === "fulfilled") await result.value.env.cleanup(ctx);
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

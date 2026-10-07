/**
 * workspace-local: each agent's tools work in a directory of their own (the `workspace` capability,
 * in @pikit/pi-adapter), inside the `execution` installed.
 *
 * It provides `workspace` and uses `execution`. The runtime asks it, on every tool call in a run, for
 * the workspace of the run's conversation, and this component answers with `execution` itself, at
 * the agent's directory: `<root>/<agent>/`, created on the agent's calls (`atCwd`, a view of the same
 * environment with another working directory). Every conversation of one agent shares it; two agents
 * never do. Without this component, every agent works in `execution`'s one directory.
 *
 * The environment is `execution`'s, unchanged but for its directory: its files, its shell, its
 * variables (`execution-local`'s `variables`), and its `stop`, which kills the commands still running.
 * `root` is relative to `execution`'s working directory (`execution-local`'s `root`), or absolute.
 *
 * ORDER, NOT ISOLATION. The directory is where an agent's tools start, not a wall. Paths are not
 * confined, and `bash` runs as `execution` runs it (with `execution-local`, as the server's OS user):
 * it can `cd ..`, read another agent's files and this app's `.pikit/credentials.json`. Isolation needs
 * each agent's tools in a sandbox of their own (an `execution-docker`, features/sandboxed-execution.md).
 *
 * Target: `server`.
 */

import { defineComponent } from "@pikit/core";
import { type ConversationRef } from "@pikit/contracts";
import { toChord, type WorkspaceProvider } from "@pikit/pi-adapter";
import { atCwd } from "@pikit/pi-adapter/execution";
import Type from "typebox";

const Config = Type.Object({
  /** Where the agents' directories go: relative to `execution`'s working directory, or absolute. Created at start. */
  root: Type.String({ minLength: 1, default: "agents" }),
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
    const execution = pikit.use("execution");
    const root = config.root.replace(/\/+$/, "");

    const provider: WorkspaceProvider = {
      async resolve(conversation: ConversationRef, context) {
        const agent = conversation.agent;
        if (!AGENT_NAME.test(agent)) {
          throw new Error(`workspace-local: agent name ${JSON.stringify(agent)} is not a safe directory name (kebab-case)`);
        }
        const env = execution.get();
        const ctx = toChord(context);
        const cwd = `${root}/${agent}`;
        // Every call: a directory removed meanwhile is made again, and one made already costs nothing.
        const made = await env.createDir(cwd, { recursive: true }, ctx);
        if (!made.ok) throw made.error;
        return { env: await atCwd(env, cwd, ctx) };
      },
    };
    pikit.provide("workspace", provider);

    return {
      async start(ctx) {
        // Fail at start: tools with nowhere to work are a broken deployment.
        const made = await execution.get().createDir(root, { recursive: true }, toChord(ctx));
        if (!made.ok) throw made.error;
      },
    };
  },
});

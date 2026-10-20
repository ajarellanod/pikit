/**
 * workspace-local: each agent's tools work in a directory of their own in each chat (the `workspace`
 * capability, in @pikit/pi-adapter), inside the `execution` installed.
 *
 * It provides `workspace` and uses `execution`. The runtime asks it, on every tool call in a run, for
 * the workspace of the run's conversation, and this component answers with `execution` itself, at
 * the directory of the agent in the conversation's chat (`per: "chat"`, the default):
 * `<root>/<agent>/_chats/<hex SHA-256 of the chat's key>/`, created on the agent's calls (`atCwd`, a
 * view of the same environment with another working directory). The chat is the conversation a
 * person or a channel opened (`originOf(ref).key`): a reset (`/new`) works in the same directory, and
 * so does a delegated child of the same agent; two agents never share one. `_chats` starts with `_`,
 * so it is never a channel's directory (below). Without this component, every agent works in
 * `execution`'s one directory.
 *
 * With `per: "agent"`, every chat of an agent shares `<root>/<agent>/`.
 *
 * With `per: "channel"`, each channel of an agent has a directory of its own inside the agent's:
 * `<root>/<agent>/<channel>/`, from the conversation's `ConversationRef.channel`, which the runtime
 * gives every run (an operator's message into a Telegram conversation still works in `telegram/`). A
 * channel instance's `:` becomes `.` (`telegram:ops` → `telegram.ops/`). A conversation with no channel
 * recorded works in the agent's directory.
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
import { createHash } from "node:crypto";
import { type ConversationRef, originOf } from "@pikit/contracts";
import { toChord, type WorkspaceProvider } from "@pikit/pi-adapter";
import { atCwd } from "@pikit/pi-adapter/execution";
import Type from "typebox";

const Config = Type.Object({
  /** Where the agents' directories go: relative to `execution`'s working directory, or absolute. Created at start. */
  root: Type.String({ minLength: 1, default: "agents" }),
  /**
   * A directory per chat of each agent (`<root>/<agent>/_chats/<hash of the chat's key>/`), per agent for
   * every chat (`<root>/<agent>/`), or per channel of each agent (`<root>/<agent>/<channel>/`).
   */
  per: Type.Union([Type.Literal("chat"), Type.Literal("agent"), Type.Literal("channel")], { default: "chat" }),
});

/**
 * An agent name that is safe as one directory name. `defineAgent` already requires kebab-case, but a
 * `ConversationRef` comes from records and routing: here it becomes a path, so it is checked again.
 * No `/`, no `..`, never empty: a name that could leave `root` is refused, never cleaned up. One
 * leading `_` is allowed: execution-serve names an agentless sandbox `_<sandbox id>`, outside the
 * agent grammar, and it still gets a directory of its own.
 */
const AGENT_NAME = /^_?[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** One part of a channel instance (`telegram`, `ops` of `telegram:ops`): no `/`, no `.`, never empty. */
const CHANNEL_PART = /^[a-z][a-z0-9-]*$/;

/**
 * The directory of `channel`: its `:`-separated parts joined by `.`, which no part has, so two channels
 * never share one (`telegram:ops` → `telegram.ops`). `undefined` when a part is not a safe name: such a
 * channel is refused, never cleaned up.
 */
export function channelDirectory(channel: string): string | undefined {
  const parts = channel.split(":");
  return parts.every((part) => CHANNEL_PART.test(part)) ? parts.join(".") : undefined;
}

/** Where an agent's chats' directories are, inside its own: starts with `_`, so no channel's directory is it. */
const CHATS_DIR = "_chats";

/** The directory of a chat: the hex SHA-256 of its key (keys are any string; this is one safe name). */
function chatDirectory(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

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
        let directory: string | undefined;
        if (config.per === "chat") {
          // The chat: the origin's key, the same through resets and for the agent's delegated children.
          const chat = originOf(conversation).key;
          if (typeof chat !== "string" || chat === "") {
            throw new Error(`workspace-local: the conversation's chat (its origin's key) is ${JSON.stringify(chat)}: a directory needs a non-empty key`);
          }
          directory = `${CHATS_DIR}/${chatDirectory(chat)}`;
        } else if (config.per === "channel" && conversation.channel !== undefined) {
          const channel = conversation.channel;
          directory = channelDirectory(channel);
          if (directory === undefined) {
            throw new Error(`workspace-local: channel ${JSON.stringify(channel)} is not a safe directory name (lowercase parts, separated by ":")`);
          }
        }
        const env = execution.get();
        const ctx = toChord(context);
        const cwd = directory === undefined ? `${root}/${agent}` : `${root}/${agent}/${directory}`;
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

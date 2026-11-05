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
 * With `retentionDays`, a chat's directories (every agent's `_chats/<chat>/`) are deleted once nothing
 * worked in them for that many days, never while a call runs in one (`retention.ts`); an agent's or a
 * channel's directory never. Without it (the default), nothing is ever deleted.
 *
 * With `snapshots` (and a `storage.blob`), a chat's directory of an agent unused for `idleMinutes`
 * (10) is saved to the bucket in the shared snapshot format (`@pikit/contracts/snapshots`) and
 * deleted here; the next `resolve` of that chat and agent restores it before the tool runs. Never
 * while a call of an environment given for it runs. Then `retentionDays` deletes the bucket's
 * snapshots of workspaces unused that long, not the local directories (released anyway).
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
import { join } from "node:path";
import { type ConversationRef, originOf, SNAPSHOT_NAMESPACE } from "@pikit/contracts";
import { openSnapshotStore, SNAPSHOT_MAX_ENTRIES, SNAPSHOT_MAX_UNPACKED_BYTES, snapshotIdOf, WorkspaceSnapshots } from "@pikit/contracts/snapshots";
import { toChord, type WorkspaceProvider } from "@pikit/pi-adapter";
import { atCwd } from "@pikit/pi-adapter/execution";
import Type from "typebox";
import { DAY, Retention } from "./retention.ts";

const Config = Type.Object({
  /** Where the agents' directories go: relative to `execution`'s working directory, or absolute. Created at start. */
  root: Type.String({ minLength: 1, default: "agents" }),
  /**
   * A directory per chat of each agent (`<root>/<agent>/_chats/<hash of the chat's key>/`), per agent for
   * every chat (`<root>/<agent>/`), or per channel of each agent (`<root>/<agent>/<channel>/`).
   */
  per: Type.Union([Type.Literal("chat"), Type.Literal("agent"), Type.Literal("channel")], { default: "chat" }),
  /**
   * Deletes a chat's directories (every agent's `_chats/<chat>/`) once nothing has worked in them for
   * this many days: no command, no file read or written. Never one in use, never an agent's or a
   * channel's directory. Absent (the default): kept forever.
   */
  retentionDays: Type.Optional(Type.Integer({ minimum: 1 })),
  /**
   * Saves a chat's directory of an agent to `storage.blob` once unused for `idleMinutes`, deletes it
   * here, and restores it at its next use (`per: "chat"` only). With `retentionDays`, the bucket's
   * snapshots unused that long are deleted instead of the local directories.
   */
  snapshots: Type.Optional(
    Type.Object(
      {
        /** Minutes a workspace is unused (no command, no file read or written) before it goes to the bucket. */
        idleMinutes: Type.Number({ exclusiveMinimum: 0, default: 10 }),
        /** The largest archive (gzip'd) a workspace may have: a larger one stays here, a warning logged. */
        maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
        /** A restore refuses an archive that unpacks to more bytes (its tar after gunzip): a gzip bomb never fills the disk. A checkpoint past it keeps the workspace here. */
        maxUnpackedBytes: Type.Integer({ minimum: 1, default: SNAPSHOT_MAX_UNPACKED_BYTES }),
        /** A restore refuses an archive with more entries (files, directories, links); a checkpoint past it keeps the workspace here. */
        maxEntries: Type.Integer({ minimum: 1, default: SNAPSHOT_MAX_ENTRIES }),
        /** The `storage.blob` namespace: the shared format's; another only to keep two fleets apart in one bucket. */
        namespace: Type.String({ default: SNAPSHOT_NAMESPACE, pattern: "^[a-z0-9_.-]{1,100}$" }),
      },
      { additionalProperties: false },
    ),
  ),
});

/** Under `root`: the snapshots' own files (archives on their way, restores, the index). Never an agent's name. */
export const SNAPSHOTS_DIR = ".workspace-local-snapshots";

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
    const blob = pikit.useOptional("storage.blob");
    const root = config.root.replace(/\/+$/, "");
    if (config.snapshots !== undefined && config.per !== "chat") {
      throw new Error(`workspace-local: snapshots save a chat's directories (per: "chat"); per: "${config.per}" directories are shared, never released`);
    }
    /** With `snapshots`, from start: and the agents' directories on this host. */
    let snapshots: { keeper: WorkspaceSnapshots; root: string } | undefined;
    // With snapshots, retention is the bucket's (`retentionMs`): the local directories are released anyway.
    const retention =
      config.retentionDays === undefined || config.snapshots !== undefined
        ? undefined
        : new Retention({
            env: () => execution.get(),
            root,
            chatsDir: CHATS_DIR,
            days: config.retentionDays,
            clock: pikit.clock,
            log: pikit.logger,
          });

    const provider: WorkspaceProvider = {
      async resolve(conversation: ConversationRef, context) {
        const agent = conversation.agent;
        if (!AGENT_NAME.test(agent)) {
          throw new Error(`workspace-local: agent name ${JSON.stringify(agent)} is not a safe directory name (kebab-case)`);
        }
        let directory: string | undefined;
        /** The chat's directory name, for retention; none for an agent's or a channel's directory. */
        let chatDir: string | undefined;
        if (config.per === "chat") {
          // The chat: the origin's key, the same through resets and for the agent's delegated children.
          const chat = originOf(conversation).key;
          if (typeof chat !== "string" || chat === "") {
            throw new Error(`workspace-local: the conversation's chat (its origin's key) is ${JSON.stringify(chat)}: a directory needs a non-empty key`);
          }
          chatDir = chatDirectory(chat);
          directory = `${CHATS_DIR}/${chatDir}`;
        } else if (config.per === "channel" && conversation.channel !== undefined) {
          const channel = conversation.channel;
          directory = channelDirectory(channel);
          if (directory === undefined) {
            throw new Error(`workspace-local: channel ${JSON.stringify(channel)} is not a safe directory name (lowercase parts, separated by ":")`);
          }
        }
        // Noted before anything awaits; waits for a retirement of the chat in progress, which leaves no directory.
        const using = chatDir === undefined ? undefined : retention?.use(chatDir);
        // The same for a snapshot: a release in progress, then a restore of one not on disk, before anything works in it.
        const hostDir = chatDir === undefined || snapshots === undefined ? undefined : join(snapshots.root, agent, CHATS_DIR, chatDir);
        const restoring = hostDir === undefined ? undefined : snapshots?.keeper.use({ id: snapshotIdOf(originOf(conversation).key, agent), agent, dir: hostDir });
        const env = execution.get();
        const ctx = toChord(context);
        const cwd = directory === undefined ? `${root}/${agent}` : `${root}/${agent}/${directory}`;
        await using;
        await restoring;
        // Every call: a directory removed meanwhile is made again, and one made already costs nothing.
        const made = await env.createDir(cwd, { recursive: true }, ctx);
        if (!made.ok) throw made.error;
        const view = await atCwd(env, cwd, ctx);
        const tracked = chatDir === undefined || retention === undefined ? view : retention.track(chatDir, view);
        return { env: hostDir === undefined || snapshots === undefined ? tracked : snapshots.keeper.track(hostDir, tracked) };
      },
    };
    pikit.provide("workspace", provider);

    return {
      async start(ctx) {
        // Fail at start: tools with nowhere to work are a broken deployment.
        const made = await execution.get().createDir(root, { recursive: true }, toChord(ctx));
        if (!made.ok) throw made.error;
        if (config.snapshots !== undefined) {
          const env = execution.get();
          const storage = blob.get();
          if (storage === undefined) throw new Error("workspace-local: snapshots need a storage.blob provider (storage-blob-s3, storage-blob-fs)");
          // Saved and restored on this host's disk: the archive streams from and into the directories themselves.
          if (env.id !== "node:local") throw new Error(`workspace-local: snapshots need execution's directories on this host (execution-local), not ${env.id}`);
          const canonical = await env.canonicalPath(root, toChord(ctx));
          if (!canonical.ok) throw canonical.error;
          const options = config.snapshots;
          const keeper = new WorkspaceSnapshots({
            name: "workspace-local",
            store: () => openSnapshotStore(storage, options.namespace),
            base: canonical.value,
            state: join(canonical.value, SNAPSHOTS_DIR),
            idleMs: options.idleMinutes * 60_000,
            ...(options.maxBytes !== undefined && { maxBytes: options.maxBytes }),
            maxUnpackedBytes: options.maxUnpackedBytes,
            maxEntries: options.maxEntries,
            ...(config.retentionDays !== undefined && { retentionMs: config.retentionDays * DAY }),
            clock: pikit.clock,
            log: ctx.logger,
          });
          await keeper.start();
          snapshots = { keeper, root: canonical.value };
        }
        // In the background: a first sweep may have much to delete.
        retention?.start();
      },
      async stop() {
        await retention?.stop();
        await snapshots?.keeper.stop();
        snapshots = undefined;
      },
    };
  },
});

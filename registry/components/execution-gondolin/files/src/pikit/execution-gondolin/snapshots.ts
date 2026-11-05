/**
 * Snapshots (`snapshots`): a chat's sandbox of an agent (`<root>/chats/<chat>/<agent>/`, the guest's
 * `/workspace`) unused for `idleMinutes` is saved to `storage.blob` in the shared snapshot format
 * (`@pikit/contracts/snapshots`) and deleted here, its temporary files with it; the next `resolve` of
 * that chat and agent restores it before anything runs. A host then holds only the workspaces in use:
 * it can be replaced, and the next host restores each chat's from the bucket.
 *
 * - **Never while a VM holds it**: before a checkpoint the sandbox's VM is closed if no command runs
 *   (`Pool.closeIdle`); a sandbox with a command or a file operation running, or a VM up, is kept.
 *   `/workspace` is a host directory behind a VFS mount, so once the VM is closed the checkpoint is
 *   the host's alone.
 * - **Shared sandboxes are never released**: `workspace: "agent"` ones and `default`.
 * - **With `retentionDays`**, the bucket's snapshots of workspaces unused that long are deleted
 *   (hourly), instead of the local directories (which the snapshots release anyway).
 * - Its files are under `<root>/.execution-gondolin-snapshots/` (archives on their way, restores,
 *   released directories, the index of the workspaces on disk), out of every guest's reach.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type BlobStorage, SNAPSHOT_NAMESPACE } from "@pikit/contracts";
import { openSnapshotStore, SNAPSHOT_MAX_ENTRIES, SNAPSHOT_MAX_UNPACKED_BYTES, snapshotIdOf, type SnapshotLog, WorkspaceSnapshots } from "@pikit/contracts/snapshots";
import type { Clock } from "@pikit/core";
import Type, { type Static } from "typebox";
import type { Sandbox } from "./env.ts";

/** Under `root`: the snapshots' own files. */
export const SNAPSHOTS_DIR = ".execution-gondolin-snapshots";

export const SnapshotsConfig = Type.Object(
  {
    /** Minutes a chat's sandbox is unused (no command, no file read or written) before it goes to the bucket. */
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
);

export interface GondolinSnapshotsOptions {
  config: Static<typeof SnapshotsConfig>;
  /** The sandboxes' root on the host (absolute). */
  root: string;
  retentionDays: number | undefined;
  /** `storage.blob`, read at start. */
  blob(): BlobStorage | undefined;
  /** The conversations' sandboxes held now, every one in use among them. */
  sandboxes(): Iterable<Sandbox>;
  clock: Clock;
  log(): SnapshotLog;
}

/** Whether a sandbox holds nothing running: no VM, no command, no file operation. */
const idle = (box: Sandbox) => box.slot.guest === undefined && box.slot.busy === 0 && box.running.size === 0 && box.active === 0;

export class GondolinSnapshots {
  private keeper: WorkspaceSnapshots | undefined;

  constructor(private readonly options: GondolinSnapshotsOptions) {}

  private sandboxOf(dir: string): Sandbox | undefined {
    for (const box of this.options.sandboxes()) if (box.workspace === dir) return box;
    return undefined;
  }

  /**
   * Notes the use of `box`, the sandbox of `agent` in `chat` (call it before anything awaits), and
   * resolves once its workspace is on disk: restored from its snapshot when it was released.
   */
  use(chat: string, agent: string, box: Sandbox): Promise<void> {
    const keeper = this.keeper;
    if (keeper === undefined) return Promise.reject(new Error("execution-gondolin: snapshots used while the app is not running"));
    return keeper.use({ id: snapshotIdOf(chat, agent), agent, dir: box.workspace });
  }

  async start(): Promise<void> {
    const storage = this.options.blob();
    if (storage === undefined) throw new Error("execution-gondolin: snapshots need a storage.blob provider (storage-blob-s3, storage-blob-fs)");
    const { config, root, clock } = this.options;
    const log: SnapshotLog = {
      debug: (message, fields) => this.options.log().debug(message, fields),
      info: (message, fields) => this.options.log().info(message, fields),
      warn: (message, fields) => this.options.log().warn(message, fields),
    };
    this.keeper = new WorkspaceSnapshots({
      name: "execution-gondolin",
      store: () => openSnapshotStore(storage, config.namespace),
      base: root,
      state: join(root, SNAPSHOTS_DIR),
      idleMs: config.idleMinutes * 60_000,
      ...(config.maxBytes !== undefined && { maxBytes: config.maxBytes }),
      maxUnpackedBytes: config.maxUnpackedBytes,
      maxEntries: config.maxEntries,
      ...(this.options.retentionDays !== undefined && { retentionMs: this.options.retentionDays * 24 * 3_600_000 }),
      clock,
      // A command or a file operation running; a VM up but idle is closed by `prepare`.
      busy: (dir) => {
        const box = this.sandboxOf(dir);
        return box !== undefined && (box.slot.busy > 0 || box.running.size > 0 || box.active > 0);
      },
      quiet: (dir) => {
        const box = this.sandboxOf(dir);
        return box === undefined || idle(box);
      },
      // The VM first: closed when no command holds it, so nothing writes while the archive is made.
      prepare: async (dir) => {
        const box = this.sandboxOf(dir);
        if (box === undefined) return true;
        if (box.running.size > 0 || box.active > 0) return false;
        return (await box.pool.closeIdle(box.slot)) && idle(box);
      },
      released: async (dir) => {
        const box = this.sandboxOf(dir);
        box?.changed.clear();
        if (box !== undefined) await rm(box.tmp, { recursive: true, force: true });
      },
      log,
    });
    await this.keeper.start();
  }

  async stop(): Promise<void> {
    await this.keeper?.stop();
    this.keeper = undefined;
  }
}

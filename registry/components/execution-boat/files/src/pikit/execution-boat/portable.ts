/**
 * A boat VM's workspace in the shared snapshot format (`@pikit/contracts`' `workspace-snapshot.ts`,
 * the same implementation every backend uses), with `snapshots: true`:
 *
 * - **Export** (before an idle stop, and before a retention deletion when the latest snapshot is
 *   older than the VM's last start): `tar` in the VM, of `<home>/workspace`'s contents (only regular
 *   files, directories and links the format keeps: the helper's `export` skips the rest, and says how
 *   many), gzip'd into a file whose size and SHA-256 the helper gives (the key carries the SHA-256);
 *   then streamed from boat's signed download URL straight into `putStream`, checked on the way
 *   (`putSnapshotArchive`: its entries, and its SHA-256 by the provider), the manifest written last
 *   (`commitSnapshotManifest`), the superseded archives deleted. The gateway never holds an archive:
 *   the limit is `storage.blob`'s `maxStreamBytes`. Past it, the VM keeps the truth, and the stop or
 *   deletion says so in the log.
 * - **Restore** (a new VM for a workspace that has a snapshot): the archive streamed from
 *   `getStream` to the VM's signed upload URL, checked on the way against its manifest (size,
 *   SHA-256, entries: `readSnapshotArchive`), and extracted in the VM only once all of it held: into
 *   an empty directory beside the workspace, swapped in. A snapshot that does not hold leaves no VM
 *   (`vms.ts`).
 */

import { posix } from "node:path";
import { type BlobStorage, commitSnapshotManifest, deleteSupersededSnapshots, openSnapshotStore, putSnapshotArchive, readSnapshotArchive } from "@pikit/contracts";
import { readSnapshotManifest } from "@pikit/contracts/snapshots";
import type { Clock } from "@pikit/core";
import type { BoatApi } from "./api.ts";
import type { VmPaths } from "./env.ts";
import { helperCommand } from "./helper.ts";
import type { Vm, VmLog, VmSnapshots } from "./vms.ts";

/** boat's longest synchronous command: what an export or a restore may take in the VM. */
const LONG_SECONDS = 600;

export interface PortableOptions {
  api: BoatApi;
  blob: () => BlobStorage;
  paths: (key: string) => VmPaths;
  node: string;
  clock: Clock;
  log: () => VmLog;
}

/** Runs one helper operation in VM `id`: its value, or an error saying what failed. */
export async function helper<T>(api: BoatApi, id: string, node: string, request: Record<string, unknown>, seconds: number): Promise<T> {
  const answer = await api.run(id, helperCommand(node, request), seconds);
  let parsed: { ok?: unknown; value?: unknown; code?: unknown; message?: unknown } | undefined;
  try {
    parsed = JSON.parse(answer.stdout) as typeof parsed;
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || typeof parsed !== "object" || parsed === null || typeof parsed.ok !== "boolean") {
    throw new Error(`the ${String(request.op)} step in the VM failed (exit ${answer.exitCode}${answer.timedOut ? ", timed out" : ""}): ${api.redact(answer.stderr).slice(-300)}`);
  }
  if (!parsed.ok) throw new Error(`the ${String(request.op)} step in the VM failed: ${String(parsed.code)} ${api.redact(String(parsed.message)).slice(0, 300)}`);
  return parsed.value as T;
}

/** `chunks` as a stream; one that throws errors it (the upload fails), and is kept in `failure()`. */
function streamOf(chunks: AsyncIterable<Uint8Array>): { body: ReadableStream<Uint8Array>; failure(): unknown } {
  const iterator = chunks[Symbol.asyncIterator]();
  let failure: unknown;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done === true) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        failure = error;
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  return { body, failure: () => failure };
}

export function boatSnapshots(options: PortableOptions): VmSnapshots {
  const { api, node } = options;
  const store = () => openSnapshotStore(options.blob());
  return {
    async latest(vm) {
      return (await readSnapshotManifest(store(), { id: vm.key, agent: vm.agent }))?.createdAt;
    },

    async save(vm, id) {
      const paths = options.paths(vm.key);
      const out = posix.join(paths.tmp, `export-${crypto.randomUUID()}.tar.gz`);
      const made = await helper<{ size: number; sha256: string; entries: number; skipped: number }>(api, id, node, { op: "export", ws: posix.join(paths.home, "workspace"), out }, LONG_SECONDS);
      try {
        const { maxStreamBytes } = options.blob();
        if (made.size > maxStreamBytes) throw new Error(`the workspace's archive is ${made.size} bytes, more than storage.blob's maxStreamBytes (${maxStreamBytes})`);
        const snapshots = store();
        const body = await api.downloadStream(await api.fileUrl(id, "download", out));
        const manifest = await putSnapshotArchive(snapshots, { id: vm.key, agent: vm.agent, createdAt: options.clock.now(), sha256: made.sha256, body, maxBytes: maxStreamBytes });
        await commitSnapshotManifest(snapshots, vm.key, manifest);
        await deleteSupersededSnapshots(snapshots, vm.key, manifest.object).catch((error: unknown) =>
          options.log().warn("execution-boat: superseded snapshots were not deleted; the next export tries again", { reason: error instanceof Error ? error.message : String(error) }),
        );
        options.log().info("execution-boat: workspace exported", { agent: vm.agent, bytes: manifest.size, entries: made.entries, ...(made.skipped > 0 && { skipped: made.skipped }) });
      } finally {
        await helper(api, id, node, { op: "rm", path: out, recursive: false, force: true }, 60).catch(() => {});
      }
    },

    async restore(vm, id) {
      const snapshot = await readSnapshotArchive(store(), { id: vm.key, agent: vm.agent });
      if (snapshot === undefined) return;
      const paths = options.paths(vm.key);
      const archive = posix.join(paths.tmp, `restore-${crypto.randomUUID()}.tar.gz`);
      const upload = streamOf(snapshot.chunks);
      try {
        await api.uploadStream(await api.fileUrl(id, "upload", archive), upload.body, snapshot.manifest.size);
      } catch (error) {
        throw upload.failure() ?? error;
      }
      if (upload.failure() !== undefined) throw upload.failure();
      // Every byte held (size, SHA-256, entries): only now is it extracted.
      snapshot.result();
      await helper(api, id, node, { op: "restore", ws: posix.join(paths.home, "workspace"), archive }, LONG_SECONDS);
      options.log().info("execution-boat: workspace restored from its snapshot", { agent: vm.agent, bytes: snapshot.manifest.size });
    },
  };
}

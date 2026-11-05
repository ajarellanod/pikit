/**
 * A boat VM's workspace in the shared snapshot format (`snapshot.ts`), with `snapshots: true`:
 *
 * - **Export** (before an idle stop, and before a retention deletion when the latest snapshot is
 *   older than the VM's last start): `tar` in the VM, of `<home>/workspace`'s contents (only regular
 *   files, directories and links that stay inside: the helper's `export` skips the rest, and says how
 *   many); the archive comes to the gateway through a download URL, is checked, and saved
 *   (`saveSnapshot`: read back and compared before the manifest). Larger than `storage.blob`'s
 *   `maxBytes`, it is not saved: the VM keeps the truth, and the stop or deletion says so in the log.
 * - **Restore** (a new VM for a workspace that has a snapshot): the archive is loaded and verified
 *   (`loadSnapshot`: size, SHA-256, entries) before it reaches the VM, uploaded to the VM's
 *   `/tmp/pikit`, extracted into an empty directory beside the workspace and swapped in.
 */

import { posix } from "node:path";
import type { BlobStorage } from "@pikit/contracts";
import type { Clock } from "@pikit/core";
import type { BoatApi } from "./api.ts";
import type { VmPaths } from "./env.ts";
import { helperCommand } from "./helper.ts";
import { loadSnapshot, readManifest, SNAPSHOT_NAMESPACE, saveSnapshot } from "./snapshot.ts";
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

export function boatSnapshots(options: PortableOptions): VmSnapshots {
  const { api, node } = options;
  const store = () => options.blob().namespace(SNAPSHOT_NAMESPACE);
  const prefix = (vm: Vm) => `${vm.key}/`;
  return {
    async latest(vm) {
      return (await readManifest(store(), prefix(vm)))?.createdAt;
    },

    async save(vm, id) {
      const paths = options.paths(vm.key);
      const out = posix.join(paths.tmp, `export-${crypto.randomUUID()}.tar.gz`);
      const made = await helper<{ size: number; entries: number; skipped: number }>(api, id, node, { op: "export", ws: posix.join(paths.home, "workspace"), out }, LONG_SECONDS);
      try {
        const maxBytes = options.blob().maxBytes;
        if (made.size > maxBytes) throw new Error(`the workspace's archive is ${made.size} bytes, more than storage.blob's maxBytes (${maxBytes})`);
        const archive = await api.download(await api.fileUrl(id, "download", out), maxBytes);
        const manifest = await saveSnapshot(store(), prefix(vm), vm.agent, archive, options.clock.now());
        options.log().info("execution-boat: workspace exported", { agent: vm.agent, bytes: manifest.size, entries: made.entries, ...(made.skipped > 0 && { skipped: made.skipped }) });
      } finally {
        await helper(api, id, node, { op: "rm", path: out, recursive: false, force: true }, 60).catch(() => {});
      }
    },

    async restore(vm, id) {
      const loaded = await loadSnapshot(store(), prefix(vm));
      if (loaded === undefined) return;
      const paths = options.paths(vm.key);
      const archive = posix.join(paths.tmp, `restore-${crypto.randomUUID()}.tar.gz`);
      await api.upload(await api.fileUrl(id, "upload", archive), loaded.archive);
      await helper(api, id, node, { op: "restore", ws: posix.join(paths.home, "workspace"), archive }, LONG_SECONDS);
      options.log().info("execution-boat: workspace restored from its snapshot", { agent: vm.agent, bytes: loaded.manifest.size });
    },
  };
}

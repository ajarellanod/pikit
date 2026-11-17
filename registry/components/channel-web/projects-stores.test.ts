/**
 * channel-web's project routes over the real stores: every case of `projectRouteCases`
 * (`projects.cases.test-support.ts`, which `projects.test.ts` runs over doubles) with projects-sql
 * (`projects`), tool-space-files (`space.files`, its bytes in storage-blob-fs) and memory-sql (`memory`),
 * their actors in the App over an in-memory mailbox that counts what reaches each store's actors (a
 * non-member's request reaches none of the files' or memory's), and wakeups in memory. `principals` and
 * `document.convert` stay doubles: no kit component provides `principals`, and convert-workers-ai runs on
 * Cloudflare only.
 *
 * A repository test, not copied with the component: it imports other components' files (SPEC P4).
 */

import { join } from "node:path";
import { isJsonObject, type JsonValue } from "@pikit/contracts";
import { createMemoryMailbox, createMemoryWakeups } from "@pikit/contracts/testing";
import executionLocal from "../execution-local/files/src/pikit/execution-local/index.ts";
import memorySql from "../memory-sql/files/src/pikit/memory-sql/index.ts";
import projectsSql from "../projects-sql/files/src/pikit/projects-sql/index.ts";
import storageBlobFs from "../storage-blob-fs/files/src/pikit/storage-blob-fs/index.ts";
import toolSpaceFiles from "../tool-space-files/files/src/pikit/tool-space-files/index.ts";
import { projectRouteCases, type StoreName } from "./files/src/pikit/channel-web/projects.cases.test-support.ts";

/** The store an actor key is one of: projects-sql's (`projects:`), tool-space-files' (`space-files:`), memory-sql's (`memory:`). */
const storeOf = (key: string): StoreName | undefined => (key.startsWith("projects:") ? "projects" : key.startsWith("space-files:") ? "files" : key.startsWith("memory:") ? "memory" : undefined);

/** A call's method: a project's op (`{ op }` of projects-sql's one call per project), else its type's last word. */
const methodOf = (type: string, message: JsonValue): string => {
  const op = isJsonObject(message) ? message.op : undefined;
  return typeof op === "string" ? op : type.slice(type.lastIndexOf(".") + 1);
};

projectRouteCases({
  async open({ only, dir }) {
    const calls: Record<StoreName, string[]> = { projects: [], files: [], memory: [] };
    let failing: string | undefined;
    const observe = (key: string, type: string, message: JsonValue) => {
      const store = storeOf(key);
      if (store === undefined) return;
      const method = methodOf(type, message);
      calls[store].push(method);
      if (store === "projects" && method === failing) {
        failing = undefined;
        throw new Error("the store is down");
      }
    };
    return {
      components: [
        createMemoryMailbox({ observe }),
        createMemoryWakeups(),
        ...(only.includes("projects") ? [projectsSql] : []),
        ...(only.includes("memory") ? [memorySql] : []),
        ...(only.includes("files") ? [storageBlobFs, executionLocal, toolSpaceFiles] : []),
      ],
      config: only.includes("files")
        ? {
            "storage-blob-fs": { root: join(dir, "blobs") },
            "execution-local": { root: join(dir, "workspace") },
            // As the doubles: a file of 1 MiB at most.
            "tool-space-files": { maxFileBytes: 1024 * 1024 },
          }
        : {},
      calls: (store) => [...calls[store]],
      resetCalls: () => {
        for (const each of Object.values(calls)) each.length = 0;
      },
      failNext: (method) => void (failing = method),
    };
  },
});

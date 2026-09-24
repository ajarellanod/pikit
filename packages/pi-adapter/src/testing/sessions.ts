/**
 * Pi's own conformance suites for session stores (SPEC §7.5, §14), for `sessions.*` components to
 * run without importing Pi (rule 1). Every `sessions.store` passes `createSessionRepoConformance`
 * and `createStorageConformance`, as Pi's own repositories do.
 */

import type { Session, Storage } from "@earendil-works/pi-agent-core";

export { createSessionRepoConformance, createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
export type { StorageFixture } from "@earendil-works/pi-agent-core/harness/session/testing";

/**
 * The `Storage` under a session that one of Pi's repositories created: what
 * `createStorageConformance` checks, so a store's suite runs over the storage it really writes.
 * Pi's repositories return a `StorageBackedSession`, which keeps it in a field Pi does not publish;
 * reading it is test-only, and pinned with Pi like every record this adapter reads.
 */
export function storageOf(session: Session): Storage {
  const storage = (session as unknown as { storage?: Storage }).storage;
  if (storage === undefined || typeof storage.commit !== "function") {
    throw new Error("storageOf: the session is not a Pi StorageBackedSession");
  }
  return storage;
}

/**
 * Cases of `createSessionRepoConformance` that Pi's `JsonlSessionRepo` 0.87.1 fails. Pi's own JSONL
 * test does not run its fork destination-reservation cases (`createSessionRepoForkDestination
 * ReservationConformance`), and this one fails: a `create` racing a `fork` for the same new id. pikit
 * neither forks nor chooses session ids, so it does not reach it. A JSONL store registers these with
 * `test.failing`, so a Pi release that fixes them fails the test and the entry is removed.
 */
export const JSONL_REPO_CONFORMANCE_GAPS: readonly string[] = ["publishes create when it reserves a shared destination id first"];

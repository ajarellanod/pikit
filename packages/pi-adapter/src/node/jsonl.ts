/**
 * Pi's JSONL session repository (SPEC §7.5) as a `sessions.store`: one JSONL file per session
 * under `root`, written by Pi. The adapter adds two things:
 * - every JSONL session records a working directory, and callers that do not know one (the
 *   conversation registry creates sessions for channels) get `cwd`;
 * - `find(id)`, from an index of the sessions' metadata. Pi opens a session from its metadata, and
 *   the file name holds a timestamp besides the id, so without the index every conversation the
 *   runtime opens (every message to an idle one) would list, reading the first line of every
 *   session file ever written. The index is filled by this store's own `create` and `fork`, and by
 *   one listing the first time an id is missing (after a restart). One process owns `root` (SPEC
 *   §7.2), so nothing else adds or deletes files behind it.
 */

import {
  type Context,
  type ForkOptions,
  type JsonlSessionCreateOptions,
  JsonlSessionRepo,
  type JsonlSessionMetadata,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { SessionStore } from "../types.ts";

export interface JsonlSessionStoreOptions {
  /** Absolute directory holding the session files. Pi creates it on the first write. */
  root: string;
  /** Absolute working directory recorded in a session created without one. */
  cwd: string;
}

/** A `sessions.store` over Pi's JSONL files. `close` closes every session still open. */
export interface JsonlSessionStore extends SessionStore {
  create(options: Omit<JsonlSessionCreateOptions, "cwd"> & { cwd?: string }, context: Context): Promise<Session<JsonlSessionMetadata>>;
  find(id: string, context: Context): Promise<JsonlSessionMetadata | undefined>;
  close(context: Context): Promise<void>;
}

class IndexedJsonlRepo extends JsonlSessionRepo implements JsonlSessionStore {
  /** Session id → its metadata. A cache of the files: what is on disk is the truth. */
  private readonly index = new Map<string, JsonlSessionMetadata>();
  /** The listing in progress, shared by every `find` that missed while it runs. */
  private listing: Promise<void> | undefined;

  constructor(private readonly defaultCwd: string, root: string) {
    super({ fileSystem: new NodeExecutionEnv({ cwd: defaultCwd }), sessionsRoot: root });
  }

  override async create(options: Omit<JsonlSessionCreateOptions, "cwd"> & { cwd?: string }, context: Context): Promise<Session<JsonlSessionMetadata>> {
    return this.indexed(await super.create({ ...options, cwd: options.cwd ?? this.defaultCwd }, context));
  }

  override async fork(source: JsonlSessionMetadata, options: ForkOptions, context: Context): Promise<Session<JsonlSessionMetadata>> {
    return this.indexed(await super.fork(source, options, context));
  }

  override async delete(metadata: JsonlSessionMetadata, context: Context): Promise<void> {
    await super.delete(metadata, context);
    this.index.delete(metadata.id);
  }

  /** Every listing refreshes the index with what it read. */
  override async list(options: { cwd?: string } | undefined, context: Context): Promise<JsonlSessionMetadata[]> {
    const listed = await super.list(options, context);
    // Newest first, as Pi sorts: when two directories hold one id, the newest is the one kept.
    for (const metadata of [...listed].reverse()) this.index.set(metadata.id, metadata);
    return listed;
  }

  async find(id: string, context: Context): Promise<JsonlSessionMetadata | undefined> {
    const known = this.index.get(id);
    if (known !== undefined) return known;
    // Missing: created before this process started. One listing fills the index for all of them.
    this.listing ??= this.list(undefined, context)
      .then(() => undefined)
      .finally(() => {
        this.listing = undefined;
      });
    await this.listing;
    return this.index.get(id);
  }

  private indexed(session: Session<JsonlSessionMetadata>): Session<JsonlSessionMetadata> {
    this.index.set(session.metadata.id, session.metadata);
    return session;
  }
}

export function createJsonlSessionStore(options: JsonlSessionStoreOptions): JsonlSessionStore {
  return new IndexedJsonlRepo(options.cwd, options.root);
}

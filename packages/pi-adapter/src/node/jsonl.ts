/**
 * Pi's JSONL session repository (SPEC §7.5) as a `sessions.store`: one JSONL file per session
 * under `root`, written by Pi. The adapter adds one thing: every JSONL session records a working
 * directory, and callers that do not know one (the conversation registry creates sessions for
 * channels) get `cwd`.
 */

import {
  type Context,
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
  close(context: Context): Promise<void>;
}

class DefaultCwdJsonlRepo extends JsonlSessionRepo {
  constructor(private readonly defaultCwd: string, root: string) {
    super({ fileSystem: new NodeExecutionEnv({ cwd: defaultCwd }), sessionsRoot: root });
  }

  override create(options: Omit<JsonlSessionCreateOptions, "cwd"> & { cwd?: string }, context: Context): Promise<Session<JsonlSessionMetadata>> {
    return super.create({ ...options, cwd: options.cwd ?? this.defaultCwd }, context);
  }
}

export function createJsonlSessionStore(options: JsonlSessionStoreOptions): JsonlSessionStore {
  return new DefaultCwdJsonlRepo(options.cwd, options.root);
}

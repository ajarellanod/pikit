/**
 * sessions-jsonl: each conversation's Pi session is a JSONL file on this server's disk (SPEC §7.5).
 *
 * Pi writes the files: this component is Pi's `JsonlSessionRepo`, reached through
 * `@pikit/pi-adapter/node`, plus where the files go. It provides `sessions.store`, which the agent
 * runtime opens conversations from and the conversation registry creates sessions in.
 *
 * Pi opens a session exclusively within one process, and a second process on the same files is
 * unsupported (SPEC §7.2). Run one server replica over one `root`.
 *
 * Target: `server` (it uses the filesystem).
 */

import { access, constants, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { defineComponent } from "@pikit/core";
import type { SessionStore } from "@pikit/pi-adapter";
import { createJsonlSessionStore, type JsonlSessionStore } from "@pikit/pi-adapter/node";
import Type from "typebox";

const Config = Type.Object({
  /** Directory of the session files, relative to the working directory. */
  root: Type.String({ minLength: 1, default: ".pikit/sessions" }),
});

export default defineComponent({
  name: "sessions-jsonl",
  config: Config,
  setup(pikit, config) {
    // Opened in start; the capability is a stable facade over it, as consumers resolve it once.
    let store: JsonlSessionStore | undefined;
    const current = (): JsonlSessionStore => {
      if (store === undefined) throw new Error("sessions-jsonl: sessions.store used while the app is not running");
      return store;
    };
    const sessions: SessionStore = {
      create: (options, ctx) => current().create(options, ctx),
      open: (metadata, ctx) => current().open(metadata, ctx),
      list: (options, ctx) => current().list(options, ctx),
      // By id, from the store's index: the runtime opens a conversation's session without listing them all.
      find: (id, ctx) => current().find(id, ctx),
      delete: (metadata, ctx) => current().delete(metadata, ctx),
      fork: (source, options, ctx) => current().fork(source, options, ctx),
    };
    pikit.provide("sessions.store", sessions);

    return {
      async start() {
        const root = resolve(config.root);
        // Fail at start, not at the first message: a root that cannot hold files is a broken deployment.
        await mkdir(root, { recursive: true });
        await access(root, constants.R_OK | constants.W_OK);
        // A session records the directory the agent works in; until `workspace` exists (§8), the
        // server's working directory.
        store = createJsonlSessionStore({ root, cwd: process.cwd() });
      },
      async stop(ctx) {
        const closing = store;
        store = undefined;
        await closing?.close(ctx);
      },
    };
  },
});

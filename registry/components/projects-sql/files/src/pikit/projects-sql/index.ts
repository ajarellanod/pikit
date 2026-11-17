/**
 * projects-sql: `projects` (`@pikit/contracts`' projects.ts) over `storage.sql`, with one actor per
 * project and a directory (features/projects.md).
 *
 * - **The directory**, `projects:index` (`directory.ts`): ids, spaces and members by principal, for
 *   `create`, `list` and `locate`. Never an access check.
 * - **One actor per project**, `projects:space:<space>` (`project.ts`): its record, members, the
 *   instructions and documents with every version (in 20,000-character parts, FTS5-indexed in parts of
 *   about 1,500), links, and the append-only change log. Every call is checked there, against its
 *   caller, and every write is one transaction with its log entry. After a change it tells the
 *   directory the new version (newer versions win).
 * - **Everything is a call** (`store.ts`), answered by the handlers this default export registers with
 *   `actor.inbox` over the `storage.sql` of the App the actor runs in: on a server (mailbox-local) one
 *   App and one database for every key; on Cloudflare (actors-do) each project's Durable Object and the
 *   directory's. The Worker's App gets `projects` and the admin routes from the Worker half
 *   (`worker.ts`). Nothing is held in memory between calls but `locate`'s answers, which never change.
 * - **Removal**: `remove` leaves a tombstone; after `PROJECT_TOMBSTONE_DAYS` this component's wakeup
 *   (`projects-sql.purge`, in the App of the project's actor) takes the project out of the directory,
 *   purges the space's memory (`memory.purge`, when memory-sql is installed) and deletes every row of
 *   the project. Each step is idempotent: a run cut short runs again. At start it asks `wakeups` again
 *   for the next purge its own rows hold (K6); a start makes no call to another actor.
 * - **The dashboard**: `routes.ts`, behind `admin.auth`, and the view in `view/`.
 *
 * Config: `coreTokens` (the core documents' budget, estimated tokens) and `staleAfterMs` (how long a
 * sourced member counts after its last sync).
 *
 * Targets: `server` and `durable`: it imports nothing platform-specific.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import { ActorCallError, type ActorCallHandler, ChangeInputError, CORE_TOKENS_DEFAULT, type JsonValue, ProjectError, STALE_AFTER_MS_DEFAULT } from "@pikit/contracts";
import Type, { type Static } from "typebox";
import { type DirectoryEnv, create, INDEX_KEY, indexed, list, locate, unindexed } from "./directory.ts";
import { answerProject, type ProjectActorEnv, projectIdOf, projectKey, purgeDue } from "./project.ts";
import { provideRoutes } from "./routes.ts";
import { CALL, projectsOver } from "./store.ts";
import { createTables } from "./tables.ts";

export { INDEX_KEY } from "./directory.ts";
export { type IndexEntry, projectKey, searchAttempts } from "./project.ts";
export { CALL, projectsOver } from "./store.ts";
export { worker } from "./worker.ts";

/** The wakeup that purges removed projects past their tombstone. */
export const PURGE = "projects-sql.purge";

const Config = Type.Object({
  /** The core documents' budget, in estimated tokens (`estimateTokens`): what `putDocument` keeps within. */
  coreTokens: Type.Integer({ minimum: 1, default: CORE_TOKENS_DEFAULT }),
  /** How long a sourced member counts after the sync that last checked it, in milliseconds. */
  staleAfterMs: Type.Integer({ minimum: 1_000, default: STALE_AFTER_MS_DEFAULT }),
});

export type ProjectsSqlConfig = Static<typeof Config>;

/** A handler whose `ProjectError`s (and malformed vocabulary) cross as the `ActorCallError` of their code. */
const refusing =
  (work: ActorCallHandler): ActorCallHandler =>
  async (key, message, ctx) => {
    try {
      return await work(key, message, ctx);
    } catch (error) {
      if (error instanceof ProjectError) throw new ActorCallError(error.code, error.message);
      if (error instanceof ChangeInputError) throw new ActorCallError("invalid", `projects-sql: ${error.message}`);
      throw error;
    }
  };

export default defineComponent({
  name: "projects-sql",
  config: Config,
  setup(pikit, config) {
    const sql = pikit.use("storage.sql");
    const mailbox = pikit.use("actor.mailbox");
    const inbox = pikit.use("actor.inbox");
    const wakeups = pikit.use("wakeups");
    const memory = pikit.useOptional("memory");
    const now = () => pikit.clock.now();

    const store = projectsOver(() => mailbox.get());
    pikit.provide("projects", store);
    provideRoutes(pikit, () => store);

    /** Asks for the purge at the earliest tombstone this App's rows hold, if any. */
    const planPurge = async (ctx: AppContext) => {
      const { due, next } = await purgeDue(sql.get(), now());
      const at = due.length > 0 ? now() : next;
      if (at !== undefined) await wakeups.get().at(PURGE, at, ctx);
    };

    return {
      async start(ctx) {
        const db = sql.get();
        await createTables(db);
        const options = { coreTokens: config.coreTokens, staleAfterMs: config.staleAfterMs };
        const env: ProjectActorEnv = { db, now, options };
        /** The directory's env for one call: `create` asks the project's actor in the call's context. */
        const directory = (callCtx: AppContext): DirectoryEnv => ({ db, now, options, init: (space, message) => mailbox.get().call(projectKey(space), CALL.project, message, callCtx) });
        const calls = inbox.get();

        calls.answer(CALL.create, refusing((key, message, callCtx) => create(directory(callCtx), key, message)));
        calls.answer(CALL.list, refusing((key, message, callCtx) => list(directory(callCtx), key, message)));
        calls.answer(CALL.locate, refusing((key, message, callCtx) => locate(directory(callCtx), key, message)));
        calls.answer(CALL.indexed, refusing((key, message, callCtx) => indexed(directory(callCtx), key, message)));
        calls.answer(CALL.unindexed, refusing((key, message, callCtx) => unindexed(directory(callCtx), key, message)));
        calls.answer(
          CALL.project,
          refusing(async (key, message, callCtx) => {
            const result = await answerProject(env, key, message);
            // After the commit: the directory learns the new version (a list may lag; never an access check).
            if (result.indexed !== undefined) {
              await mailbox
                .get()
                .call(INDEX_KEY, CALL.indexed, { entry: result.indexed as unknown as JsonValue }, callCtx)
                .catch((error: unknown) => callCtx.logger.warn("projects-sql: the directory was not told of a change", { error: error instanceof Error ? error.message : String(error) }));
            }
            if (result.removed === true) await planPurge(callCtx);
            return result.answer;
          }),
        );

        wakeups.get().handle(PURGE, async (wakeCtx) => {
          const { due, next } = await purgeDue(db, now());
          for (const space of due) {
            if (wakeCtx.abortSignal?.aborted) return void (await wakeups.get().at(PURGE, now(), wakeCtx));
            const id = await projectIdOf(db, space);
            if (id !== undefined) await mailbox.get().call(INDEX_KEY, CALL.unindexed, { space, id }, wakeCtx);
            await memory.get()?.purge({ type: "space", space }, wakeCtx);
            await answerProject(env, projectKey(space), { space, op: "purge", caller: "projects-sql" });
            wakeCtx.logger.info("projects-sql: a removed project was purged", { project: id ?? "" });
          }
          if (next !== undefined) await wakeups.get().at(PURGE, next, wakeCtx);
        });
        await planPurge(ctx);
      },
    };
  },
});

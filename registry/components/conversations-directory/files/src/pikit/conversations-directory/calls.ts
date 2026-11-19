/**
 * On Cloudflare, what the directory's actor (`conversations-directory:index`) answers, and what each
 * conversation's object answers it; every object registers them (any can answer), as admin-api's do.
 *
 * | Type | Message | Answer |
 * |---|---|---|
 * | `conversations-directory.seen` (`handle`) | `{ updates }` (`update.ts`), at most `SEEN_MAX` | (held once applied) |
 * | `conversations-directory.list` | `{ viewer, query, grants }` | `Page<DirectoryEntry>` |
 * | `conversations-directory.count` | `{ viewer, spaces, grants }` | `Record<space, number>` |
 * | `conversations-directory.access` | `{ viewer, ref, grants? }` | `{ entry? }`, or `{ needs: space }` |
 * | `conversations-directory.rename` | `{ viewer, ref, title, grants? }` | the same |
 * | `conversations-directory.set-state` | `{ viewer, ref, state, grants? }` | the same |
 * | `conversations-directory.mine` | `{ viewer, ref, change, grants? }` | the same |
 * | `conversations-directory.title` | `{ ref, title }` | `{}` |
 * | `conversations-directory.reset` (to the key's object) | `{ conversationId }` | `{ updates }`: what the reset did |
 *
 * Every message is checked on arrival with the contract's parsers; a refusal crosses as the
 * `ActorCallError` of its `DirectoryError` code. The grants are the calling App's (trusted code's).
 */

import type { AppContext } from "@pikit/core";
import { ActorCallError, type ActorCallHandler, type ActorInbox, AUDIENCE_MAX, DirectoryError, isEntryState, type JsonValue, parseViewer } from "@pikit/contracts";
import { CALL, json, listQuery, parseKeyRef, parseRef, parseSpaces, SEEN } from "./client.ts";
import type { DirectoryStore, Grant } from "./directory.ts";
import { parseSeen, type Update } from "./update.ts";

type Fields = Record<string, unknown>;
const fieldsOf = (message: JsonValue): Fields => (typeof message === "object" && message !== null && !Array.isArray(message) ? (message as Fields) : {});

/** The grants a call carries (`undefined`: none computed). */
function grantsOf(value: unknown): Grant[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > AUDIENCE_MAX) throw new DirectoryError("limit", `at most ${AUDIENCE_MAX} grants`);
  return value.map((each: unknown) => {
    const { space, role } = (typeof each === "object" && each !== null ? each : {}) as Fields;
    if (typeof space !== "string" || space === "" || (role !== "member" && role !== "owner")) throw new DirectoryError("invalid", "a grant is { space, role }");
    return { space, role };
  });
}

/** A handler whose `DirectoryError`s cross as the `ActorCallError` of their code. */
const refusing =
  (work: ActorCallHandler): ActorCallHandler =>
  async (key, message, ctx) => {
    try {
      return await work(key, message, ctx);
    } catch (error) {
      if (error instanceof DirectoryError) throw new ActorCallError(error.code, error.message);
      throw error;
    }
  };

export interface CallsOptions {
  store: DirectoryStore;
  /** In the key's own App: resets `key` when `conversationId` is still its current one. */
  reset(key: string, conversationId: string, ctx: AppContext): Promise<Update[]>;
}

/** Registers the directory's answers and the conversation's `reset` on `inbox`. Call it in `start`. */
export function answerCalls(inbox: ActorInbox, { store, reset }: CallsOptions): void {
  const viewerOf = (message: JsonValue) => parseViewer(fieldsOf(message).viewer);

  inbox.handle(SEEN, async (_key, message) => {
    try {
      await store.seen(parseSeen(message));
    } catch (error) {
      if (error instanceof DirectoryError) throw new ActorCallError(error.code, error.message);
      throw error;
    }
  });
  inbox.answer(
    CALL.list,
    refusing(async (_key, message) => {
      const viewer = viewerOf(message);
      return json(await store.list(viewer, listQuery(viewer, fieldsOf(message).query), grantsOf(fieldsOf(message).grants) ?? []));
    }),
  );
  inbox.answer(
    CALL.count,
    refusing(async (_key, message) => json(await store.count(viewerOf(message), parseSpaces(fieldsOf(message).spaces), grantsOf(fieldsOf(message).grants) ?? []))),
  );
  inbox.answer(
    CALL.access,
    refusing(async (_key, message) => json(await store.access(viewerOf(message), parseKeyRef(fieldsOf(message).ref), grantsOf(fieldsOf(message).grants)))),
  );
  inbox.answer(
    CALL.rename,
    refusing(async (_key, message) => {
      const { ref, title, grants } = fieldsOf(message);
      if (typeof title !== "string") throw new DirectoryError("invalid", "a title is a string");
      return json(await store.rename(viewerOf(message), parseRef(ref), title, grantsOf(grants)));
    }),
  );
  inbox.answer(
    CALL.setState,
    refusing(async (_key, message, ctx) => {
      const { ref, state, grants } = fieldsOf(message);
      if (!isEntryState(state)) throw new DirectoryError("invalid", "a state is listed, archived or deleted");
      return json(await store.setState(viewerOf(message), parseRef(ref), state, grantsOf(grants), ctx));
    }),
  );
  inbox.answer(
    CALL.mine,
    refusing(async (_key, message) => {
      const { ref, change, grants } = fieldsOf(message);
      return json(await store.mine(viewerOf(message), parseRef(ref), (fieldsOf(change as JsonValue) ?? {}) as never, grantsOf(grants)));
    }),
  );
  inbox.answer(
    CALL.title,
    refusing(async (_key, message) => {
      const { ref, title } = fieldsOf(message);
      const { text, source } = fieldsOf(title as JsonValue);
      if ((source !== "first" && source !== "model") || typeof text !== "string") throw new DirectoryError("invalid", "a title is { text, source: first or model }");
      await store.title(parseRef(ref), { text, source });
      return {};
    }),
  );
  inbox.answer(
    CALL.reset,
    refusing(async (key, message, ctx) => {
      const conversationId = fieldsOf(message).conversationId;
      if (typeof conversationId !== "string" || conversationId === "") throw new DirectoryError("invalid", "conversationId is a non-empty string");
      return json({ updates: await reset(key, conversationId, ctx) });
    }),
  );
}

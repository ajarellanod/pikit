// Owner: admission. Which conversation an event is, and where its answer goes (features/channel-google-chat.md "Conversations and routing").
/**
 * - **The key** (`eventKey`): `conversationKey(instance, space, thread)` (instance.ts's format) for a
 *   thread, `conversationKey(instance, space)` for a whole chat. A message's (or a click's message's)
 *   thread is its conversation when the space has threads (`SpaceThreading`) and the `conversations`
 *   setting says `"thread"` for it (`ModeOf`); otherwise the whole chat. An add or a removal is its
 *   space's whole chat. A payload this channel drops has no key (`undefined`).
 * - **Threads** (`createSpaceThreading`): the event's `space.spaceThreadingState`, else `spaces.get`'s,
 *   kept in `storage.kv` (`space:<name>`) where given, else in memory (the Worker's half has no
 *   `storage.kv`). A space that cannot be read counts as threaded (logged).
 * - **Answer targets** (`createAnswerTargets`): every answer goes to the thread of the message it
 *   answers (`REPLY_MESSAGE_OR_FAIL`). A thread's key says it; a whole chat's answers keep it in
 *   `storage.kv` (`thread:<answer key>`), written by the handler when it admits the message; an
 *   unthreaded chat's go to its top.
 *
 * The route builds the key (on a server in the one App, on Cloudflare in the Worker), so the same
 * function runs in both.
 */

import type { AppContext } from "@pikit/core";
import type { KeyValueStore } from "@pikit/contracts";
import type { AddOnEvent } from "./event.ts";
import type { Instance } from "./instance.ts";
import type { AnswerTargets, ChatApi, ModeOf, SpaceThreading } from "./types.ts";

export interface KeyDeps {
  instance: Instance;
  threading: SpaceThreading;
  mode: ModeOf;
}

/** The conversation key of `event` (above), or `undefined` when it has none. */
export async function eventKey(event: AddOnEvent, deps: KeyDeps, ctx: AppContext): Promise<string | undefined> {
  void event;
  void deps;
  void ctx;
  throw new Error("not implemented: admission (key.ts eventKey)");
}

/** Whether spaces have threads: the event's state, else `api.getSpace`'s, kept in `cache` (absent: in memory). */
export function createSpaceThreading(api: ChatApi, cache: KeyValueStore | undefined): SpaceThreading {
  void api;
  void cache;
  return {
    threaded: async () => {
      throw new Error("not implemented: admission (key.ts createSpaceThreading)");
    },
  };
}

/** Where answers go, from conversation keys and the `thread:` records in `store`. */
export function createAnswerTargets(store: KeyValueStore): AnswerTargets {
  void store;
  return {
    remember: async () => {
      throw new Error("not implemented: admission (key.ts createAnswerTargets)");
    },
    of: async () => {
      throw new Error("not implemented: admission (key.ts createAnswerTargets)");
    },
  };
}

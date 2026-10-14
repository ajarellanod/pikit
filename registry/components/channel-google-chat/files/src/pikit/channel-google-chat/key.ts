// Owner: admission. Which conversation an event is, and where its answer goes (features/channel-google-chat.md "Conversations and routing").
/**
 * - **The key** (`eventKey`): `conversationKey(instance, space, thread)` (instance.ts's format) for a
 *   thread, `conversationKey(instance, space)` for a whole chat. A message's thread is its
 *   conversation when the space has threads (`SpaceThreading`) and the `conversations` setting says
 *   `"thread"` for it (`ModeOf`); otherwise the whole chat. An add or a removal is its space's whole
 *   chat. **Every click** is the conversation its action's `key` parameter names (`KEY_PARAMETER`:
 *   every action of a card or a dialog carries the key it was drawn with), when that is a key of this
 *   instance in the click's space; never the setting of now, so a card stays its conversation's when
 *   the setting changes. click.ts then checks the key is its question's own.
 *   A payload this channel drops, or an event with no space, has no key (`undefined`).
 * - **Threads** (`createSpaceThreading`): the event's `space.spaceThreadingState`, else the state kept
 *   (in memory, then `storage.kv` under `space:<name>` where given: the Worker's half has no
 *   `storage.kv`), else `spaces.get`'s, then kept. A space that cannot be read counts as threaded
 *   (logged), and is asked again next time.
 * - **Answer targets** (`createAnswerTargets`): every answer goes to the thread of the message it
 *   answers (`REPLY_MESSAGE_OR_FAIL`). A thread's key says it; a whole chat's answers keep it in
 *   `storage.kv` (`thread:<answer key>`), written by the handler when it admits the message; an
 *   unthreaded chat's go to its top (recorded as no thread).
 *
 * The route builds the key (on a server in the one App, on Cloudflare in the Worker), so the same
 * function runs in both.
 */

import type { AppContext } from "@pikit/core";
import type { KeyValueStore } from "@pikit/contracts";
import { type AddOnEvent, type ChatMessage, type ChatSpace, eventKind, spaceOf } from "./event.ts";
import { conversationKey, type Instance, parseConversationKey } from "./instance.ts";
import type { AnswerTargets, ChatApi, ModeOf, SpaceThreading } from "./types.ts";

export interface KeyDeps {
  instance: Instance;
  threading: SpaceThreading;
  mode: ModeOf;
}

/** The action parameter every question's action carries: the conversation key the card was drawn in, how a click is keyed. */
export const KEY_PARAMETER = "key";

/** Where the threading state of a space is kept in `storage.kv`. */
export const spaceStateKey = (space: string): string => `space:${space}`;
/** Where the thread of a whole chat's answer is kept in `storage.kv`. */
export const answerThreadKey = (answerKey: string): string => `thread:${answerKey}`;

/** `message`'s thread when it is one of `space`'s (`spaces/AAA/threads/BBB`), else `undefined`. */
export function threadOf(message: ChatMessage | undefined, space: string): string | undefined {
  const thread = message?.thread?.name;
  return thread !== undefined && thread.startsWith(`${space}/threads/`) && thread.length > `${space}/threads/`.length ? thread : undefined;
}

/** The conversation key of `event` (above), or `undefined` when it has none. */
export async function eventKey(event: AddOnEvent, deps: KeyDeps, ctx: AppContext): Promise<string | undefined> {
  const kind = eventKind(event);
  if (kind === "other") return undefined;
  const space = spaceOf(event);
  if (space === undefined) return undefined;
  const whole = conversationKey(deps.instance.instance, space.name);
  if (kind === "added" || kind === "removed") return whole;

  if (kind === "click") {
    const named = event.commonEventObject?.parameters?.[KEY_PARAMETER];
    const parts = named === undefined ? undefined : parseConversationKey(named);
    return parts !== undefined && parts.instance === deps.instance.instance && parts.space === space.name ? named : undefined;
  }
  const thread = threadOf(event.chat.messagePayload?.message, space.name);
  if (thread === undefined) return whole;
  if ((await deps.mode(space.name, ctx)) !== "thread") return whole;
  if (!(await deps.threading.threaded(space, ctx))) return whole;
  return conversationKey(deps.instance.instance, space.name, thread);
}

/** Whether a threading state has threads: every state but `UNTHREADED_MESSAGES`. */
const hasThreads = (state: string): boolean => state !== "UNTHREADED_MESSAGES";

/** Whether spaces have threads: the event's state, else the one kept (memory, then `cache`), else `api.getSpace`'s, kept in both. */
export function createSpaceThreading(api: ChatApi, cache: KeyValueStore | undefined): SpaceThreading {
  const known = new Map<string, boolean>();
  return {
    async threaded(space: ChatSpace, ctx: AppContext): Promise<boolean> {
      const given = space.spaceThreadingState;
      if (given !== undefined && given !== "THREADING_STATE_UNSPECIFIED") return hasThreads(given);
      const remembered = known.get(space.name);
      if (remembered !== undefined) return remembered;
      try {
        const kept = await cache?.get<boolean>(spaceStateKey(space.name));
        if (typeof kept === "boolean") {
          known.set(space.name, kept);
          return kept;
        }
        const state = (await api.getSpace(space.name, ctx.abortSignal)).spaceThreadingState;
        if (state === undefined || state === "THREADING_STATE_UNSPECIFIED") return true;
        const threaded = hasThreads(state);
        known.set(space.name, threaded);
        await cache?.set(spaceStateKey(space.name), threaded);
        return threaded;
      } catch (error) {
        ctx.logger.warn("channel-google-chat: whether a space has threads could not be read; it counts as threaded", { space: space.name, error: error instanceof Error ? error.message : String(error) });
        return true;
      }
    },
  };
}

/** Where answers go, from conversation keys and the `thread:` records in `store`. */
export function createAnswerTargets(store: KeyValueStore): AnswerTargets {
  return {
    async remember(answerKey, thread) {
      await store.set(answerThreadKey(answerKey), thread ?? null);
    },
    async of(conversationKey, answerKey) {
      const parts = parseConversationKey(conversationKey);
      if (parts === undefined) return undefined;
      if (parts.thread !== undefined) return { space: parts.space, thread: parts.thread };
      const thread = await store.get(answerThreadKey(answerKey));
      return typeof thread === "string" && thread.startsWith(`${parts.space}/threads/`) ? { space: parts.space, thread } : { space: parts.space };
    },
  };
}

// Owner: transport. "Thinking…", written as the model writes, and what is left of it (features/channel-google-chat.md "Thinking…").
/**
 * index.ts calls these for the conversations of this instance only, never for a dashboard request.
 *
 * - **`started`**: creates the placeholder (`thinkingText`) where the answer goes
 *   (`targets.of(conversation.key, answerKey(conversation, requestId))`), under the ids of the answer's
 *   piece `#0` (ids.ts `pieceIds(pieceKeyOf(answerKey, 0))`), so the answer's first piece edits it with
 *   no record. A resumed run (`resumed: true`) creates it again: Google returns the first (`requestId`)
 *   or refuses it (`ALREADY_EXISTS`), and either way there is one. Marked (`marks.add`).
 * - **`partial`**: edits the placeholder with the answer so far (`chatTextOf`, its first `PIECE_CHARS`
 *   characters), at most once every `previewEveryMs` per answer (0: never), throttled in memory; a
 *   preview lost costs nothing, and none is sent after the run settled.
 * - **`settled`**: a run with nothing to send (reply.ts `nothingToSend`: aborted, or completed with no
 *   text and no parts) deletes its placeholder and its mark; any other is replaced by answer delivery's
 *   piece `#0` (a failed run's with the channel's failure text, reply.ts `replyText`).
 * - **`sweep`** (a wakeup at start): every mark of this instance whose request is settled
 *   (`submissions.get`) with nothing left to send is deleted with its message; one settled with
 *   something to send is dropped (delivery replaces its message), as is one whose request is unknown;
 *   a pending one is kept (its run goes on).
 * - **The preview gate** (`previewGateOf(marks)`, in memory, shared with the transport through the
 *   marks object both get): the transport closes an answer's gate before its piece `#0` and waits for
 *   the placeholder's call in flight (its creation, a preview), so no preview lands over the answer and
 *   piece `#0` never races the creation of the message it edits. A preview whose call timed out
 *   (`maybeSent`) is told to the gate (`timedOut`) before its call ends: it may land later, and the
 *   transport then applies piece `#0` again after a while (transport.ts).
 *
 * Failures are logged and never thrown to the run (`started`, `partial`, `settled` resolve);
 * `sweep` rejects to be run again, once it tried every mark.
 *
 * Marks, in `storage.kv`: `placeholder:<answer key>` (the mark) and `placeholders` (the answer keys
 * marked: `storage.kv` lists nothing). Written one at a time in this process.
 */

import type { Clock } from "@pikit/core";
import { type AgentSubmissions, answerKey, type JsonValue, type KeyValueStore } from "@pikit/contracts";
import { chatTextOf, PIECE_CHARS } from "./format.ts";
import { messageNameOf, pieceIds, pieceKeyOf } from "./ids.ts";
import { type Instance, parseConversationKey } from "./instance.ts";
import { nothingToSend } from "./reply.ts";
import { type AnswerTargets, type ChatApi, ChatApiError, type PlaceholderMark, type PlaceholderMarks, type Placeholders } from "./types.ts";

export interface PlaceholderDeps {
  instance: Instance;
  api: ChatApi;
  targets: AnswerTargets;
  marks: PlaceholderMarks;
  submissions: AgentSubmissions;
  /** `Config.thinkingText`. */
  thinkingText: string;
  /** `Config.previewEveryMs`. */
  previewEveryMs: number;
  clock: Clock;
}

/** What the transport and the placeholders of an answer share in memory: whether previews may still be written. */
export interface PreviewGate {
  /** Runs `work` (a creation, a preview) unless the gate is closed or another one is in flight; `false` when it did not. */
  run(answerKey: string, work: () => Promise<void>): Promise<boolean>;
  /** No more previews of `answerKey`; resolves once the call in flight, if any, ended. */
  close(answerKey: string): Promise<void>;
  closed(answerKey: string): boolean;
  /** A preview of `answerKey` whose call timed out (`maybeSent`): it may still land, over the answer. */
  timedOut(answerKey: string): void;
  /** Whether a preview of `answerKey` timed out: the transport applies piece `#0` again after a while. */
  uncertain(answerKey: string): boolean;
}

/** The answers closed that a gate remembers, the oldest forgotten first: enough for every run in flight. */
const CLOSED_KEPT = 1_000;
const gates = new WeakMap<PlaceholderMarks, PreviewGate>();

/** The gate of the placeholders whose marks are `marks` (the transport and the placeholders of an instance get the same marks). */
export function previewGateOf(marks: PlaceholderMarks): PreviewGate {
  let gate = gates.get(marks);
  if (gate !== undefined) return gate;
  const inFlight = new Map<string, Promise<void>>();
  const closed = new Set<string>();
  const late = new Set<string>();
  /** Adds `key` to `set`, the oldest forgotten past `CLOSED_KEPT`. */
  const keep = (set: Set<string>, key: string) => {
    set.delete(key);
    set.add(key);
    if (set.size > CLOSED_KEPT) set.delete(set.values().next().value as string);
  };
  gate = {
    async run(answerKey, work) {
      if (closed.has(answerKey) || inFlight.has(answerKey)) return false;
      const running = work().finally(() => inFlight.delete(answerKey));
      inFlight.set(answerKey, running.catch(() => {}));
      await running;
      return true;
    },
    async close(answerKey) {
      keep(closed, answerKey);
      await inFlight.get(answerKey);
    },
    closed: (answerKey) => closed.has(answerKey),
    timedOut: (answerKey) => keep(late, answerKey),
    uncertain: (answerKey) => late.has(answerKey),
  };
  gates.set(marks, gate);
  return gate;
}

const isNotFound = (error: unknown): boolean => error instanceof ChatApiError && error.status === 404;
const isAlreadyThere = (error: unknown): boolean => error instanceof ChatApiError && (error.status === 409 || error.code === "ALREADY_EXISTS");
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The placeholders of one instance. */
export function createPlaceholders(deps: PlaceholderDeps): Placeholders {
  const { api, marks, clock } = deps;
  const gate = previewGateOf(marks);
  /** The placeholders this process created and whose run goes on: where previews go, and when the last one went. */
  const live = new Map<string, { message: string; lastAt: number; lastText: string }>();

  /** Deletes `mark`'s message (already gone is fine) and the mark. */
  const remove = async (mark: Pick<PlaceholderMark, "answerKey" | "message">): Promise<void> => {
    await api.deleteMessage(mark.message).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
    await marks.remove(mark.answerKey);
  };

  return {
    async started({ conversation, requestId }, ctx) {
      const key = answerKey(conversation, requestId);
      try {
        if (gate.closed(key)) return;
        const target = await deps.targets.of(conversation.key, key);
        if (target === undefined) return;
        const ids = await pieceIds(pieceKeyOf(key, 0));
        const message = messageNameOf(target.space, ids.messageId);
        // Marked first: a crash after the creation leaves a mark the sweep reads, never a message nobody knows.
        await marks.add({ answerKey: key, conversationKey: conversation.key, conversationId: conversation.conversationId, requestId, message, at: clock.now() });
        await gate.run(key, async () => {
          // A resumed run's again: Google returns the first (`requestId`) or refuses it (`messageId`).
          await api
            .createMessage(target.space, { text: deps.thinkingText }, { ...(target.thread !== undefined && { thread: target.thread }), requestId: ids.requestId, messageId: ids.messageId })
            .catch((error: unknown) => {
              if (!isAlreadyThere(error)) throw error;
            });
          live.set(key, { message, lastAt: clock.now(), lastText: deps.thinkingText });
        });
      } catch (error) {
        ctx.logger.warn("channel-google-chat: the placeholder could not be created; the answer is sent without it", { conversation: conversation.key, run: requestId, error: describe(error) });
      }
    },

    async partial({ conversation, requestId, text }, ctx) {
      if (deps.previewEveryMs <= 0) return;
      const key = answerKey(conversation, requestId);
      const placeholder = live.get(key);
      if (placeholder === undefined || gate.closed(key) || clock.now() - placeholder.lastAt < deps.previewEveryMs) return;
      const preview = chatTextOf(text).slice(0, PIECE_CHARS);
      if (preview.trim() === "" || preview === placeholder.lastText) return;
      try {
        await gate.run(key, async () => {
          placeholder.lastAt = clock.now();
          try {
            await api.updateMessage(placeholder.message, { text: preview }, ["text"]);
          } catch (error) {
            // Before the gate lets piece #0 go: it applies the answer again over a preview that lands late.
            if (error instanceof ChatApiError && error.maybeSent) gate.timedOut(key);
            throw error;
          }
          placeholder.lastText = preview;
        });
      } catch (error) {
        // A preview lost costs nothing: the next one, or the answer, says it.
        ctx.logger.debug("channel-google-chat: a preview of the answer could not be written", { conversation: conversation.key, run: requestId, error: describe(error) });
      }
    },

    async settled(result, ctx) {
      const key = answerKey(result.conversation, result.requestId);
      try {
        await gate.close(key);
        const placeholder = live.get(key);
        live.delete(key);
        if (!nothingToSend(result)) return;
        const mark = placeholder === undefined ? (await marks.list()).find((each) => each.answerKey === key) : { answerKey: key, message: placeholder.message };
        if (mark !== undefined) await remove(mark);
      } catch (error) {
        ctx.logger.warn("channel-google-chat: the placeholder of a run with nothing to say could not be deleted; the sweep at the next start does", { conversation: result.conversation.key, run: result.requestId, error: describe(error) });
      }
    },

    async sweep(ctx) {
      let failure: unknown;
      for (const mark of await marks.list()) {
        if (parseConversationKey(mark.conversationKey)?.instance !== deps.instance.instance || live.has(mark.answerKey)) continue;
        try {
          const status = await deps.submissions.get({ conversationId: mark.conversationId }, mark.requestId, ctx);
          if (status?.kind === "pending") continue;
          if (status !== undefined && nothingToSend(status.run)) await remove(mark);
          else await marks.remove(mark.answerKey);
        } catch (error) {
          failure ??= error;
          ctx.logger.warn("channel-google-chat: a placeholder left by a crash could not be swept; tried again", { conversation: mark.conversationKey, run: mark.requestId, error: describe(error) });
        }
      }
      if (failure !== undefined) throw failure;
    },
  };
}

/** The placeholder marks in `store` (`placeholder:` prefix), shared by every instance. */
export function createPlaceholderMarks(store: KeyValueStore): PlaceholderMarks {
  const INDEX = "placeholders";
  const markKey = (answerKey: string): string => `placeholder:${answerKey}`;
  let queue: Promise<unknown> = Promise.resolve();
  /** One read-modify-write of the index at a time. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };
  const keys = async (): Promise<string[]> => (await store.get<string[]>(INDEX)) ?? [];
  return {
    add: (mark) =>
      serial(async () => {
        // The index first: a crash before the mark leaves an entry `list` drops, never a mark nobody lists.
        const known = await keys();
        if (!known.includes(mark.answerKey)) await store.set(INDEX, [...known, mark.answerKey]);
        await store.set(markKey(mark.answerKey), mark as unknown as JsonValue);
      }),
    remove: (answerKey) =>
      serial(async () => {
        await store.delete(markKey(answerKey));
        const known = await keys();
        if (known.includes(answerKey)) await store.set(INDEX, known.filter((each) => each !== answerKey));
      }),
    list: () =>
      serial(async () => {
        const known = await keys();
        const found: PlaceholderMark[] = [];
        for (const key of known) {
          const mark = await store.get<JsonValue>(markKey(key));
          if (mark !== undefined) found.push(mark as unknown as PlaceholderMark);
        }
        if (found.length < known.length) await store.set(INDEX, found.map((mark) => mark.answerKey));
        return found;
      }),
  };
}

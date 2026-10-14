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
 * - **`settled`**: a run with nothing to send (aborted, or completed with no text and no parts) deletes
 *   its placeholder and its mark; any other is replaced by answer delivery's piece `#0` (a failed run's
 *   with the channel's failure text, index.ts `replyText`).
 * - **`sweep`** (a wakeup at start): every mark whose request is settled (`submissions.get`) with
 *   nothing left to send is deleted with its message; a mark whose request is unknown is dropped.
 *
 * Failures are logged and never thrown to the run (`started`, `partial`, `settled` resolve);
 * `sweep` rejects to be run again.
 */

import type { Clock } from "@pikit/core";
import type { AgentSubmissions, KeyValueStore } from "@pikit/contracts";
import type { Instance } from "./instance.ts";
import type { AnswerTargets, ChatApi, PlaceholderMarks, Placeholders } from "./types.ts";

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

/** The placeholders of one instance. */
export function createPlaceholders(deps: PlaceholderDeps): Placeholders {
  void deps;
  const missing = async (): Promise<never> => {
    throw new Error("not implemented: transport (placeholder.ts createPlaceholders)");
  };
  return { started: missing, partial: missing, settled: missing, sweep: missing };
}

/** The placeholder marks in `store` (`placeholder:` prefix), shared by every instance. */
export function createPlaceholderMarks(store: KeyValueStore): PlaceholderMarks {
  void store;
  const missing = async (): Promise<never> => {
    throw new Error("not implemented: transport (placeholder.ts createPlaceholderMarks)");
  };
  return { add: missing, remove: missing, list: missing };
}

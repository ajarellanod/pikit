// Owner: admission. A message, an add or a removal, in the conversation's actor (features/channel-google-chat.md "Identity", "Access", "Attachments in", "Quoted messages").
/**
 * The same code on both targets: on a server the route calls it in process, on Cloudflare the
 * conversation's object calls it from `actor.inbox` (`google-chat.event`). index.ts wakes answer
 * delivery after an `admitted` or `duplicate`.
 *
 * - **A message** (`messagePayload`): from a space not in `Credentials.allowedSpaces`, refused (the
 *   route already told it: this is a guard). A message from a bot, or with no text, attachment or
 *   quote, is `done` with nothing admitted. `/new` (alone, after the mention) resets the conversation
 *   (`conversations.reset(key, undefined, ctx)`) and says so in the thread (`api.createMessage`).
 *   Otherwise an `InboundMessage`: `id` the message's `name`, `channel` the instance, `conversationId`
 *   the space, `actor.id` the sender's `users/…`; its text the message's without the app's mention
 *   (`argumentText`, else `text` with `USER_MENTION` annotations of the app removed), prefixed by the
 *   sender's display name in a space or group chat (not in a DM); the quoted message before it
 *   (quote.ts); text files appended and images as `images` (attachments.ts). `admitInbound` with the
 *   key, and `beforeDispatch(conversation)`: the answer's thread recorded
 *   (`targets.remember(answerKey(conversation, message.id), thread)`) for a whole chat, other files
 *   written to the conversation's workspace (attachments.ts `writeFiles`). NB: `beforeDispatch` is
 *   synchronous in `AdmitOptions`; what must finish before `dispatch` (a file written) needs either a
 *   contract change (`void | Promise<void>`, awaited by `admitInbound`, with its test) or another way:
 *   decide it, and say it in docs/contracts.md if the contract changes.
 *   Outcomes: `admitted` and `duplicate` returned; `denied` told in the thread once; `halted` and
 *   `no_route` logged, `done`. Downloads happen before admission, within `deadlineMs`.
 * - **An add** (`addedToSpacePayload`): logged; `done`.
 * - **A removal** (`removedFromSpacePayload`): logged; `done` (answers still owed there fail
 *   `permanent` in the transport).
 *
 * Rejects when the message could not be admitted (a capability failed): Google sends it again, and
 * the runtime answers `duplicate` for one it already holds.
 */

import type { AdmissionDeps, EventHandler } from "./types.ts";

/** How long, in ms, downloads and quotes may take before admission: under Google's 30 s with the route's hand-off. */
export const DOWNLOAD_DEADLINE_MS = 20_000;

/** The handler of one instance's events. */
export function createEventHandler(deps: AdmissionDeps): EventHandler {
  void deps;
  return async () => {
    throw new Error("not implemented: admission (handler.ts createEventHandler)");
  };
}

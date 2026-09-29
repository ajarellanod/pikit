/**
 * `actor.mailbox` and `actor.inbox` (SPEC §4.1, C2): how a channel reaches the actor that owns a
 * conversation without knowing where that actor runs. The channel sends; the actor handles.
 *
 * - **An actor is named by a key** (a conversation key, `"telegram:123"`). On a server every key's
 *   actor is the App itself (`mailbox-local`); on Cloudflare it is the Durable Object
 *   `idFromName(key)`, reached by RPC. The sender never names a process or an object.
 * - **A message has a type**, and the actor handles it with the `actor.inbox` handler provided under
 *   that type (`pikit.provideKeyed("actor.inbox", "telegram.update", handler)`).
 * - **A message is JSON** (`JsonValue`). The handler gets a copy, as it would across an RPC: changing
 *   it changes nothing the sender holds, and a value that is not JSON (`undefined`, a function) is
 *   refused.
 *
 * What `send` promises is the channel's acknowledgement point: it resolves once the actor holds the
 * message durably (its handler resolved), and rejects otherwise, so the channel does not acknowledge
 * its platform and the platform delivers again. A rejection does not mean nothing happened: the
 * handler may have committed the message and failed to answer. Delivery is therefore at-least-once,
 * and a handler recognises a message it already holds (by an id inside the message: Telegram's
 * `update_id`, an HTTP `messageId`).
 *
 * `actor.inbox` stays a keyed capability, although the mailbox's provider then depends on every
 * handler it calls: C1 splits each channel into a Worker half that sends and an object half that
 * handles, two components, so none both provides a handler and uses `actor.mailbox` and there is no
 * dependency cycle. (`wakeups` registers its handlers with `handle` instead, because there the
 * component that handles is the one that asks.)
 *
 * Pi first: one Pi process runs a session; which process or object runs which conversation, and how
 * a message gets there, is what pikit adds (P1).
 */

import type { AppContext } from "@pikit/core";
import type { JsonValue } from "./storage.ts";

export interface ActorMailbox {
  /**
   * Delivers `message` of `type` to the actor that owns `key`, and resolves once that actor's
   * `actor.inbox` handler for `type` resolved, that is once the actor holds it durably.
   *
   * Rejects, so the caller does not acknowledge its platform, when:
   * - no `actor.inbox` handler is provided for `type` where the actor runs (the error names the type
   *   and says which component to install);
   * - `key` is empty, or `message` is not JSON (nothing is delivered);
   * - the handler rejects, or the actor cannot be reached;
   * - `ctx` is cancelled before the handler resolved. The caller stops waiting; the handler, which
   *   has its own context, may still finish.
   *
   * Sends are not ordered and may be handled concurrently, even for one key: an actor that needs an
   * order keeps it in its own state.
   */
  send(key: string, type: string, message: JsonValue, ctx: AppContext): Promise<void>;
}

/**
 * The actor's side: handles one type of message for the actor `key`. Resolve once the message is
 * durable (committed to the actor's storage, admitted by its runtime); do the slow work (a run) after,
 * not before, so the sender's platform is acknowledged promptly. Reject when it could not be kept: the
 * sender's platform delivers again. Handle a message you already hold as a success.
 *
 * `ctx` is the handler's own: it carries the actor App's values, and its cancellation fires when the
 * actor's App stops, never when the sender stops waiting.
 */
export type ActorInboxHandler = (key: string, message: JsonValue, ctx: AppContext) => Promise<void>;

declare module "@pikit/core" {
  interface AppCapabilities {
    "actor.mailbox": ActorMailbox;
  }
  interface AppKeyedCapabilities {
    /** Keyed by the message type `actor.mailbox`'s `send` names. */
    "actor.inbox": ActorInboxHandler;
  }
}

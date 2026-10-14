// Owner: ingress. The endpoint's http.route handler (features/channel-google-chat.md "Ingress", "Access").
/**
 * `POST <instance path>`, the endpoint URL of every trigger of the Chat app. The same handler on both
 * targets; what it hands events to is its `EventSink` (index.ts chooses it by `actor.inbox`'s scope:
 * the handler in process on a server, `actor.mailbox` on Cloudflare).
 *
 * For each request, in order:
 * 1. **The token** (`IdTokenVerifier`): a refusal answers `401` (the reason logged, never sent), and
 *    nothing else is read. Google's keys not reachable: `500`.
 * 2. **The event** (`readEvent`): not an add-on event of Chat answers `400`. A payload this channel
 *    does not handle (`eventKind` `other`) answers `{}`.
 * 3. **Access**: the event's space (`spaceOf`) must be in `Credentials.allowedSpaces`. A stranger space
 *    is answered, in the response (`createMessageAction`), that the app is not allowed there, with the
 *    space's id for the operator, on `ADDED_TO_SPACE` and on its messages (once per space while the
 *    process or isolate lives, then `{}`); a click from it is answered with a notice; nothing is
 *    handed on. A removal from a stranger space is acknowledged.
 * 4. **The key** (`KeyOf`, key.ts): `undefined` answers `{}`.
 * 5. **Hand-off**: a message, an add or a removal goes to `sink.event` within a deadline under Google's
 *    30 s (a value), and is answered `{}` (JSON, `content-type: application/json`) once it resolves; a
 *    rejection or the deadline answers `500` (logged), and Google may send it again. A click goes to
 *    `sink.click`, and its response (`AddOnResponse`) is the answer, as JSON; a failure answers `500`.
 *
 * Never logs a token, a message's text or a credential.
 */

import type { AppContext } from "@pikit/core";
import type { Credentials, Instance } from "./instance.ts";
import type { EventSink, IdTokenVerifier, KeyOf } from "./types.ts";

export interface RouteDeps {
  instance: Instance;
  credentials: Credentials;
  verifier: IdTokenVerifier;
  keyOf: KeyOf;
  sink: EventSink;
}

/** The deadline, in ms, of a hand-off: under Google's 30 s for an answer to an event. */
export const HAND_OFF_MS = 25_000;

/** The handler of `POST <deps.instance.path>`. */
export function createRoute(deps: RouteDeps): (request: Request, ctx: AppContext) => Promise<Response> {
  void deps;
  return async () => {
    throw new Error("not implemented: ingress (route.ts createRoute)");
  };
}

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
 *    handed on. A removal from a stranger space is acknowledged. An event with no space is dropped.
 * 4. **The key** (`KeyOf`, key.ts): `undefined` answers `{}`; a failure answers `500`.
 * 5. **Hand-off**: a message, an add or a removal goes to `sink.event` within a deadline under Google's
 *    30 s (a value), and is answered `{}` (JSON, `content-type: application/json`) once it resolves; a
 *    rejection or the deadline answers `500` (logged), and Google may send it again. A click goes to
 *    `sink.click`, and its response (`AddOnResponse`) is the answer, as JSON; a failure answers `500`.
 *    The sink's context is cancelled at the deadline. What is handed on is the event without its
 *    `authorizationEventObject`: the token, checked, goes no further (no mailbox, no store).
 *
 * Never logs a token, a message's text or a credential.
 */

import { type AppContext, withAbortSignal } from "@pikit/core";
import { ACKNOWLEDGED, type AddOnEvent, type AddOnResponse, eventKind, readEvent, spaceOf } from "./event.ts";
import type { Credentials, Instance } from "./instance.ts";
import type { EventSink, IdTokenVerifier, KeyOf } from "./types.ts";

export interface RouteDeps {
  instance: Instance;
  credentials: Credentials;
  verifier: IdTokenVerifier;
  keyOf: KeyOf;
  sink: EventSink;
  /** The hand-off's deadline, in ms: `HAND_OFF_MS` by default. A value, for tests. */
  handOffMs?: number;
}

/** The deadline, in ms, of a hand-off: under Google's 30 s for an answer to an event. */
export const HAND_OFF_MS = 25_000;
/** Stranger spaces told, per instance, remembered while the process or isolate lives; at most this many. */
const STRANGERS_REMEMBERED = 1_000;

/** What a stranger space is told, with its id and where the operator allows it. */
export function strangerText(instance: Instance, space: string): string {
  return `This app is not allowed in this space. Its id is ${space}: the app's operator can allow it by adding it to ${instance.secrets.allowedSpaces}.`;
}

const json = (body: AddOnResponse): Response => Response.json(body);
const status = (code: number, text: string): Response => new Response(text, { status: code, headers: { "content-type": "text/plain; charset=utf-8" } });
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The event without its tokens (`authorizationEventObject`), as it is handed on. */
function withoutTokens(event: AddOnEvent): AddOnEvent {
  const { authorizationEventObject, ...rest } = event;
  void authorizationEventObject;
  return rest;
}

/** `work(ctx)` with a context cancelled after `ms`; rejects at the deadline even if `work` does not stop. */
async function within<T>(ms: number, ctx: AppContext, work: (ctx: AppContext) => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(`not handled within ${ms} ms`)), ms);
  const bounded = ctx.derive((context) => withAbortSignal(deadline.signal, context));
  const signal = bounded.abortSignal as AbortSignal;
  try {
    signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      work(bounded)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  } finally {
    clearTimeout(timer);
  }
}

/** The handler of `POST <deps.instance.path>`. */
export function createRoute(deps: RouteDeps): (request: Request, ctx: AppContext) => Promise<Response> {
  const { instance, credentials, verifier, keyOf, sink } = deps;
  const handOffMs = deps.handOffMs ?? HAND_OFF_MS;
  const told = new Set<string>();
  const fields = (more: Record<string, unknown> = {}) => ({ instance: instance.instance, ...more });

  /** A stranger space's answer: told once, then `{}`. */
  const stranger = (space: string, kind: "message" | "added" | "removed" | "click", ctx: AppContext): Response => {
    if (kind === "removed") {
      ctx.logger.info("channel-google-chat: the app was removed from a space it is not allowed in", fields({ space }));
      return json(ACKNOWLEDGED);
    }
    ctx.logger.warn("channel-google-chat: an event from a space that is not allowed", fields({ space, kind }));
    const text = strangerText(instance, space);
    if (kind === "click") return json({ action: { notification: { text } } });
    if (told.has(space)) return json(ACKNOWLEDGED);
    if (told.size >= STRANGERS_REMEMBERED) told.clear();
    told.add(space);
    return json({ hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text } } } } });
  };

  return async (request, ctx) => {
    // 1. The token, before anything else is read.
    let verification: Awaited<ReturnType<IdTokenVerifier["verify"]>>;
    try {
      verification = await verifier.verify(request.headers.get("authorization"), ctx.abortSignal);
    } catch (error) {
      ctx.logger.error("channel-google-chat: Google's signing keys could not be read; Google will send the event again", fields({ error: errorText(error) }));
      return status(500, "the token could not be checked");
    }
    if (!verification.ok) {
      ctx.logger.warn("channel-google-chat: a request whose token is refused", fields({ reason: verification.reason }));
      return status(401, "unauthorized");
    }

    // 2. The event.
    const event = readEvent(await request.json().catch(() => undefined));
    if (event === undefined) {
      ctx.logger.warn("channel-google-chat: a request that is not an add-on event of Chat", fields());
      return status(400, "not an add-on event of Google Chat");
    }
    const kind = eventKind(event);
    if (kind === "other") return json(ACKNOWLEDGED);

    // 3. Access.
    const space = spaceOf(event)?.name;
    if (space === undefined) {
      ctx.logger.warn("channel-google-chat: an event with no space, dropped", fields({ kind }));
      return json(ACKNOWLEDGED);
    }
    if (!credentials.allowedSpaces.has(space)) return stranger(space, kind, ctx);

    // 4. The key.
    let key: string | undefined;
    try {
      key = await keyOf(event, ctx);
    } catch (error) {
      ctx.logger.error("channel-google-chat: the event's conversation could not be told; Google will send it again", fields({ space, kind, error: errorText(error) }));
      return status(500, "not taken");
    }
    if (key === undefined) return json(ACKNOWLEDGED);

    // 5. The hand-off.
    const handed = withoutTokens(event);
    if (kind === "click") {
      try {
        return json(await within(handOffMs, ctx, (bounded) => sink.click(key, handed, bounded)));
      } catch (error) {
        ctx.logger.error("channel-google-chat: a click could not be answered", fields({ conversation: key, error: errorText(error) }));
        return status(500, "not answered");
      }
    }
    try {
      await within(handOffMs, ctx, (bounded) => sink.event(key, handed, bounded));
    } catch (error) {
      ctx.logger.error("channel-google-chat: the conversation could not take an event; Google will send it again", fields({ conversation: key, kind, error: errorText(error) }));
      return status(500, "not taken");
    }
    return json(ACKNOWLEDGED);
  };
}

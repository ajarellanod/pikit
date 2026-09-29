/**
 * Where the object's half registers its `actor.inbox` handler: the only place that knows how.
 *
 * Today `actor.inbox` is a keyed capability, provided in `setup` (`provideKeyed("actor.inbox", type,
 * handler)`), and `start` has nothing to do. A decided contract change makes it a single capability
 * with registration by method, as `wakeups.handle`: `use("actor.inbox")` in `setup`, then
 * `.handle(type, handler)` in `start`. Switching is this file alone:
 *
 *   const inbox = pikit.use("actor.inbox");
 *   return { start: () => inbox.get().handle(type, handler) };
 */

import type { Pikit } from "@pikit/core";
import type { ActorInboxHandler } from "@pikit/contracts";

export interface InboxRegistration {
  /** Call in the component's `start`, once its handler can run. */
  start(): void;
}

/** Registers `handler` for messages of `type` sent through `actor.mailbox`. Call in `setup`. */
export function registerInbox(pikit: Pikit, type: string, handler: ActorInboxHandler): InboxRegistration {
  pikit.provideKeyed("actor.inbox", type, handler);
  return { start() {} };
}

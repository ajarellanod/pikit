/**
 * `SANDBOX_OBJECT`: what a `Sandbox` Durable Object puts on its App's start context (`object.ts`), and
 * the default half (`index.ts`) reads in `start`: the object's container and storage, and the hooks its
 * RPC `serve` and its alarm call. This component's own, between its files, as `WORKERS_HOST` is
 * deployment-cloudflare's: absent in any other App (a `Conversation` object, a server), where the half
 * does nothing.
 */

import { type ContextKey, createContextKey } from "@pikit/core";
import type { SandboxContainer } from "./container.ts";
import type { ObjectStorage, SandboxReply, SandboxRequest } from "./sandbox.ts";

export interface SandboxObject {
  container: SandboxContainer;
  storage: ObjectStorage;
  /** One handler: the object's RPC `serve` calls it. */
  onServe(handler: (request: SandboxRequest) => Promise<SandboxReply>): void;
  /** One handler: the object's alarm calls it. */
  onAlarm(handler: () => Promise<void>): void;
}

export const SANDBOX_OBJECT: ContextKey<SandboxObject> = createContextKey<SandboxObject>("execution-cloudflare-sandbox.object");

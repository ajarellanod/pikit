/**
 * The Cloudflare platform, in the start context of an App that runs on it (SPEC §4.1, C5).
 *
 * `deployment-cloudflare`'s entrypoints put a `WorkersHost` on each App's start context: the Worker's
 * `env` in both Apps, and in a Durable Object's App the object itself. The few components that must
 * touch the platform (`storage-do`, `secrets-cloudflare`, `platform-cloudflare`) read it in `start`:
 *
 *   start(ctx) {
 *     const object = ctx.value(WORKERS_HOST)?.object;
 *     if (object === undefined) throw new Error("my-component: runs only in a Durable Object's App");
 *   }
 *
 * `undefined` means the App does not run on Cloudflare (a server, a test that did not put one).
 *
 * A context key, like `CONVERSATION`, and not a capability: nothing provides it, and no component
 * chooses among several. Its types are structural, so no `cloudflare:*` import leaves the
 * entrypoints: a component types what it uses of `storage` (or of an `env` binding) itself.
 */

import { type ContextKey, createContextKey } from "@pikit/core";
import type { JsonValue } from "./json.ts";

export interface WorkersHost {
  /** The Worker's bindings, variables and secrets. */
  env: Readonly<Record<string, unknown>>;
  /** Only in a Durable Object's App. */
  object?: {
    /** The object's id, as `DurableObjectId.toString()` gives it. */
    id: string;
    /** The object's DurableObjectStorage; its users type it structurally. */
    storage: unknown;
    /** The entrypoint calls it when the object's alarm fires (platform components register it). */
    onAlarm(handler: () => Promise<void>): void;
    /** The entrypoint calls it when a message is delivered to this object by RPC. */
    onDeliver(handler: (type: string, key: string, message: JsonValue) => Promise<void>): void;
  };
}

/** Where an App's start context carries the Cloudflare platform it runs on. */
export const WORKERS_HOST: ContextKey<WorkersHost> = createContextKey<WorkersHost>("pikit.workers-host");

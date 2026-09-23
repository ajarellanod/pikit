/**
 * Contexts crossing into Pi (SPEC §6.2).
 */

import { type Context as PiContext, withAbortSignal, withoutAbortSignal } from "@earendil-works/pi-agent-core";
import type { Context } from "@pikit/core";

/**
 * The one-line bridge. Chord's `withContextValue` reads cancellation through a private key, so a
 * pikit context that Pi derives (telemetry spans, hook admission) would lose its `abortSignal`.
 * Re-attaching the signal with Chord's own `withAbortSignal` stores it under that key.
 */
export function toPi(ctx: Context): PiContext {
  const signal = ctx.abortSignal;
  return signal === undefined ? ctx : withAbortSignal(signal, ctx);
}

/**
 * The context a run lives in: the caller's values (tenant, trace) without its cancellation. A run
 * outlives the call that admitted it, as Pi's `Drive` does with `withoutAbortSignal`.
 */
export function detached(ctx: Context): PiContext {
  return withoutAbortSignal(toPi(ctx));
}

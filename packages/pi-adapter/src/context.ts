/**
 * Contexts crossing into pi-durable (Chord 1.0): the same bridge as `../context.ts`, against the Chord
 * that pi-durable resolves. pikit's `Context` has Chord's shape, but Chord's `withContextValue` reads
 * cancellation through a private key, so a pikit context that pi-durable derives would lose its
 * `abortSignal`. Re-attaching the signal with Chord's own `withAbortSignal` stores it under that key.
 */

import type { Context as ChordContext } from "@earendil-works/chord";
import { withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import type { AppContext, Context } from "@pikit/core";

/** A pikit context as the Chord context pi-durable takes, keeping its cancellation. */
export function toChord(ctx: Context): ChordContext {
  const signal = ctx.abortSignal;
  return signal === undefined ? ctx : withAbortSignal(signal, ctx);
}

/** The caller's values without its cancellation: what outlives the call that admitted a run. */
export function detached(ctx: Context): Context {
  return withoutAbortSignal(toChord(ctx));
}

/** An app context with the caller's values and logger, without its cancellation: where a run reports. */
export function runContext(ctx: AppContext): AppContext {
  return ctx.derive((inner) => detached(inner));
}

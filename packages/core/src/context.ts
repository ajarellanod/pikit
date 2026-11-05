/**
 * Invocation context (SPEC K5): cancellation plus invocation-scoped values, passed
 * explicitly and derived immutably.
 *
 * The shape and the semantics of the helpers match Chord's `Context`
 * (`@earendil-works/chord/context`), which Pi's APIs take as their last argument. The core does
 * not import Chord; the shape is the contract. One difference is deliberate: a derived context
 * here reads its parent's `abortSignal` property rather than a private key, so a Chord context
 * (or any context of this shape) can be a parent without losing cancellation.
 *
 * The reverse does not hold: Chord's `withContextValue` looks the signal up by a private key
 * and would drop ours. The Pi adapter therefore bridges once, at its boundary, with Chord's
 * `withAbortSignal` (@pikit/pi-adapter's context.ts).
 *
 * Chord's `Context` also carries its telemetry parent (`telemetry`, pi-telemetry's `TelemetrySpan`).
 * `TelemetrySpan` here has that shape, so a pikit context is a Chord one; the core records nothing:
 * its root carries a no-op span, and a derived context keeps its parent's.
 */

/** Typed identity for one value carried by a {@link Context}. */
export interface ContextKey<T> {
  readonly token: symbol;
  /** Type-only marker: keys with different value types are not interchangeable. */
  readonly valueType?: (value: T) => T;
}

/** A telemetry attribute's value (pi-telemetry's `AttributeValue`). */
export type SpanAttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

/** A telemetry parent: pi-telemetry's `TelemetrySpan`, by shape. */
export interface TelemetrySpan {
  startSpan<T>(
    options: { name: string; attributes?: Record<string, SpanAttributeValue | undefined>; links?: readonly { context: unknown; attributes?: Record<string, SpanAttributeValue | undefined> }[] },
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T>;
  addLink(link: { context: unknown; attributes?: Record<string, SpanAttributeValue | undefined> }): void;
  addEvent(name: string, attributes?: Record<string, SpanAttributeValue | undefined>): void;
  setAttributes(attributes: Record<string, SpanAttributeValue | undefined>): void;
  setStatus(status: { status: "ok" } | { status: "error"; error?: { name: string; message: string } }): void;
}

/** The span that records nothing: the root context's. */
export const NOOP_TELEMETRY: TelemetrySpan = Object.freeze({
  startSpan: <T>(_options: unknown, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> => Promise.resolve().then(() => callback(NOOP_TELEMETRY)),
  addLink: () => {},
  addEvent: () => {},
  setAttributes: () => {},
  setStatus: () => {},
});

/** Immutable invocation-scoped values. Same shape as Chord's `Context`. */
export interface Context {
  readonly abortSignal: AbortSignal | undefined;
  /** The telemetry parent of what runs in this context (Chord's); a no-op unless a host set one. */
  readonly telemetry: TelemetrySpan;
  value<T>(key: ContextKey<T>): T | undefined;
  toString(): string;
}

class EmptyContext implements Context {
  constructor(private readonly name: string) {}
  get abortSignal(): AbortSignal | undefined {
    return undefined;
  }
  get telemetry(): TelemetrySpan {
    return NOOP_TELEMETRY;
  }
  value<T>(_key: ContextKey<T>): T | undefined {
    return undefined;
  }
  toString(): string {
    return this.name;
  }
}

class ValueContext<V> implements Context {
  constructor(
    private readonly parent: Context,
    private readonly key: ContextKey<V>,
    private readonly stored: V,
  ) {}
  get abortSignal(): AbortSignal | undefined {
    return this.parent.abortSignal;
  }
  get telemetry(): TelemetrySpan {
    return this.parent.telemetry;
  }
  value<T>(key: ContextKey<T>): T | undefined {
    if (key.token === this.key.token) return this.stored as unknown as T;
    return this.parent.value(key);
  }
  toString(): string {
    return `${this.parent}.WithValue(${this.key.token.description ?? "anonymous"})`;
  }
}

class SignalContext implements Context {
  constructor(
    private readonly parent: Context,
    readonly abortSignal: AbortSignal,
  ) {}
  get telemetry(): TelemetrySpan {
    return this.parent.telemetry;
  }
  value<T>(key: ContextKey<T>): T | undefined {
    return this.parent.value(key);
  }
  toString(): string {
    return `${this.parent}.WithAbortSignal`;
  }
}

/** The root context: no cancellation, no values. */
export const BACKGROUND_CONTEXT: Context = new EmptyContext("[Context BACKGROUND_CONTEXT]");

export function createContextKey<T>(description: string): ContextKey<T> {
  return Object.freeze({ token: Symbol(description) });
}

/** Derive a context with one additional or replaced value. The parent is unchanged. */
export function withContextValue<T>(key: ContextKey<T>, value: T, parent: Context): Context {
  return new ValueContext(parent, key, value);
}

/** Derive a context cancelled by either the parent's signal or `signal`. The parent is unchanged. */
export function withAbortSignal(signal: AbortSignal, parent: Context): Context {
  const inherited = parent.abortSignal;
  return new SignalContext(parent, inherited === undefined ? signal : AbortSignal.any([inherited, signal]));
}

/** Derive an independently cancellable child. Cancelling it never cancels the parent. */
export function withCancel(parent: Context): { readonly context: Context; cancel(reason?: unknown): void } {
  const controller = new AbortController();
  return {
    context: withAbortSignal(controller.signal, parent),
    cancel: (reason) => controller.abort(reason),
  };
}

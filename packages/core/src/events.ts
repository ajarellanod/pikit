/**
 * Events are notifications (SPEC §4.3): every listener receives the payload, return values
 * are ignored, and a listener that throws is reported but does not stop the others.
 *
 * The bus is generic over the event map and the context so it can be tested on its own;
 * the app instantiates it with `AppEvents` and `AppContext`.
 */

/**
 * Typed event registry. Projects and components extend it by declaration merging:
 *
 *   declare module "@pikit/core" {
 *     interface AppEvents { "acme.customer.created": { customerId: string } }
 *   }
 *
 * Core-owned namespaces (`runtime.*`, `pipeline.*`, …) are added here by the core module
 * that emits them.
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface AppEvents {}

export type EventListener<Payload, Ctx> = (payload: Payload, ctx: Ctx) => void | Promise<void>;

export interface EventBus<Events extends object, Ctx> {
  /**
   * Register a listener. There is no unsubscribe: listeners are registered in `setup` and live
   * as long as the app, so `pikit doctor` shows the real graph. A listener that should act
   * once keeps its own flag.
   */
  on<K extends keyof Events & string>(name: K, listener: EventListener<Events[K], Ctx>): void;
  /** Await every listener in registration order. Never throws because of a listener. */
  emit<K extends keyof Events & string>(name: K, payload: Events[K], ctx: Ctx): Promise<void>;
}

export function createEventBus<Events extends object, Ctx>(
  onListenerError: (error: unknown, event: string) => void,
): EventBus<Events, Ctx> {
  const listeners = new Map<string, EventListener<unknown, Ctx>[]>();

  return {
    on(name, listener) {
      const list = listeners.get(name) ?? [];
      list.push(listener as EventListener<unknown, Ctx>);
      listeners.set(name, list);
    },

    async emit(name, payload, ctx) {
      for (const listener of listeners.get(name) ?? []) {
        try {
          await listener(payload, ctx);
        } catch (error) {
          onListenerError(error, name);
        }
      }
    },
  };
}

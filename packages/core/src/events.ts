/**
 * Events are notifications (SPEC §4.3): every listener receives the payload, return values
 * are ignored, and a listener that throws is reported but does not stop the others.
 *
 * The bus is generic over the event map and the context so it can be tested on its own;
 * the harness instantiates it with `HarnessEvents` and `HarnessContext`.
 */

/**
 * Typed event registry. Projects and components extend it by declaration merging:
 *
 *   declare module "@pikit/core" {
 *     interface HarnessEvents { "acme.customer.created": { customerId: string } }
 *   }
 *
 * Core-owned namespaces (`runtime.*`, `pipeline.*`, …) are added here by the core module
 * that emits them.
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface HarnessEvents {}

export type EventListener<Payload, Ctx> = (payload: Payload, ctx: Ctx) => void | Promise<void>;

export interface EventBus<Events extends object, Ctx> {
  /** Register a listener. Returns a function that removes it. */
  on<K extends keyof Events & string>(name: K, listener: EventListener<Events[K], Ctx>): () => void;
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
      return () => {
        const index = list.indexOf(listener as EventListener<unknown, Ctx>);
        if (index !== -1) list.splice(index, 1);
      };
    },

    async emit(name, payload, ctx) {
      // Copy so a listener that unsubscribes (itself or another) mid-emit cannot skip entries.
      for (const listener of [...(listeners.get(name) ?? [])]) {
        try {
          await listener(payload, ctx);
        } catch (error) {
          onListenerError(error, name);
        }
      }
    },
  };
}

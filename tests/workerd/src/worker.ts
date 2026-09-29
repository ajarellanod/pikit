/**
 * The Worker of the workerd lane. Never deployed.
 *
 * - `TestObject`: a SQLite-backed Durable Object class, empty. The storage suites run inside its
 *   instances (`runInDurableObject`) and give its storage to the components under test, as
 *   `deployment-cloudflare`'s entrypoint will (`test/host.ts`).
 * - `ConversationDouble`, bound as `CONVERSATION`: a stand-in for `deployment-cloudflare`'s
 *   conversation object, with its interface. Each instance runs an App, started on its first event,
 *   with `WORKERS_HOST` holding the object (its id, its storage, the `onAlarm` and `onDeliver`
 *   hooks); `alarm()` calls the `onAlarm` handler and the RPC method `deliver(type, key, message)`
 *   the `onDeliver` handler. What the App is made of is the running test's (`composeObjects`): the
 *   tests and the objects share one isolate.
 */

import { DurableObject } from "cloudflare:workers";
import { type App, BACKGROUND_CONTEXT, type Clock, type ComponentDefinition, defineApp, silentLogger, withContextValue } from "@pikit/core";
import { type JsonValue, WORKERS_HOST, type WorkersHost } from "@pikit/contracts";

export class TestObject extends DurableObject {}

/** What each ConversationDouble's App is made of. */
export interface ObjectComposition {
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  clock?: Clock;
}

let composition: ObjectComposition | undefined;
const apps = new Set<App>();

/** Sets what the objects' Apps are made of from now on; an object whose App was made otherwise starts a new one. */
export function composeObjects(next: ObjectComposition): void {
  composition = next;
}

/** Stops every object's App (as a test's cleanup: on Cloudflare an object's App never stops, K6). */
export async function stopObjects(): Promise<void> {
  composition = undefined;
  const stopping = [...apps];
  apps.clear();
  await Promise.all(stopping.map((app) => app.stop().catch(() => {})));
}

/** An object's App, and the handlers its components registered on the object's hooks. */
export interface OpenedObject {
  app: App;
  hooks: {
    alarm?: () => Promise<void>;
    deliver?: (type: string, key: string, message: JsonValue) => Promise<void>;
  };
}

export class ConversationDouble extends DurableObject {
  #opened: { composition: ObjectComposition; ready: Promise<OpenedObject> } | undefined;

  /** This object's App, started now if it was not, or if the test composed a new one. */
  open(): Promise<OpenedObject> {
    if (composition === undefined) throw new Error("workerd lane: no composeObjects() for ConversationDouble");
    if (this.#opened?.composition !== composition) this.#opened = { composition, ready: this.#start(composition) };
    return this.#opened.ready;
  }

  async #start(made: ObjectComposition): Promise<OpenedObject> {
    const hooks: OpenedObject["hooks"] = {};
    const host: WorkersHost = {
      env: { ...this.env },
      object: {
        id: this.ctx.id.toString(),
        storage: this.ctx.storage,
        onAlarm: (handler) => void (hooks.alarm = handler),
        onDeliver: (handler) => void (hooks.deliver = handler),
      },
    };
    const app = await defineApp({
      components: made.components,
      logger: silentLogger,
      ...(made.config !== undefined && { config: made.config }),
      ...(made.clock !== undefined && { clock: made.clock }),
    }).create();
    apps.add(app);
    await app.start(withContextValue(WORKERS_HOST, host, BACKGROUND_CONTEXT));
    return { app, hooks };
  }

  async deliver(type: string, key: string, message: JsonValue): Promise<void> {
    const { hooks } = await this.open();
    if (hooks.deliver === undefined) throw new Error("ConversationDouble: nothing registered onDeliver");
    await hooks.deliver(type, key, message);
  }

  override async alarm(): Promise<void> {
    const { hooks } = await this.open();
    await hooks.alarm?.();
  }
}

export default {
  fetch: () => new Response("pikit workerd lane: the tests run through Vitest, not through requests"),
} satisfies ExportedHandler;

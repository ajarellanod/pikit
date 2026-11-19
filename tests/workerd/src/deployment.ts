/**
 * deployment-cloudflare's entrypoint over two small Apps, as `worker.ts` builds it in a project from
 * `pikit.config.ts`: `src/worker.ts` exports its `Conversation` class (bound as `CONVERSATION`), and
 * `test/deployment-cloudflare.workerd.ts` calls its Worker `fetch` and the objects' RPC and alarm.
 *
 * The object's App records, in the object's own storage, what its start context carried and what its
 * alarm and deliveries brought; a `fail-start` key in that storage makes its start fail. It has an
 * actor kind (SPEC C9): `probe-owner` owns the keys `owned:`, so an object of one runs `object-probe`
 * (the provider of the object's inbox and alarm, as actors-do is) and `probe-owner`, not
 * `probe-conversation`. Each App answers the call `probe.app` with the components it is made of (its
 * own `APP_DESCRIPTION`), and stores them under `app`.
 */

import { APP_DESCRIPTION, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { ActorInbox, Wakeups } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { createEntrypoint } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/entrypoint.ts";

const objectProbe = defineComponent({
  name: "object-probe",
  setup(pikit) {
    // What actors-do provides: every kind's App keeps the provider of the object's inbox and alarm.
    pikit.provide("actor.inbox", { scope: "one", handle: () => {}, answer: () => {}, answerStream: () => {} } satisfies ActorInbox);
    pikit.provide("wakeups", { handle: () => {}, at: async () => {}, cancel: async () => {} } satisfies Wakeups);
    return {
      async start(ctx) {
        const object = ctx.value(WORKERS_HOST)?.object;
        if (object === undefined) throw new Error("object-probe: no object in WORKERS_HOST");
        // What storage-do does: type the storage by what is used of it.
        const storage = object.storage as DurableObjectStorage;
        if ((await storage.get("fail-start")) === true) throw new Error("object-probe: told to fail");
        const env = ctx.value(WORKERS_HOST)?.env ?? {};
        await storage.put("host", { id: object.id, variable: env.PIKIT_WORKERD_VAR, bound: env.CONVERSATION !== undefined, target: ctx.target });
        await storage.put("starts", ((await storage.get<number>("starts")) ?? 0) + 1);
        object.onAlarm(async () => {
          await storage.put("alarms", ((await storage.get<number>("alarms")) ?? 0) + 1);
        });
        object.onDeliver(async (type, key, message) => {
          await storage.put("delivered", [type, key, message]);
        });
        const app = (ctx.value(APP_DESCRIPTION)?.components ?? []).map((c) => c.name);
        await storage.put("app", app);
        object.onCall?.(async (type) =>
          type === "probe.app" ? { ok: true, answer: app } : { ok: false, code: "no_handler", message: `object-probe: no answer for "${type}"` },
        );
      },
    };
  },
});

/** The owner of the keys `owned:`: its object runs it and what it uses. */
const probeOwner = defineComponent({
  name: "probe-owner",
  setup(pikit) {
    pikit.use("actor.inbox");
    pikit.provideKeyed("actor.kind", "probe-owner", { prefixes: ["owned:"] });
  },
});

/** A conversation's part: in the whole App only. */
const probeConversation = defineComponent({
  name: "probe-conversation",
  setup(pikit) {
    pikit.use("wakeups");
  },
});

let workerVariable: unknown;
let workerOrigin: string | undefined;
const workerProbe = defineComponent({
  name: "worker-probe",
  setup(pikit) {
    pikit.provideKeyed("http.route", "GET /probe/:name", (request) =>
      Response.json({ variable: workerVariable, origin: workerOrigin, name: new URL(request.url).pathname.split("/").at(-1) }),
    );
    return {
      start(ctx) {
        workerVariable = ctx.value(WORKERS_HOST)?.env.PIKIT_WORKERD_VAR;
        workerOrigin = ctx.value(WORKERS_HOST)?.origin;
      },
    };
  },
});

export const entrypoint = createEntrypoint(defineApp({ components: [objectProbe, probeOwner, probeConversation] }), defineApp({ components: [workerProbe] }), { logger: silentLogger });

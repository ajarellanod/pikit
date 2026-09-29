/**
 * deployment-cloudflare's entrypoint over two small Apps, as `worker.ts` builds it in a project from
 * `pikit.config.ts`: `src/worker.ts` exports its `Conversation` class (bound as `CONVERSATION`), and
 * `test/deployment-cloudflare.workerd.ts` calls its Worker `fetch` and the objects' RPC and alarm.
 *
 * The object's App records, in the object's own storage, what its start context carried and what its
 * alarm and deliveries brought; a `fail-start` key in that storage makes its start fail.
 */

import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { WORKERS_HOST } from "@pikit/contracts";
import { createEntrypoint } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/entrypoint.ts";

const objectProbe = defineComponent({
  name: "object-probe",
  setup() {
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
      },
    };
  },
});

let workerVariable: unknown;
const workerProbe = defineComponent({
  name: "worker-probe",
  setup(pikit) {
    pikit.provideKeyed("http.route", "GET /probe/:name", (request) =>
      Response.json({ variable: workerVariable, name: new URL(request.url).pathname.split("/").at(-1) }),
    );
    return {
      start(ctx) {
        workerVariable = ctx.value(WORKERS_HOST)?.env.PIKIT_WORKERD_VAR;
      },
    };
  },
});

export const entrypoint = createEntrypoint(defineApp({ components: [objectProbe] }), defineApp({ components: [workerProbe] }), { logger: silentLogger });

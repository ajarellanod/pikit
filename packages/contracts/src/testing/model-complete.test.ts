// The model.complete suite catches providers that break the contract (runtime-pi's own tests run it on
// the real one, with the faux model): one that answers for any model, one that ignores a cancellation.

import { expect, test } from "bun:test";
import { defineComponent } from "@pikit/core";
import type { ModelComplete } from "../model.ts";
import { createModelCompleteConformance } from "./model-complete.ts";

function provider(flaws: { anyModel?: boolean; ignoresCancel?: boolean }) {
  return defineComponent({
    name: "complete-test",
    setup(pikit) {
      const complete: ModelComplete = {
        async complete(request, ctx) {
          if (flaws.ignoresCancel !== true && ctx.abortSignal?.aborted === true) throw new Error("cancelled");
          if (flaws.anyModel !== true && request.model !== "fake/echo") throw new Error(`no model "${request.model}"`);
          return `echo: ${request.prompt}`;
        },
      };
      pikit.provide("model.complete", complete);
    },
  });
}

async function failing(flaws: Parameters<typeof provider>[0]): Promise<string[]> {
  const failed: string[] = [];
  for (const c of createModelCompleteConformance(() => ({ components: [provider(flaws)], model: "fake/echo", unknownModel: "fake/other", answer: (prompt) => `echo: ${prompt}` }))) {
    await c.run().catch(() => failed.push(c.name));
  }
  return failed;
}

test("a correct provider passes every case", async () => {
  expect(await failing({})).toEqual([]);
});

test("a provider that answers for any model, or ignores a cancellation, is caught", async () => {
  expect(await failing({ anyModel: true })).toEqual(["a model its providers do not have, or a malformed name, is refused"]);
  expect(await failing({ ignoresCancel: true })).toEqual(["a cancelled context is refused"]);
});

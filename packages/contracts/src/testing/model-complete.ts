/**
 * `model.complete` conformance: what every provider guarantees to a component that asks a model for a
 * text (`../model.ts`). Runner-independent:
 *
 *   for (const c of createModelCompleteConformance(() => myProviderFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The fixture's model answers without a network (pi-ai's faux provider, through provider-faux): the
 * suite checks what reaches it and what comes back, never a real model's wording.
 */

import { type App, type AppContext, BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, type Handle, silentLogger, withAbortSignal } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { ModelComplete } from "../model.ts";
import { checker, expecter } from "./assert.ts";

/** A provider under test, built for one case. */
export interface ModelCompleteFixture {
  /** The component that provides `model.complete`, and what it uses (a model provider, the agents it needs). */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** A model its providers have (`provider/modelId`), which answers at once. */
  model: string;
  /** What that model answers to `prompt`, when the fixture knows it (faux/echo: `faux: <prompt>`). */
  answer?(prompt: string): string;
  /** A model of a provider the App has, which that provider does not have. */
  unknownModel: string;
  dispose?(): Promise<void>;
}

const GROUP = "model.complete";
const expect = expecter(GROUP);
const check = checker(GROUP);

/** Whether `promise` rejects. */
const rejects = async (promise: Promise<unknown>): Promise<boolean> => {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
};

export function createModelCompleteConformance(factory: () => ModelCompleteFixture | Promise<ModelCompleteFixture>): readonly ConformanceCase[] {
  const completeCase = (name: string, run: (complete: ModelComplete, fixture: ModelCompleteFixture, ctx: AppContext, app: App) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      let handle: Handle<ModelComplete> | undefined;
      const consumer = defineComponent({
        name: "model-complete-conformance",
        setup(pikit) {
          handle = pikit.use("model.complete");
        },
      });
      const app = await defineApp({
        components: [...fixture.components, consumer],
        ...(fixture.config !== undefined && { config: fixture.config }),
        logger: silentLogger,
      }).create();
      await app.start();
      try {
        await run((handle as Handle<ModelComplete>).get(), fixture, app.context(), app);
      } finally {
        await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  return [
    completeCase("a prompt is answered with the model's text", async (complete, fixture, ctx) => {
      const prompt = "Name this conversation about the weather in Lisbon";
      const text = await complete.complete({ model: fixture.model, system: "Answer with a short title.", prompt, maxTokens: 32 }, ctx);
      check(typeof text === "string", "a string");
      if (fixture.answer !== undefined) expect(text, fixture.answer(prompt), "the answer");
    }),

    completeCase("without a system prompt or a token limit, it answers too", async (complete, fixture, ctx) => {
      const text = await complete.complete({ model: fixture.model, prompt: "hello" }, ctx);
      check(typeof text === "string", "a string");
      if (fixture.answer !== undefined) expect(text, fixture.answer("hello"), "the answer");
    }),

    completeCase("a model its providers do not have, or a malformed name, is refused", async (complete, fixture, ctx) => {
      for (const model of [fixture.unknownModel, "no-such-provider/model", "not a model", ""]) {
        check(await rejects(complete.complete({ model, prompt: "hello" }, ctx)), `"${model}" to be refused`);
      }
    }),

    completeCase("a cancelled context is refused", async (complete, fixture, _ctx, app) => {
      const controller = new AbortController();
      controller.abort(new Error("cancelled by the caller"));
      check(await rejects(complete.complete({ model: fixture.model, prompt: "hello" }, app.context(withAbortSignal(controller.signal, BACKGROUND_CONTEXT)))), "a rejection");
    }),
  ];
}

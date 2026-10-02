/**
 * provider-faux's tests. They are copied with the component and keep running in your project. They
 * make no request anywhere.
 */

import { expect, test } from "bun:test";
import { defineApp, silentLogger } from "@pikit/core";
import { modelsFrom } from "@pikit/pi-adapter";
import providerFaux, { createFauxProvider, FAUX_MODEL, FAUX_PROVIDER, fauxAnswer } from "./index.ts";

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [providerFaux], logger: silentLogger }).create();

  expect(app.describe().components).toEqual([{ name: "provider-faux", provides: ["model.provider"], requires: [], optional: [] }]);
  expect(app.describe().capabilities["model.provider"]).toEqual({ providers: ["provider-faux"], keys: { faux: "provider-faux" } });
});

test("faux/echo answers every turn with the newest user message, needing no credential, and never runs out", async () => {
  const models = modelsFrom([createFauxProvider()]);
  const model = models.getModel(FAUX_PROVIDER, FAUX_MODEL);
  if (model === undefined) throw new Error("no faux/echo");

  expect(await models.checkAuth(FAUX_PROVIDER, {})).toBeDefined();
  const answers: unknown[] = [];
  for (const text of ["hello", "again", "and again"]) {
    const answer = await models.completeSimple(model, { messages: [{ role: "user", content: text, timestamp: Date.now() }] }, {});
    answers.push(answer.content);
  }

  expect(answers).toEqual(["hello", "again", "and again"].map((text) => [{ type: "text", text: fauxAnswer(text) }]));
});

// `model.complete` (`complete.ts`) over pi-ai's faux provider: no network.

import { expect, test } from "bun:test";
import { fauxAssistantMessage, type FauxResponseFactory, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { AppContext } from "@pikit/core";
import { createModelComplete, REASONING_TOKENS } from "./complete.ts";
import { modelsFrom } from "./models.ts";

/** What `complete` reads of its context: the clock. */
const ctx = { clock: { now: () => 0 } } as unknown as AppContext;

test("a reasoning model gets room to think besides the answer's tokens, and the least thinking it allows when it cannot be off", async () => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "plain" }, { id: "thinks", reasoning: true }, { id: "always", reasoning: true }] });
  // As openrouter/z-ai/glm-5.3-flash: its thinking cannot be turned off, nor made minimal.
  const always = faux.models.find((model) => model.id === "always");
  if (always === undefined) throw new Error("no faux/always");
  always.thinkingLevelMap = { off: null, minimal: null, low: "low", medium: null, high: "high" };
  const asked: { maxTokens: number | undefined; reasoning: string | undefined }[] = [];
  const answer: FauxResponseFactory = (_context, options) => {
    asked.push({ maxTokens: options?.maxTokens, reasoning: options?.reasoning });
    return fauxAssistantMessage("A title");
  };
  faux.setResponses([answer, answer, answer]);
  const complete = createModelComplete(() => modelsFrom([faux.provider]));

  for (const id of ["plain", "thinks", "always"]) expect(await complete.complete({ model: `faux/${id}`, prompt: "Hola", maxTokens: 32 }, ctx)).toBe("A title");
  expect(asked).toEqual([
    { maxTokens: 32, reasoning: undefined },
    { maxTokens: 32 + REASONING_TOKENS, reasoning: undefined },
    { maxTokens: 32 + REASONING_TOKENS, reasoning: "minimal" },
  ]);
});

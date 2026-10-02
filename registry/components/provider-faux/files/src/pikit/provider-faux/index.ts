/**
 * provider-faux: a fake model, for tests only. An agent that names `faux/echo` gets, for every turn,
 * the answer `faux: <the newest user message>`, at once: no network, no key, no cost. It provides
 * the keyed capability `model.provider` under the key `faux`.
 *
 * What it is for: an end-to-end test of a generated project that sends a real message through a real
 * channel, runtime and delivery and checks the answer, without a model account (pikit's own e2e
 * installs it). Never in production: an agent on `faux/echo` answers nobody usefully. Remove it with
 * `pikit remove provider-faux` once the test is done, or keep it in a test-only composition.
 *
 * The model is pi-ai 1.0's faux provider (`@pikit/pi-adapter/providers/faux`), scripted here: each
 * answer is computed from the request, and the next one is queued as it is taken, so it never runs out.
 *
 * Targets: `server` and `durable`: it imports nothing platform-specific.
 */

import { defineComponent } from "@pikit/core";
import type { Provider } from "@pikit/pi-adapter";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@pikit/pi-adapter/providers/faux";

/** The provider's id: agents name its model `faux/echo`. */
export const FAUX_PROVIDER = "faux";
/** Its one model. */
export const FAUX_MODEL = "echo";

/** What the model answers to `text`, the newest user message. */
export function fauxAnswer(text: string): string {
  return `faux: ${text}`;
}

type Message = Parameters<FauxResponseFactory>[0]["messages"][number];

/** A user message's text (its text parts, joined). */
function textOf(message: Message | undefined): string {
  if (message === undefined || message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** The faux provider: `faux/echo`, answering `faux: <newest user message>`. */
export function createFauxProvider(): Provider {
  const faux = fauxProvider({ provider: FAUX_PROVIDER, models: [{ id: FAUX_MODEL, name: "Echo (tests only)" }] });
  const answer: FauxResponseFactory = (context) => {
    // Queue the next answer as this one is taken: the script never runs out.
    faux.appendResponses([answer]);
    const newest = [...context.messages].reverse().find((message) => message.role === "user");
    return fauxAssistantMessage(fauxAnswer(textOf(newest)));
  };
  faux.setResponses([answer]);
  return faux.provider;
}

export default defineComponent({
  name: "provider-faux",
  setup(pikit) {
    const provider = createFauxProvider();
    pikit.provideKeyed("model.provider", provider.id, provider);
  },
});

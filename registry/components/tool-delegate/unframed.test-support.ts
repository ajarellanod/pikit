/**
 * Test support for the repository's tests of tool-delegate in a real App (`app.test.ts`,
 * `tests/acceptance`, `tests/workerd`): only tests import it, and it is not copied with the component.
 *
 * `delegate` frames every task (`framedTask`: the task, then how to ask back). The scripted model's
 * rules (`hold`, `call: <tool> <json>`) match a message whole, so a delegated agent on it reads the task
 * without the framing: `unframed(scriptedProvider())`. A test of the framing reads it as sent.
 */

import type { scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { framedTask } from "./files/src/pikit/tool-delegate/index.ts";

type Provider = ReturnType<typeof scriptedProvider>;
type Transcript = Parameters<Provider["stream"]>[1];

/** `provider`, given each user message without the framing `delegate` adds to a task. */
export function unframed(provider: Provider): Provider {
  const strip = (text: string) => text.replace(framedTask(""), "");
  const bare = (context: Transcript): Transcript => ({
    ...context,
    messages: context.messages.map((message) => {
      if (message.role !== "user") return message;
      if (typeof message.content === "string") return { ...message, content: strip(message.content) };
      return { ...message, content: message.content.map((part) => (part.type === "text" ? { ...part, text: strip(part.text) } : part)) };
    }),
  });
  return { ...provider, stream: (model, context, options) => provider.stream(model, bare(context), options), streamSimple: (model, context, options) => provider.streamSimple(model, bare(context), options) };
}

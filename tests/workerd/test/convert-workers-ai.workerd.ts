/**
 * convert-workers-ai inside workerd: the converter started as deployment-cloudflare starts it (the
 * Worker's `env` in `WORKERS_HOST`), over a fake of the `AI` binding (the lane has no Workers AI): the
 * document reaches the binding as workerd's own `Blob` with its type and bytes under `document.pdf`,
 * the Markdown comes back cut, and the codes (`too_large` before anything is sent, `failed`,
 * `unavailable` on workerd's timers) hold on the runtime it ships to.
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { CONVERT_MIN_MAX_BYTES, type ConvertError, type DocumentConverter } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { expect, it } from "vitest";
import convertWorkersAi, { type MarkdownBinding } from "../../../registry/components/convert-workers-ai/files/src/pikit/convert-workers-ai/index.ts";
import { workerEnv } from "./host.ts";

async function started(ai: MarkdownBinding["toMarkdown"]) {
  const sent: { name: string; type: string; size: number; isBlob: boolean }[] = [];
  const binding: MarkdownBinding = {
    async toMarkdown(document) {
      sent.push({ name: document.name, type: document.blob.type, size: (await document.blob.arrayBuffer()).byteLength, isBlob: document.blob instanceof Blob });
      return ai(document);
    },
  };
  let converter: DocumentConverter | undefined;
  const user = defineComponent({
    name: "user-test",
    setup(pikit) {
      const handle = pikit.use("document.convert");
      return { start: () => void (converter = handle.get()) };
    },
  });
  const app = await defineApp({ components: [convertWorkersAi, user], logger: silentLogger, config: { "convert-workers-ai": { timeoutMs: 50 } } }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: { ...workerEnv, AI: binding } }, BACKGROUND_CONTEXT));
  return { converter: converter as DocumentConverter, ctx: app.context(), sent, stop: () => app.stop() };
}
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error as ConvertError).code,
  );

it("convert-workers-ai sends the document as a Blob named document.pdf and answers its Markdown, in workerd", async () => {
  const s = await started(async () => ({ format: "markdown", data: "# Brief\n\nValencia." }));
  expect(await s.converter.convert({ bytes: new TextEncoder().encode("%PDF-1.7"), type: "application/pdf", name: "secret.pdf" }, s.ctx)).toEqual({ text: "# Brief\n\nValencia." });
  expect(s.sent).toEqual([{ name: "document.pdf", type: "application/pdf", size: 8, isBlob: true }]);
  await s.stop();
});

it("convert-workers-ai's codes in workerd: too_large unsent, failed, unavailable past its timeout", async () => {
  const refused = await started(async () => ({ format: "error", error: "secret.pdf is encrypted" }));
  expect(await code(refused.converter.convert({ bytes: new Uint8Array(CONVERT_MIN_MAX_BYTES + 1), type: "application/pdf" }, refused.ctx))).toBe("too_large");
  expect(refused.sent).toEqual([]);
  expect(await code(refused.converter.convert({ bytes: new Uint8Array([37, 80]), type: "application/pdf" }, refused.ctx))).toBe("failed");
  await refused.stop();

  const hanging = await started(() => new Promise(() => {}));
  expect(await code(hanging.converter.convert({ bytes: new Uint8Array([37, 80]), type: "application/pdf" }, hanging.ctx))).toBe("unavailable");
  await hanging.stop();
});

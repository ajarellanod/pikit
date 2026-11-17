/**
 * convert-workers-ai's tests, copied with the component: the converter over a fake of Workers AI's
 * binding (`env.AI.toMarkdown`, as workerd types it: one `{ name, blob }` in, one
 * `{ format: "markdown", data } | { format: "error", error }` out), in an App that gets the Worker's
 * `env` through `WORKERS_HOST`, as deployment-cloudflare's entrypoint gives it. Each fake records what
 * it was sent, so a test sees what left the App.
 */

import { expect, test } from "bun:test";
import { type AppContext, BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withAbortSignal, withContextValue } from "@pikit/core";
import { CONVERT_MIN_MAX_BYTES, CONVERT_TEXT_MAX, ConvertError, type DocumentConverter } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import convertWorkersAi, { ACCEPTED, type MarkdownBinding } from "./index.ts";

const PDF = "application/pdf";
const bytes = (text: string) => new TextEncoder().encode(text);

/** A fake binding answering `answer` (or throwing it), recording what it was sent. */
function fakeAi(answer: (document: { name: string; blob: Blob }) => Promise<{ format: string; data?: unknown; error?: unknown }>) {
  const sent: { name: string; type: string; text: string }[] = [];
  const binding: MarkdownBinding = {
    async toMarkdown(document) {
      sent.push({ name: document.name, type: document.blob.type, text: await document.blob.text() });
      return answer(document);
    },
  };
  return { binding, sent };
}
const markdown = (data: string) => async () => ({ format: "markdown", data, tokens: 3, name: "document.pdf", mimeType: PDF, id: "1" });

/** The converter in a started App whose Worker env holds `env`; `ctx` the App's context. */
async function started(env: Record<string, unknown>, config: Record<string, unknown> = {}) {
  let converter: DocumentConverter | undefined;
  const user = defineComponent({
    name: "user-test",
    setup(pikit) {
      const handle = pikit.use("document.convert");
      return { start: () => void (converter = handle.get()) };
    },
  });
  const app = await defineApp({ components: [convertWorkersAi, user], logger: silentLogger, config: { "convert-workers-ai": config } }).create();
  await app.start(withContextValue(WORKERS_HOST, { env }, BACKGROUND_CONTEXT));
  return { converter: converter as DocumentConverter, ctx: app.context(), stop: () => app.stop() };
}
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as ConvertError,
  );

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [convertWorkersAi], logger: silentLogger }).create();
  expect(app.describe().components).toEqual([{ name: "convert-workers-ai", provides: ["document.convert"], requires: [], optional: [] }]);
});

test("it refuses to start off Cloudflare, and without the binding, saying what to add to wrangler.jsonc", async () => {
  const off = await defineApp({ components: [convertWorkersAi], logger: silentLogger }).create();
  expect(String(((await failure(off.start())) as Error).cause)).toContain("convert-workers-ai: no WORKERS_HOST in the start context");

  const unbound = await defineApp({ components: [convertWorkersAi], logger: silentLogger }).create();
  const error = await failure(unbound.start(withContextValue(WORKERS_HOST, { env: { AI: "not a binding" } }, BACKGROUND_CONTEXT)));
  expect(String((error as Error).cause)).toContain('the Worker has no Workers AI binding "AI": add "ai": { "binding": "AI" } to wrangler.jsonc');

  // Another binding name, configured.
  const { binding } = fakeAi(markdown("x"));
  const named = await started({ DOCS_AI: binding }, { binding: "DOCS_AI" });
  expect(await named.converter.convert({ bytes: bytes("%PDF"), type: PDF }, named.ctx)).toEqual({ text: "x" });
  await named.stop();
});

test("config: maxBytes is at least the contract's least, and a binding a name", () => {
  for (const bad of [{ maxBytes: CONVERT_MIN_MAX_BYTES - 1 }, { binding: "not a name" }, { timeoutMs: 0 }]) {
    expect(() => defineApp({ components: [convertWorkersAi], logger: silentLogger, config: { "convert-workers-ai": bad } })).toThrow("invalid config");
  }
});

test("accepts the documents toMarkdown reads, parameters and case ignored; never images, nor plain text", async () => {
  const { converter, stop } = await started({ AI: fakeAi(markdown("x")).binding });

  expect(converter.maxBytes).toBe(CONVERT_MIN_MAX_BYTES);
  for (const type of ["application/pdf", "Application/PDF; x=y", "text/html; charset=utf-8", "text/csv", "application/xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.oasis.opendocument.spreadsheet", ...Object.keys(ACCEPTED)]) {
    expect([type, converter.accepts(type)]).toEqual([type, true]);
  }
  for (const type of ["image/png", "image/jpeg", "image/svg+xml", "image/webp", "text/plain", "text/markdown", "application/octet-stream", "", "pdf"]) {
    expect([type, converter.accepts(type)]).toEqual([type, false]);
  }
  await stop();
});

test("convert sends the bytes as document.<extension> with their type, never the file's name, and answers the Markdown trimmed", async () => {
  const ai = fakeAi(markdown("\n# Brief 2027\n\nA launch in Valencia.\n"));
  const { converter, ctx, stop } = await started({ AI: ai.binding });

  expect(await converter.convert({ bytes: bytes("%PDF-1.7 ..."), type: "application/pdf; name=x", name: "Client secret brief.pdf" }, ctx)).toEqual({ text: "# Brief 2027\n\nA launch in Valencia." });
  expect(ai.sent).toEqual([{ name: "document.pdf", type: PDF, text: "%PDF-1.7 ..." }]);
  await stop();
});

test("a type it does not read is undefined and nothing is sent; malformed input is invalid", async () => {
  const ai = fakeAi(markdown("x"));
  const { converter, ctx, stop } = await started({ AI: ai.binding });

  expect(await converter.convert({ bytes: bytes("png"), type: "image/png" }, ctx)).toBeUndefined();
  expect((await failure(converter.convert({ bytes: "text" as never, type: PDF }, ctx)))?.code).toBe("invalid");
  expect((await failure(converter.convert({ bytes: bytes("x"), type: "pdf" }, ctx)))?.code).toBe("invalid");
  expect(ai.sent).toEqual([]);
  await stop();
});

test("too large is refused before anything is sent; an empty document, or one with no text, is empty", async () => {
  const ai = fakeAi(markdown("  \n "));
  const { converter, ctx, stop } = await started({ AI: ai.binding });

  const big = await failure(converter.convert({ bytes: new Uint8Array(CONVERT_MIN_MAX_BYTES + 1), type: PDF }, ctx));
  expect([big?.name, big?.code]).toEqual(["ConvertError", "too_large"]);
  expect((await failure(converter.convert({ bytes: new Uint8Array(0), type: PDF }, ctx)))?.code).toBe("empty");
  expect(ai.sent).toEqual([]);
  expect((await failure(converter.convert({ bytes: bytes("%PDF scan"), type: PDF }, ctx)))?.code).toBe("empty");
  expect(ai.sent).toHaveLength(1);
  await stop();
});

test("a document Workers AI refuses is failed, and a binding that throws unavailable: neither message holds the document, its name or Workers AI's words", async () => {
  const refused = fakeAi(async () => ({ format: "error", error: "Could not parse Client secret brief.pdf: ACME budget 10k" }));
  const first = await started({ AI: refused.binding });
  const failed = await failure(first.converter.convert({ bytes: bytes("ACME budget 10k"), type: PDF, name: "Client secret brief.pdf" }, first.ctx));
  expect(failed?.code).toBe("failed");
  await first.stop();

  const throwing = fakeAi(async () => {
    throw new Error("AiError: Client secret brief.pdf: ACME budget 10k");
  });
  const second = await started({ AI: throwing.binding });
  const unavailable = await failure(second.converter.convert({ bytes: bytes("ACME budget 10k"), type: PDF, name: "Client secret brief.pdf" }, second.ctx));
  expect(unavailable?.code).toBe("unavailable");
  expect(unavailable?.cause).toBeUndefined();
  await second.stop();

  const odd = fakeAi(async () => ({ format: "markdown" }));
  const third = await started({ AI: odd.binding });
  expect((await failure(third.converter.convert({ bytes: bytes("x"), type: PDF }, third.ctx)))?.code).toBe("failed");
  await third.stop();

  for (const error of [failed, unavailable]) {
    expect(error?.message).not.toContain("ACME");
    expect(error?.message).not.toContain("secret");
  }
});

test("a text past CONVERT_TEXT_MAX is cut at a line, saying so", async () => {
  const line = `${"x".repeat(99)}\n`;
  const { converter, ctx, stop } = await started({ AI: fakeAi(markdown(line.repeat(6_000))).binding });

  const { text } = (await converter.convert({ bytes: bytes("%PDF"), type: PDF }, ctx)) as { text: string };
  expect(text.length).toBeLessThanOrEqual(CONVERT_TEXT_MAX);
  expect(text).toEndWith(`${"x".repeat(99)}\n\n[cut: the document is longer]`);
  await stop();
});

test("the wait is bounded: past timeoutMs, or when the caller's context is cancelled, unavailable", async () => {
  const hanging = fakeAi(() => new Promise(() => {}));
  const { converter, ctx, stop } = await started({ AI: hanging.binding }, { timeoutMs: 20 });

  expect((await failure(converter.convert({ bytes: bytes("%PDF"), type: PDF }, ctx)))?.message).toBe("Workers AI did not convert the document within 20 ms: try again later");

  const controller = new AbortController();
  const cancellable: AppContext = ctx.derive((context) => withAbortSignal(controller.signal, context));
  const pending = failure(converter.convert({ bytes: bytes("%PDF"), type: PDF }, cancellable));
  controller.abort();
  expect((await pending)?.message).toBe("the conversion was cancelled");
  expect((await failure(converter.convert({ bytes: bytes("%PDF"), type: PDF }, cancellable)))?.code).toBe("unavailable");
  await stop();
});

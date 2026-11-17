/**
 * convert-workers-ai: `document.convert` (`@pikit/contracts`) through Workers AI's `toMarkdown`, the
 * Worker's `AI` binding (features/projects.md, "The contracts"; developers.cloudflare.com/workers-ai/
 * features/markdown-conversion/): a PDF, an Office or OpenDocument file, HTML, XML, CSV or a Numbers
 * sheet as Markdown, for a project's document made from a file and a saved file's searchable text.
 *
 * - **Accepts** the document types `toMarkdown` reads (`ACCEPTED`), never images: those go through two
 *   models and cost a model call each.
 * - **Bounded**: bytes past `maxBytes` are `too_large` before anything is sent; the call waits at most
 *   `timeoutMs`, and as long as the caller's context lets it (`unavailable` otherwise).
 * - **Text or a code, never the document**: Markdown cut to `CONVERT_TEXT_MAX` (`cutText`); no text is
 *   `empty`; a document Workers AI refuses is `failed`; a binding that throws is `unavailable`. No
 *   message holds the document's text or its name (the binding is sent `document.<extension>`, not the
 *   file's name), nor Workers AI's own error text, which may quote either.
 * - **Nothing is kept**: no storage, no log of the document.
 *
 * Target: `durable` (the binding is a Worker's). It runs in both Apps (`apps.worker: "default"`): the
 * Worker's routes and a space's actor alike may convert.
 */

import { defineComponent } from "@pikit/core";
import { CONVERT_MIN_MAX_BYTES, CONVERT_TEXT_MAX, ConvertError, type DocumentConverter, cutText, mediaTypeOf } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import Type, { type Static } from "typebox";

/** The media types `toMarkdown` converts without a model, each with the extension of the name it is sent under. */
export const ACCEPTED: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "text/html": "html",
  "application/xml": "xml",
  "text/csv": "csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12": "xlsb",
  "application/vnd.ms-excel": "xls",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.apple.numbers": "numbers",
};

/** What the component uses of Workers AI's binding (structural: no Cloudflare import). */
export type MarkdownBinding = {
  toMarkdown(document: { name: string; blob: Blob }): Promise<{ format: string; data?: unknown; error?: unknown }>;
};

const Config = Type.Object({
  /** The name of the Workers AI binding in `wrangler.jsonc` (`"ai": { "binding": "AI" }`). */
  binding: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$", default: "AI" }),
  /** The largest document converted, in bytes: at least `CONVERT_MIN_MAX_BYTES` (25 MiB). */
  maxBytes: Type.Integer({ minimum: CONVERT_MIN_MAX_BYTES, maximum: 100 * 1024 * 1024, default: CONVERT_MIN_MAX_BYTES }),
  /** How long one conversion may take before it is `unavailable`. */
  timeoutMs: Type.Integer({ minimum: 1, maximum: 600_000, default: 60_000 }),
});

export type ConvertWorkersAiConfig = Static<typeof Config>;

/** The converter over `ai`. */
export function createWorkersAiConverter(config: ConvertWorkersAiConfig, ai: () => MarkdownBinding): DocumentConverter {
  return {
    maxBytes: config.maxBytes,
    accepts: (type) => mediaTypeOf(type) in ACCEPTED,
    async convert(input, ctx) {
      if (!(input?.bytes instanceof Uint8Array)) throw new ConvertError("invalid", "a document's bytes are a Uint8Array");
      const type = typeof input.type === "string" ? mediaTypeOf(input.type) : "";
      if (type === "") throw new ConvertError("invalid", "a document's type is a media type");
      const extension = ACCEPTED[type];
      if (extension === undefined) return undefined;
      if (input.bytes.length > config.maxBytes) throw new ConvertError("too_large", `the document is over ${config.maxBytes} bytes`);
      if (input.bytes.length === 0) throw new ConvertError("empty", "the document is empty");
      const signal = ctx.abortSignal;
      if (signal?.aborted === true) throw new ConvertError("unavailable", "the conversion was cancelled");

      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const stopped = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ConvertError("unavailable", `Workers AI did not convert the document within ${config.timeoutMs} ms: try again later`)), config.timeoutMs);
        onAbort = () => reject(new ConvertError("unavailable", "the conversion was cancelled"));
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      let answer: Awaited<ReturnType<MarkdownBinding["toMarkdown"]>>;
      try {
        // Sent as `document.<extension>`: the file's name never leaves, and never comes back in an error.
        answer = await Promise.race([ai().toMarkdown({ name: `document.${extension}`, blob: new Blob([input.bytes as Uint8Array<ArrayBuffer>], { type }) }), stopped]);
      } catch (error) {
        if (error instanceof ConvertError) throw error;
        // Workers AI's own message may quote the document or its name: only its kind is said.
        throw new ConvertError("unavailable", "Workers AI could not be reached or failed: try again later");
      } finally {
        clearTimeout(timer);
        if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      }
      if (answer?.format === "error") throw new ConvertError("failed", "Workers AI could not read the document (damaged, encrypted or refused): converting it again changes nothing");
      if (typeof answer?.data !== "string") throw new ConvertError("failed", "Workers AI answered no text for the document");
      const text = answer.data.trim();
      if (text === "") throw new ConvertError("empty", "the document has no text (a scan with no text layer?)");
      return { text: cutText(text, CONVERT_TEXT_MAX) };
    },
  };
}

export default defineComponent({
  name: "convert-workers-ai",
  config: Config,
  setup(pikit, config) {
    let ai: MarkdownBinding | undefined;
    pikit.provide(
      "document.convert",
      createWorkersAiConverter(config, () => {
        if (ai === undefined) throw new ConvertError("unavailable", "convert-workers-ai: used while the App is not running");
        return ai;
      }),
    );

    return {
      start(ctx) {
        const host = ctx.value(WORKERS_HOST);
        if (host === undefined) throw new Error("convert-workers-ai: no WORKERS_HOST in the start context: it runs only on Cloudflare, in an App started by deployment-cloudflare.");
        const binding = host.env[config.binding] as Partial<MarkdownBinding> | undefined;
        if (typeof binding?.toMarkdown !== "function") {
          throw new Error(`convert-workers-ai: the Worker has no Workers AI binding "${config.binding}": add "ai": { "binding": "${config.binding}" } to wrangler.jsonc`);
        }
        ai = binding as MarkdownBinding;
      },
      stop() {
        ai = undefined;
      },
    };
  },
});

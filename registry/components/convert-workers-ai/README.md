# convert-workers-ai

A document's text as Markdown, on Cloudflare, through Workers AI's
[`toMarkdown`](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/) (the
Worker's `AI` binding): a PDF, an Office or OpenDocument file, HTML, XML, CSV or a Numbers sheet. It
provides `document.convert` (`@pikit/contracts`), which makes an uploaded file a project's document and
a saved file's text searchable
([features/projects.md](https://github.com/ajarellanod/pikit/blob/main/features/projects.md)). `toMarkdown` is free for these formats.

- **Provides:** `document.convert`.
- **Requires:** nothing but the Workers AI binding in `wrangler.jsonc`.
- **Targets:** `durable` only (the binding is a Worker's). It runs in both Apps (`apps.worker:
  "default"`): the Worker's routes and a space's actor alike may convert.
- **Installs to:** `src/pikit/convert-workers-ai/` (`index.ts`, `convert-workers-ai.test.ts`).

## Use it

```sh
pikit add convert-workers-ai
```

and add the binding to the project's `wrangler.jsonc`:

```jsonc
"ai": { "binding": "AI" }
```

The component refuses to start without it, saying so. Config (`pikit.config.ts`, all optional):
`binding` (`"AI"`), the binding's name; `maxBytes` (25 MiB, the contract's least), the largest
document converted; `timeoutMs` (60000), how long one conversion may take.

On a server there is no Workers AI binding: documents are read as text only (`isTextType`) until a
server provider exists.

## What it guarantees

- **What it accepts** (`accepts`, parameters and case ignored): `application/pdf`, `text/html`,
  `application/xml`, `text/csv`, Word (`.docx`), Excel (`.xlsx`, `.xlsm`, `.xlsb`, `.xls`),
  OpenDocument (`.odt`, `.ods`) and Apple Numbers: the formats `toMarkdown` converts without a model.
  Never images (each costs two model calls), nor plain text or Markdown (their users read them with
  `textOf`). `convert` of any other type resolves `undefined` and sends nothing.
- **Bounded:** bytes past `maxBytes` are `too_large` before anything is sent; the call waits at most
  `timeoutMs` and as long as the caller's context lets it (`unavailable`).
- **Text or a code:** the Markdown trimmed and cut to `CONVERT_TEXT_MAX` at a line, saying so
  (`cutText`); an empty document or one with no text (a scan with no text layer) is `empty`; a
  document Workers AI refuses (damaged, encrypted) is `failed`; a binding that throws is `unavailable`
  (retry later). Malformed input is `invalid`.
- **The document stays private in errors:** the binding is sent the bytes as `document.<extension>`,
  never the file's name; no error message holds the document's text, its name, or Workers AI's own
  error text (which may quote either), and none carries it as a cause.
- **Nothing is kept:** no storage, no log of a document.

## Tests

`convert-workers-ai.test.ts` (copied into your project), over a fake of the binding as workerd types
it (one `{ name, blob }` in, `{ format: "markdown", data }` or `{ format: "error", error }` out), in an
App that gets the Worker's `env` through `WORKERS_HOST`: what `setup` declares; refusing to start off
Cloudflare and without the binding (naming the `wrangler.jsonc` line), another binding name; refused
config; the types accepted and refused (images, plain text); what is sent (`document.pdf`, its type,
its bytes, never the name) and the text answered; an unaccepted type sends nothing; malformed input;
`too_large` and an empty file before anything is sent, a text-less answer `empty`; a refusal `failed`
and a throwing binding `unavailable` with no document words, name or cause in either; a long text cut
at a line; the timeout and a cancelled context `unavailable`.

The workerd lane (`tests/workerd/test/convert-workers-ai.workerd.ts`): the same converter inside workerd, over a
fake binding: the document sent as workerd's `Blob` named `document.pdf`, its Markdown answered,
`too_large` unsent, `failed`, and `unavailable` past its timeout on workerd's timers.

Not tested against the real service: the fake follows workerd's `ToMarkdownService` types
(`types/defines/to-markdown.d.ts`); a `wrangler dev --remote` check with a real PDF is left to the first
project that deploys it.

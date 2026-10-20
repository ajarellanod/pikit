/**
 * The `websearch` tool, written with `defineTool` (pi-durable's, from `@pikit/pi-adapter/tools`). It
 * asks Gemini (the Gemini API's `generateContent` with its `google_search` tool) and returns Gemini's
 * answer, grounded in Google Search, then the sources it used: title and address.
 *
 * - **The key is a secret.** `apiKey()` is asked at each call (the component reads `GEMINI_API_KEY`
 *   through `secrets`) and the key is sent only to the Gemini API, in `x-goog-api-key` (never in a
 *   URL). It is in no description, parameter, result, detail, diagnostic or error, and nothing about
 *   the call is kept in a memo: the transcript, which pi-durable stores and the model reads, never
 *   holds it.
 * - **Sources are real addresses.** Gemini gives each source as a redirect of its own
 *   (`…/grounding-api-redirect/…`); the tool asks each one where it leads (a `HEAD`, not followed) and
 *   keeps the redirect when that fails.
 * - **The same text as tool-websearch-brave's** for its sources (`N. Title`, its address indented,
 *   blocks apart by a blank line), which the dashboard and the web chat read as sources.
 * - **Replay `"safe"`**: a search only reads, so an interrupted call searches again on recovery.
 */

import { defineTool, type ToolRegistration } from "@pikit/pi-adapter/tools";
import Type from "typebox";

/** The secret holding the Gemini API key (aistudio.google.com/apikey). */
export const GEMINI_KEY_SECRET = "GEMINI_API_KEY";
export const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash-lite";
/** A grounded answer takes Gemini a search and a generation: longer than a plain search API. */
export const GEMINI_TIMEOUT_MS = 60_000;
/** How long one source's redirect may take to say where it leads. */
const RESOLVE_TIMEOUT_MS = 5_000;

const Parameters = Type.Object({
  query: Type.String({ minLength: 1, description: "What to search for: words, a question, or a phrase in quotes." }),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "How many sources at most, 1 to 20. Default: 5." })),
});

/** One source Gemini grounded its answer in. */
interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

/** The part of Gemini's answer the tool reads. */
interface GeminiAnswer {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    groundingMetadata?: { groundingChunks?: GroundingChunk[] };
  }[];
  promptFeedback?: { blockReason?: string };
}

export interface GeminiSearchToolOptions {
  /** The API key, asked at each call; `undefined` when it is not set (the call fails, saying so). */
  apiKey(): Promise<string | undefined>;
  /** The name of the variable (or secret) `apiKey()` reads, for the errors to name it. Default: `GEMINI_API_KEY`. */
  apiKeyName?: string;
  /** The Gemini API. Default: `https://generativelanguage.googleapis.com`; a proxy or a test double replaces it. */
  apiBase?: string;
  /** The model, one that can use `google_search`. Default: `GEMINI_DEFAULT_MODEL`. */
  model?: string;
  /** How long Gemini may take to answer. Default: 60 s. */
  timeoutMs?: number;
}

/** The `websearch` tool, over Gemini grounded in Google Search. */
export function createGeminiSearchTool(options: GeminiSearchToolOptions): ToolRegistration<typeof Parameters> {
  const model = options.model ?? GEMINI_DEFAULT_MODEL;
  const endpoint = `${(options.apiBase ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const timeoutMs = options.timeoutMs ?? GEMINI_TIMEOUT_MS;
  const keyName = options.apiKeyName ?? GEMINI_KEY_SECRET;
  return defineTool({
    name: "websearch",
    description:
      "Searches the web (Google Search, through Gemini) and returns a short answer grounded in what it found, then its sources: title and address. " +
      "Use it to find facts and pages; read one with the fetch tool when it is installed.",
    parameters: Parameters,
    replay: "safe",
    async execute(args, _api, context) {
      const signal = context.abortSignal;
      const key = await options.apiKey();
      if (key === undefined) {
        throw new Error(`websearch: ${keyName} is not set, so web search is unavailable. Ask whoever runs this app to add a Gemini API key as the secret ${keyName}.`);
      }
      const timeout = AbortSignal.timeout(timeoutMs);
      const both = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      const prompt = `Search the web for: ${args.query}\n\nAnswer concisely with what the sources support, in plain text or simple markdown. Say so when the sources do not answer it.`;

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
          signal: both,
        });
      } catch (error) {
        if (timeout.aborted) throw new Error(`websearch: Gemini did not answer within ${timeoutMs / 1000} s`);
        if (signal?.aborted === true) throw error;
        throw new Error(`websearch: the Gemini API could not be reached: ${redact(error instanceof Error ? error.message : String(error), key)}`);
      }
      if (!response.ok) {
        const said = await errorMessage(response);
        throw new Error(redact(`websearch: the Gemini API answered HTTP ${response.status}${hintFor(response.status, said, keyName)}`, key));
      }

      const answer = (await response.json()) as GeminiAnswer;
      const candidate = answer.candidates?.[0];
      const text = (candidate?.content?.parts ?? [])
        .filter((part) => part.thought !== true && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
        .trim();
      if (text === "") {
        const blocked = answer.promptFeedback?.blockReason;
        if (blocked !== undefined) throw new Error(`websearch: Gemini refused the search (${blocked})`);
        return { output: [{ type: "text", text: `No results for "${args.query}".` }] };
      }

      const sources = await sourcesOf(candidate?.groundingMetadata?.groundingChunks ?? [], args.count ?? 5, both);
      const listed =
        sources.length === 0
          ? ""
          : `\n\nSources:\n\n${sources.map((source, index) => `${index + 1}. ${plain(source.title) || "(untitled)"}\n   ${source.url}`).join("\n\n")}`;
      return { output: [{ type: "text", text: redact(`${text}${listed}`, key) }] };
    },
  });
}

/** Gemini's sources, at most `count`, each once, with the address its redirect leads to. */
async function sourcesOf(chunks: GroundingChunk[], count: number, signal: AbortSignal): Promise<{ title: string; url: string }[]> {
  const web = chunks.flatMap((chunk) => (typeof chunk.web?.uri === "string" && chunk.web.uri !== "" ? [{ title: chunk.web.title ?? "", uri: chunk.web.uri }] : []));
  const resolved = await Promise.all(web.map(async (source) => ({ title: source.title, url: await whereTo(source.uri, signal) })));
  const seen = new Set<string>();
  return resolved.filter((source) => !seen.has(source.url) && seen.add(source.url)).slice(0, count);
}

/** Where a grounding redirect leads (`Location` of a `HEAD`, not followed); `uri` itself otherwise. */
async function whereTo(uri: string, signal: AbortSignal): Promise<string> {
  if (!uri.includes("/grounding-api-redirect/")) return uri;
  try {
    const response = await fetch(uri, { method: "HEAD", redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(RESOLVE_TIMEOUT_MS)]) });
    await response.body?.cancel();
    const location = response.headers.get("location");
    return location !== null && /^https?:\/\//i.test(location) ? location : uri;
  } catch {
    return uri;
  }
}

/** The `error.message` of the Gemini API's error answer, short; `""` when there is none. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    return typeof body.error?.message === "string" ? plain(body.error.message).slice(0, 300) : "";
  } catch {
    return "";
  }
}

/** What an error status most likely means, for the model to tell the user, then what Gemini said. */
function hintFor(status: number, said: string, keyName: string): string {
  const hint =
    status === 401 || status === 403 || (status === 400 && /api key/i.test(said))
      ? `: the key in ${keyName} was refused`
      : status === 429
        ? ": the key's rate limit or quota is reached; try again later"
        : "";
  return said === "" ? hint : `${hint} (${said})`;
}

/** `text` without `key`: neither an error a platform builds nor an answer that echoes it shows it. */
function redact(text: string, key: string): string {
  return key === "" ? text : text.replaceAll(key, "[redacted]");
}

/** One line: spaces collapsed. */
function plain(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

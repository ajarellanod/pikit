/**
 * extension-tracing: each run of the agents that name it (`extensions: ["tracing"]`) exported as an
 * OpenTelemetry trace, over OTLP/HTTP JSON with plain `fetch`: Langfuse
 * (`<host>/api/public/otel/v1/traces`, Basic auth), or any OTLP collector.
 *
 * - **Spans** (OpenTelemetry's GenAI conventions): `invoke_agent <agent>` for the run, from
 *   `agent.started` to `agent.settled` / `agent.failed`; `chat <model>` for each model request
 *   attempt (`beforeRequest` to `afterResponse`); `execute_tool <name>` for each tool call
 *   (`beforeTool` to `afterTool`; a call that never ran, blocked by a hook, refused or interrupted, is
 *   an error span ended at its round's `afterTools`). Model requests and the run's tool calls are
 *   children of the run's span, a nested call of the call that made it. The session is the
 *   conversation key, the user the sender of the run's first message.
 * - **One component, both halves.** The hooks see a run's work, the App's events its start and end:
 *   both are registered here and share this process's memory. A run is traced once a hook of this
 *   extension saw it, so only the agents that name the extension are, as with every extension.
 * - **Resumed runs keep their trace.** The trace id and the run's span id are derived from the
 *   conversation id and the run's first request id (`otlp.ts`), so the instance that resumes a run
 *   after a restart or an eviction continues it. A tool call's start is kept in its task's durable
 *   memo (`api.memo`, pi-durable's, shared by the hooks of one task), so a call that outlives an
 *   eviction keeps its start; a model request's start is in memory (an evicted request is sent again,
 *   as a new span). Spans buffered when an instance is evicted are lost.
 * - **One POST per run.** Finished spans are buffered in memory and sent when a run ends (with any
 *   other run's spans finished meanwhile), or as soon as 200 are buffered; past `maxSpans` the oldest
 *   are dropped. The POST is not awaited by the event (the run's answer never waits for it), has 5 s,
 *   and is tried once more on a network error, a 429 or a 5xx; then the batch is dropped, a warning
 *   logged (no payload) and `health`, if installed, says degraded. Nothing here throws into a run.
 * - **Privacy.** By default no prompt, answer, tool argument or result is exported: identifiers,
 *   names, token counts, costs, error codes. `captureContent: true` adds them, redacted (the values of
 *   the secrets config names, `Bearer …`, shapes of known credentials), each attribute capped at 4 KB,
 *   images dropped.
 *
 * Targets: `server` and `durable`: plain code over `fetch` and Web Crypto.
 */

import { type Context, defineComponent } from "@pikit/core";
import { CONVERSATION, type ConversationRef, RUN_REQUESTS, SECRET_NAME_PATTERN, type SecretStore } from "@pikit/contracts";
import { defineExtension, type Extension, GenerationTask, hook, ToolTask } from "@pikit/pi-adapter/extensions";
import Type, { type Static } from "typebox";
import {
  type Attributes,
  contentAttribute,
  encodeSpans,
  messageOf,
  newInput,
  randomSpanId,
  redactText,
  resultText,
  runSpanIdOf,
  type Span,
  toolSpanIdOf,
  traceIdOf,
} from "./otlp.ts";

/** The name agents give it and its key under `agent.extension`. */
export const TRACING = "tracing";

/** Finished spans that make a batch be sent before its run ends. */
export const FLUSH_AT = 200;
/** How long one POST may take. */
export const POST_TIMEOUT_MS = 5_000;
/** The memo of a tool task that holds the call's start (epoch ms). */
export const START_MEMO = "pikit.tracing.start";
/** Runs held in memory at once: a run that never ends here (its instance was stopped) is dropped past it, the oldest first. */
const MAX_RUNS = 1_000;
const VERSION = "0.0.1";

const SecretName = Type.String({ pattern: SECRET_NAME_PATTERN });

const Config = Type.Object({
  /** Where spans are POSTed: Langfuse's `https://<host>/api/public/otel/v1/traces`, a collector's `http://<host>:4318/v1/traces`. */
  endpoint: Type.String({ minLength: 1 }),
  /** Headers whose values are secrets: header name to the secret's name (`{ authorization: "OTLP_AUTHORIZATION" }`). */
  headers: Type.Record(Type.String({ pattern: "^[A-Za-z0-9-]+$" }), SecretName, { default: {} }),
  /** Basic auth from two secrets (Langfuse: the public key and the secret key). */
  basicAuth: Type.Optional(Type.Object({ username: SecretName, password: SecretName })),
  /** The resource's `service.name`. */
  serviceName: Type.String({ minLength: 1, default: "pikit" }),
  /** Prompts, answers, tool arguments and results as span attributes, redacted and capped. Off: none of them. */
  captureContent: Type.Boolean({ default: false }),
  /** More secrets whose values are removed from captured content (those of `headers` and `basicAuth` always are). */
  redact: Type.Array(SecretName, { default: [] }),
  /** Finished spans held at most while unsent; past it the oldest are dropped. */
  maxSpans: Type.Integer({ minimum: 1, default: 2_000 }),
});

export type TracingConfig = Static<typeof Config>;

/** What `fetch` this component sends with: the global one, or a test's. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** A run being traced in this process. */
interface Run {
  conversation: ConversationRef;
  requestId: string;
  traceId: string;
  spanId: string;
  start: number;
  resumed: boolean;
  /** `<channel>:<id>` of the run's first message's sender. */
  user?: string;
  /** The first model request's new input, when content is captured. */
  input?: string;
  /** Model requests sent and not answered, by generation task. */
  chats: Map<string, { spanId: string; start: number; input?: string }>;
  /** Tool calls asked for or started and not ended, by call id. */
  tools: Map<string, PendingTool>;
}

/** A tool call whose span is not ended yet; `arguments` when content is captured. */
type PendingTool = { name: string; spanId: string; parentSpanId: string; start: number; arguments?: string | undefined };

/** A hook's view of a run: its key and first request, from the run's context. */
type RunHandle = { key: string; conversation: ConversationRef; requestId: string; sender?: string };

/** Tokens and cost of a pi-ai `Usage`, read only where they are numbers (the core keeps `Usage` opaque). */
function usageAttributes(usage: unknown): Attributes {
  if (typeof usage !== "object" || usage === null) return {};
  const record = usage as Record<string, unknown>;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const cost = typeof record.cost === "object" && record.cost !== null ? number((record.cost as Record<string, unknown>).total) : undefined;
  return {
    "gen_ai.usage.input_tokens": number(record.input),
    "gen_ai.usage.output_tokens": number(record.output),
    "gen_ai.usage.cache_read.input_tokens": number(record.cacheRead),
    "gen_ai.usage.cache_creation.input_tokens": number(record.cacheWrite),
    "gen_ai.usage.cost": cost,
  };
}

export interface TracingOptions {
  /** The `fetch` spans are sent with. Default: the global one, read at each send. */
  fetch?: Fetch;
}

export function createExtensionTracing(options: TracingOptions = {}) {
  return defineComponent({
    name: "extension-tracing",
    config: Config,
    setup(pikit, config) {
      const secretsHandle = pikit.useOptional("secrets");
      const healthHandle = pikit.useOptional("health");
      const clock = pikit.clock;
      const logger = pikit.logger;
      const now = () => clock.now();
      const capture = config.captureContent;
      /** The secrets the requests need, and every secret config names. */
      const required = [...Object.values(config.headers), ...(config.basicAuth === undefined ? [] : [config.basicAuth.username, config.basicAuth.password])];
      const named = [...new Set([...required, ...config.redact])];

      let secrets: SecretStore | undefined;
      /** The values of the secrets config names, removed from captured content; read at start and before each send. */
      let secretValues: string[] = [];
      const readSecrets = async (): Promise<Record<string, string | undefined>> => {
        const read: Record<string, string | undefined> = {};
        for (const name of named) read[name] = await secrets?.get(name);
        secretValues = Object.values(read).filter((value): value is string => value !== undefined);
        return read;
      };
      let reporter: { up(): void; degraded(reason: string): void } | undefined;

      /** Runs being traced, by `<conversationId>/<requestId>`; and when each run this process saw start began. */
      const runs = new Map<string, Run>();
      const started = new Map<string, { at: number; resumed: boolean }>();
      const keyOf = (conversationId: string, requestId: string) => `${conversationId}/${requestId}`;

      // The buffer of finished spans, and the sends in order.
      let buffer: Span[] = [];
      let dropped = 0;
      let sending: Promise<void> = Promise.resolve();

      const warn = (message: string, fields: Record<string, string | number>) => {
        try {
          logger.warn(message, fields);
        } catch {
          // The logger itself fails: nowhere left to say it.
        }
      };

      /** POSTs one batch: one retry on a network error, a 429 or a 5xx; then dropped, never thrown. */
      const send = async (batch: Span[]): Promise<void> => {
        let reason = "";
        try {
          const read = await readSecrets();
          const missing = required.filter((name) => read[name] === undefined);
          if (missing.length > 0) {
            reason = `secret ${missing.join(", ")} not set`;
          } else {
            const headers: Record<string, string> = { "content-type": "application/json" };
            for (const [header, name] of Object.entries(config.headers)) headers[header] = read[name] as string;
            if (config.basicAuth !== undefined) headers.authorization = `Basic ${btoa(`${read[config.basicAuth.username]}:${read[config.basicAuth.password]}`)}`;
            const body = JSON.stringify(encodeSpans(batch, config.serviceName, VERSION));
            const post = options.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));
            for (let attempt = 0; attempt < 2; attempt++) {
              let retry = true;
              try {
                const response = await post(config.endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
                await response.body?.cancel().catch(() => {});
                if (response.ok) {
                  reporter?.up();
                  return;
                }
                reason = `HTTP ${response.status}`;
                retry = response.status === 429 || response.status >= 500;
              } catch (error) {
                // The name only: a message may quote the request.
                reason = error instanceof Error ? error.name : "error";
              }
              if (!retry) break;
            }
          }
        } catch (error) {
          reason = error instanceof Error ? error.name : "error";
        }
        warn("extension-tracing: a batch of spans was dropped", { spans: batch.length, reason });
        reporter?.degraded(`the collector did not take ${batch.length} spans (${reason})`);
      };

      /** Sends what is buffered, after the sends before it; never awaited by a run. */
      const flush = (): Promise<void> => {
        if (dropped > 0) {
          warn("extension-tracing: spans were dropped, the buffer was full", { dropped, maxSpans: config.maxSpans });
          reporter?.degraded(`${dropped} spans dropped: the buffer was full`);
          dropped = 0;
        }
        if (buffer.length === 0) return sending;
        const batch = buffer;
        buffer = [];
        sending = sending.then(() => send(batch)).catch(() => {});
        return sending;
      };

      const push = (span: Span): void => {
        buffer.push(span);
        if (buffer.length > config.maxSpans) {
          dropped += buffer.length - config.maxSpans;
          buffer = buffer.slice(buffer.length - config.maxSpans);
        }
        if (buffer.length >= FLUSH_AT) void flush();
      };

      /** The attributes every span of `run` carries: who and where. */
      const common = (run: Run): Attributes => ({
        "gen_ai.agent.name": run.conversation.agent,
        "gen_ai.conversation.id": run.conversation.key,
        "session.id": run.conversation.key,
        "langfuse.session.id": run.conversation.key,
        "user.id": run.user,
        "langfuse.user.id": run.user,
        "pikit.conversation.key": run.conversation.key,
        "pikit.conversation.id": run.conversation.conversationId,
      });

      const content = (value: unknown): string | undefined => (capture ? contentAttribute(value, secretValues) : undefined);

      /** Which run a hook runs for: its conversation and its first request, from its context. */
      const handleOf = async (context: Context): Promise<RunHandle | undefined> => {
        const conversation = context.value(CONVERSATION);
        if (conversation === undefined) return undefined;
        const first = (await context.value(RUN_REQUESTS)?.list(context))?.[0];
        if (first === undefined) return undefined;
        return {
          key: keyOf(conversation.conversationId, first.requestId),
          conversation,
          requestId: first.requestId,
          ...(first.sender !== undefined && { sender: `${first.sender.channel}:${first.sender.id}` }),
        };
      };

      /** The run a hook runs for, traced from now on. */
      const runOf = async (context: Context): Promise<Run | undefined> => {
        const handle = await handleOf(context);
        if (handle === undefined) return undefined;
        const known = runs.get(handle.key);
        if (known !== undefined) return known;
        const id = handle.conversation.conversationId;
        const [traceId, spanId] = await Promise.all([traceIdOf(id, handle.requestId), runSpanIdOf(id, handle.requestId)]);
        const raced = runs.get(handle.key);
        if (raced !== undefined) return raced;
        const seen = started.get(handle.key);
        const run: Run = {
          conversation: handle.conversation,
          requestId: handle.requestId,
          traceId,
          spanId,
          start: seen?.at ?? now(),
          resumed: seen?.resumed ?? false,
          ...(handle.sender !== undefined && { user: handle.sender }),
          chats: new Map(),
          tools: new Map(),
        };
        runs.set(handle.key, run);
        if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value as string);
        return run;
      };

      /** A hook's body: what it throws is logged by name and swallowed, so tracing never blocks a call or fails a run. */
      const guarded =
        <A extends unknown[]>(name: string, body: (...args: A) => Promise<void>) =>
        async (...args: A): Promise<undefined> => {
          try {
            await body(...args);
          } catch (error) {
            warn("extension-tracing: a hook failed; its span is missing", { hook: name, error: error instanceof Error ? error.name : "error" });
          }
          return undefined;
        };

      /** A tool call's span, ended now. */
      const toolSpan = (run: Run, callId: string, tool: PendingTool, end: number, extra: Attributes, error?: string): Span => ({
        traceId: run.traceId,
        spanId: tool.spanId,
        parentSpanId: tool.parentSpanId,
        name: `execute_tool ${tool.name}`,
        kind: "internal",
        start: tool.start,
        end,
        attributes: {
          ...common(run),
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": tool.name,
          "gen_ai.tool.call.id": callId,
          "gen_ai.tool.type": "function",
          "gen_ai.tool.call.arguments": tool.arguments,
          ...extra,
        },
        ...(error !== undefined && { error }),
      });

      /** The calls of `run` that never ended (blocked, refused, interrupted): error spans. */
      const endUnran = (run: Run): void => {
        const end = now();
        for (const [callId, tool] of run.tools) push(toolSpan(run, callId, tool, end, { "error.type": "not_run" }, "the call did not run"));
        run.tools.clear();
      };

      const extension: Extension = defineExtension({
        name: TRACING,
        hooks: [
          hook(GenerationTask, {
            beforeRequest: guarded("beforeRequest", async (request, api, context) => {
              const run = await runOf(context);
              if (run === undefined) return;
              const input = capture ? content(newInput(request.messages)) : undefined;
              if (input !== undefined && run.input === undefined) run.input = input;
              run.chats.set(String(api.taskId), { spanId: randomSpanId(), start: now(), ...(input !== undefined && { input }) });
            }),
            afterResponse: guarded("afterResponse", async (message, api, context) => {
              const run = await runOf(context);
              if (run === undefined) return;
              const task = String(api.taskId);
              const chat = run.chats.get(task);
              run.chats.delete(task);
              const end = now();
              const failed = message.stopReason === "error" || message.stopReason === "aborted";
              push({
                traceId: run.traceId,
                spanId: chat?.spanId ?? randomSpanId(),
                parentSpanId: run.spanId,
                name: `chat ${message.model}`,
                kind: "client",
                start: chat?.start ?? end,
                end,
                attributes: {
                  ...common(run),
                  "gen_ai.operation.name": "chat",
                  "gen_ai.provider.name": message.provider,
                  "gen_ai.request.model": message.model,
                  "gen_ai.response.model": message.responseModel ?? message.model,
                  "gen_ai.response.id": message.responseId,
                  "gen_ai.response.finish_reasons": [message.stopReason],
                  ...usageAttributes(message.usage),
                  "error.type": failed ? message.stopReason : undefined,
                  "gen_ai.input.messages": chat?.input,
                  "gen_ai.output.messages": capture ? content([{ ...messageOf(message), finish_reason: message.stopReason }]) : undefined,
                },
                ...(failed && { error: capture && message.errorMessage !== undefined ? redactText(message.errorMessage, secretValues).slice(0, 1_000) : message.stopReason }),
              });
              // The calls it asks for, from now: each ends at its afterTool, or as not run at the round's end.
              for (const part of message.content) {
                if (part.type !== "toolCall" || run.tools.has(part.id)) continue;
                const spanId = await toolSpanIdOf(run.conversation.conversationId, part.id);
                run.tools.set(part.id, { name: part.name, spanId, parentSpanId: run.spanId, start: end, ...(capture && { arguments: content(part.arguments) }) });
              }
            }),
            afterTools: guarded("afterTools", async (_assistant, _results, _api, context) => {
              const run = await runOf(context);
              if (run !== undefined) endUnran(run);
            }),
          }),
          hook(ToolTask, {
            beforeTool: guarded("beforeTool", async (call, api, context) => {
              const run = await runOf(context);
              if (run === undefined) return;
              // Durable: the first start recorded wins, also for the hook run again after a crash.
              let start = now();
              try {
                start = await api.memo<number>(START_MEMO, start, context);
              } catch {
                // No memo: the start is this process's.
              }
              const id = run.conversation.conversationId;
              const parentSpanId = call.parent === undefined ? run.spanId : await toolSpanIdOf(id, call.parent.callId);
              const spanId = run.tools.get(call.id)?.spanId ?? (await toolSpanIdOf(id, call.id));
              run.tools.set(call.id, { name: call.name, spanId, parentSpanId, start, ...(capture && { arguments: content(call.arguments) }) });
            }),
            afterTool: guarded("afterTool", async (call, result, api, context) => {
              const run = await runOf(context);
              if (run === undefined) return;
              const end = now();
              let tool = run.tools.get(call.id);
              run.tools.delete(call.id);
              if (tool === undefined) {
                // Started by an instance that is gone: its start is in the task's memo.
                let start: number | undefined;
                try {
                  start = await api.memo<number>(START_MEMO, context);
                } catch {
                  start = undefined;
                }
                const id = run.conversation.conversationId;
                tool = {
                  name: call.name,
                  spanId: await toolSpanIdOf(id, call.id),
                  parentSpanId: call.parent === undefined ? run.spanId : await toolSpanIdOf(id, call.parent.callId),
                  start: typeof start === "number" ? start : end,
                  ...(capture && { arguments: content(call.arguments) }),
                };
              }
              const failed = result.isError === true;
              push(toolSpan(run, call.id, tool, end, { "error.type": failed ? "tool_error" : undefined, "gen_ai.tool.call.result": capture ? content(resultText(result.output)) : undefined }, failed ? "tool_error" : undefined));
            }),
          }),
        ],
      });
      pikit.provideKeyed("agent.extension", TRACING, extension);

      pikit.on("agent.started", ({ conversation, requestId, resumed }) => {
        const key = keyOf(conversation.conversationId, requestId);
        const at = now();
        started.set(key, { at, resumed });
        if (started.size > MAX_RUNS) started.delete(started.keys().next().value as string);
        const run = runs.get(key);
        if (run !== undefined) {
          run.start = Math.min(run.start, at);
          run.resumed = resumed;
        }
      });

      const ended = (result: { conversation: ConversationRef; requestId: string; requestIds: string[]; kind: string; text?: string; usage?: unknown; error?: { code: string; message: string } }) => {
        const key = keyOf(result.conversation.conversationId, result.requestId);
        started.delete(key);
        const run = runs.get(key);
        // Not traced: no hook of this extension saw the run (its agent does not name it).
        if (run === undefined) return;
        runs.delete(key);
        const end = now();
        for (const chat of run.chats.values()) {
          push({ traceId: run.traceId, spanId: chat.spanId, parentSpanId: run.spanId, name: "chat", kind: "client", start: chat.start, end, attributes: { ...common(run), "gen_ai.operation.name": "chat", "error.type": "unanswered" }, error: "the request had no answer" });
        }
        run.chats.clear();
        endUnran(run);
        const failed = result.kind === "failed";
        push({
          traceId: run.traceId,
          spanId: run.spanId,
          name: `invoke_agent ${run.conversation.agent}`,
          kind: "internal",
          start: run.start,
          end,
          attributes: {
            ...common(run),
            "gen_ai.operation.name": "invoke_agent",
            "pikit.request.id": result.requestId,
            "pikit.request.ids": [...result.requestIds],
            "pikit.run.kind": result.kind,
            "pikit.run.resumed": run.resumed,
            ...usageAttributes(result.usage),
            "error.type": result.error?.code,
            "gen_ai.input.messages": run.input,
            "gen_ai.output.messages": capture && result.text !== undefined ? content([{ role: "assistant", parts: [{ type: "text", content: result.text }] }]) : undefined,
          },
          ...(failed && { error: capture && result.error !== undefined ? redactText(result.error.message, secretValues).slice(0, 1_000) : (result.error?.code ?? "failed") }),
        });
        void flush();
      };
      // Never throws: an event's listener that fails is reported by the bus, but this one has nothing to fail on.
      pikit.on("agent.settled", (result) => {
        try {
          ended(result);
        } catch (error) {
          warn("extension-tracing: a run's end could not be traced", { error: error instanceof Error ? error.name : "error" });
        }
      });
      pikit.on("agent.failed", (result) => {
        try {
          ended(result);
        } catch (error) {
          warn("extension-tracing: a run's end could not be traced", { error: error instanceof Error ? error.name : "error" });
        }
      });

      return {
        async start() {
          let endpoint: URL;
          try {
            endpoint = new URL(config.endpoint);
          } catch {
            throw new Error("extension-tracing: endpoint must be an HTTP or HTTPS URL");
          }
          if (!(["http:", "https:"].includes(endpoint.protocol)) || endpoint.username !== "" || endpoint.password !== "") {
            throw new Error("extension-tracing: endpoint must be an HTTP or HTTPS URL without credentials");
          }
          secrets = secretsHandle.get();
          if (named.length > 0 && secrets === undefined) {
            throw new Error(`extension-tracing: config names secrets (${named.join(", ")}) and no secrets provider is installed`);
          }
          reporter = healthHandle.get()?.reporter("extension-tracing");
          await readSecrets();
        },
        async stop(ctx) {
          // What is buffered goes now; runs still going are left (their spans are lost with this instance).
          const done = flush();
          const signal = ctx.abortSignal;
          await Promise.race([done, new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true })))]);
        },
      };
    },
  });
}

export default createExtensionTracing();

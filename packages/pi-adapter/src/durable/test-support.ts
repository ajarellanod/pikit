/**
 * What the durable runtime's tests share (not exported): the scripted agent on pi-ai 1.0's faux
 * provider, the `hold` tool as a pi-durable tool, and a runtime over `openDurableStorage` on a SQLite
 * file (the same `storage.sql` storage-sqlite provides), with the `agent.*` events it reports.
 *
 * The script is the old runtime's (`../testing/script.ts`): each turn answers `answer: <newest user
 * message>`; a turn whose newest message is exactly `hold` first calls the `hold` tool; a message
 * `call: <tool> <json arguments>` calls any tool with those arguments.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context as ChordContext } from "@earendil-works/chord";
import { defineTool } from "@earendil-works/pi-durable";
import { type AppContext, type AppEvents, defineApp, defineComponent, type Logger, silentLogger } from "@pikit/core";
import type { AgentDefinition, AgentSubmissions, ConversationRef } from "@pikit/contracts";
import { Type } from "pi-ai-v1";
import { createModels } from "pi-ai-v1/models";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxToolCall } from "pi-ai-v1/providers/faux";
import { openSqliteDatabase, type SqliteDatabase } from "../testing/sqlite.ts";
import type { DurableTool } from "./agent.ts";
import { createDurableRuntime, type DurableRuntime, type DurableRuntimeOptions } from "./runtime.ts";
import { openDurableStorage } from "./sql.ts";

/** What the provider was asked: the context of one model request. */
export type ModelRequest = Parameters<FauxResponseFactory>[0];
type Provider = ReturnType<typeof fauxProvider>["provider"];
type Message = ModelRequest["messages"][number];

const CALLS = 1000;

function textOf(message: Message | undefined): string {
  if (message === undefined || message.role === "system") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export interface ScriptedProviderOptions {
  /** Provider id. Default `faux`; its model is `<id>/scripted`. */
  id?: string;
  /** Sees every request, and the stream options it was sent with. */
  onRequest?(request: ModelRequest, options: Parameters<FauxResponseFactory>[1]): void;
  /** Asked before each answer: a promise makes that call wait for it, then fail with its text as the provider's error. */
  fail?(): Promise<string> | undefined;
}

/** The scripted provider, model `<id>/scripted`. */
export function scriptedProvider(options: ScriptedProviderOptions = {}): Provider {
  const faux = fauxProvider({ provider: options.id ?? "faux", models: [{ id: "scripted" }] });
  const step: FauxResponseFactory = (context, streamOptions) => {
    options.onRequest?.(context, streamOptions);
    const failing = options.fail?.();
    if (failing !== undefined) return failing.then((errorMessage) => fauxAssistantMessage("", { stopReason: "error", errorMessage }));
    // pi-durable places its `pi.system` entries (prompt, tools) after the input: the newest other message.
    const last = [...context.messages].reverse().find((message) => message.role !== "system");
    if (last?.role === "user" && textOf(last) === "hold") return fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" });
    const call = last?.role === "user" ? /^call: (\S+)(?: (.+))?$/s.exec(textOf(last)) : null;
    if (call?.[1] !== undefined) return fauxAssistantMessage(fauxToolCall(call[1], JSON.parse(call[2] ?? "{}")), { stopReason: "toolUse" });
    const newest = [...context.messages].reverse().find((message) => message.role === "user");
    return fauxAssistantMessage(`answer: ${textOf(newest)}`);
  };
  faux.setResponses(Array.from({ length: CALLS }, () => step));
  return faux.provider;
}

/** The `hold` tool: its result is whatever `run` resolves to. */
export function holdTool(run: (context: ChordContext) => Promise<string>, replay: "safe" | "unsafe" = "unsafe"): DurableTool {
  return defineTool({
    name: "hold",
    description: "Blocks until the test releases it.",
    parameters: Type.Object({}),
    replay,
    execute: async (_args, _api, context) => ({ content: [{ type: "text", text: await run(context) }] }),
  }) as unknown as DurableTool;
}

/** A hold released by `release()`, honouring its signal (a Harness closing or an abort stops it). */
export function releasableHold(replay: "safe" | "unsafe" = "unsafe") {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const holding = new Promise<void>((resolve) => (started = resolve));
  let calls = 0;
  const tool = holdTool(async (context) => {
    calls++;
    started();
    await new Promise<void>((resolve, reject) => {
      const signal = context.abortSignal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      void released.then(resolve);
    });
    return "released";
  }, replay);
  return { tool, started: holding, release: () => release(), calls: () => calls };
}

/** The suite's agent over `faux/scripted`, with `tools`. */
export function scriptedAgent(tools: AgentDefinition["tools"] = []): AgentDefinition {
  return { name: "scripted", model: "faux/scripted", tools };
}

type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];
type AgentEvent = { [K in "agent.dispatched" | "agent.started" | "agent.settled" | "agent.failed"]: { name: K; payload: AppEvents[K] } }[
  "agent.dispatched" | "agent.started" | "agent.settled" | "agent.failed"
];

export interface WorkerOptions {
  agents?: AgentDefinition[];
  tools?: Record<string, DurableTool>;
  providers?: Provider[];
  submissions?: AgentSubmissions;
  logger?: Logger;
  runtime?: Partial<DurableRuntimeOptions>;
}

/** A temporary SQLite file, removed by `dispose`. */
export function databaseFile(): { path: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pikit-durable-runtime-"));
  return { path: join(dir, "pikit.db"), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One worker: an app recording the `agent.*` events, and a durable runtime over the SQLite file at `path`. */
export async function openWorker(path: string, options: WorkerOptions = {}) {
  const events: AgentEvent[] = [];
  const waiters = new Set<() => void>();
  const observer = defineComponent({
    name: "observer",
    setup(pikit) {
      const record = (event: AgentEvent) => {
        events.push(event);
        for (const wake of waiters) wake();
      };
      pikit.on("agent.dispatched", (payload) => record({ name: "agent.dispatched", payload }));
      pikit.on("agent.started", (payload) => record({ name: "agent.started", payload }));
      pikit.on("agent.settled", (payload) => record({ name: "agent.settled", payload }));
      pikit.on("agent.failed", (payload) => record({ name: "agent.failed", payload }));
    },
  });
  const app = await defineApp({ components: [observer], logger: options.logger ?? silentLogger }).create();
  const sqlite: SqliteDatabase = openSqliteDatabase(path);
  const agents = options.agents ?? [scriptedAgent()];
  const models = createModels();
  for (const provider of options.providers ?? [scriptedProvider()]) models.setProvider(provider);
  const ctx: AppContext = app.context();
  const runtime: DurableRuntime = createDurableRuntime({
    storage: () => openDurableStorage(sqlite.database),
    agent: (name) => agents.find((agent) => agent.name === name),
    tool: (name) => options.tools?.[name],
    models,
    events: ctx,
    ...(options.submissions !== undefined && { submissions: options.submissions }),
    ...options.runtime,
  });

  const waitFor = <T>(probe: () => T | undefined, what: string, timeoutMs = 5_000): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`timed out waiting for ${what}; events: ${JSON.stringify(events.map((e) => [e.name, "requestId" in e.payload ? e.payload.requestId : e.payload.admission]))}`));
      }, timeoutMs);
      const check = () => {
        const found = probe();
        if (found === undefined) return;
        waiters.delete(check);
        clearTimeout(timer);
        resolve(found);
      };
      waiters.add(check);
      check();
    });
  const results = () => events.flatMap((e) => (e.name === "agent.settled" || e.name === "agent.failed" ? [e.payload as Result] : []));

  return {
    app,
    ctx,
    runtime,
    events,
    results,
    /** A new conversation of `agent` (default: the first one). */
    async conversation(agent = agents[0]?.name ?? "scripted"): Promise<ConversationRef> {
      const sessionId = await runtime.createConversation(ctx);
      return { key: `test:${sessionId}`, agent, sessionId };
    },
    dispatch: (requestId: string, prompt: string, conversation: ConversationRef, context: AppContext = ctx) =>
      runtime.dispatch({ requestId, conversation, prompt }, context),
    /** The `agent.settled` or `agent.failed` of the run started by `requestId`. */
    result: (requestId: string) => waitFor(() => results().find((r) => r.requestId === requestId), `the result of ${requestId}`),
    started: (requestId: string) =>
      waitFor(
        () => events.find((e): e is Extract<AgentEvent, { name: "agent.started" }> => e.name === "agent.started" && e.payload.requestId === requestId)?.payload,
        `agent.started of ${requestId}`,
      ),
    /** Close the runtime (its Harness), then the database file. Idempotent. */
    close: once(async () => {
      await runtime.close(ctx);
      await sqlite.close();
    }),
  };
}

export type Worker = Awaited<ReturnType<typeof openWorker>>;

function once(work: () => Promise<void>): () => Promise<void> {
  let done: Promise<void> | undefined;
  return () => (done ??= work());
}

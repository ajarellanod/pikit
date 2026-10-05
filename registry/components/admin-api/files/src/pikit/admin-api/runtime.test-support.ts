/**
 * Test support for admin-api's tests: the runtime's contracts as doubles a test sets (conversations,
 * transcripts, live events, the keys' pointers), recording what admin-api asked of them.
 */

import { type App, type AppContext, BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, type Logger, silentLogger, type Target, withAbortSignal } from "@pikit/core";
import {
  type AdminAuth,
  type AgentObserver,
  type AgentRequest,
  type AgentRuntime,
  compareHttpRoutes,
  type ConversationRef,
  type ConversationRegistry,
  type HttpRoute,
  matchesHttpRoute,
  type ObservedConversation,
  type ObservedEvent,
  type PageRequest,
  parseHttpRouteKey,
  type TranscriptEntry,
  type Usage,
} from "@pikit/contracts";

/** The operator's header, and an `admin.auth` that knows only it (the operator `ops`). */
export const AUTH = { authorization: "Bearer operator-token" };

export const auth = defineComponent({
  name: "auth-test",
  setup(pikit) {
    const provider: AdminAuth = { verify: async (request) => (request.headers.get("authorization") === AUTH.authorization ? { id: "ops" } : undefined) };
    pikit.provide("admin.auth", provider);
  },
});

export const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as unknown as Usage;

/** The runtime's conversations, their transcripts and live events, as a test sets them. */
export class Runtime {
  conversations = new Map<string, ObservedConversation>();
  transcripts = new Map<string, TranscriptEntry[]>();
  /** Keys → the conversation each points to. */
  pointers = new Map<string, ConversationRef>();
  dispatched: AgentRequest[] = [];
  aborted: ConversationRef[] = [];
  pages: PageRequest[] = [];
  /** Live events a test pushes to the watchers. */
  private listeners = new Set<(event: ObservedEvent) => void>();
  watching = 0;
  released = 0;
  private next = 100;

  /** Names the conversation a reset makes: `c100` by default; a Cloudflare object's are digits. */
  private readonly idOf: (n: number) => string;

  constructor(idOf: (n: number) => string = (n) => `c${n}`) {
    this.idOf = idOf;
  }

  add(conversation: Omit<ObservedConversation, "busy" | "usage"> & { busy?: boolean }, current = true): void {
    this.conversations.set(conversation.conversationId, { busy: false, usage: ZERO, ...conversation });
    if (current && conversation.key !== undefined && conversation.agent !== undefined) {
      this.pointers.set(conversation.key, { key: conversation.key, agent: conversation.agent, conversationId: conversation.conversationId });
    }
  }

  push(event: ObservedEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  readonly observer: AgentObserver = {
    conversations: async (page) => {
      this.pages.push(page);
      if (page.cursor !== undefined && page.cursor !== "page-2") throw new Error("agent.observe: the cursor is not one this observer gave");
      const all = [...this.conversations.values()];
      return page.cursor === undefined ? { items: all.slice(0, page.limit ?? 50), next: "page-2" } : { items: [] };
    },
    conversation: async (id) => this.conversations.get(id),
    transcript: async (id, page) => {
      this.pages.push(page);
      const entries = this.transcripts.get(id);
      return entries === undefined ? undefined : { items: entries.slice(0, page.limit ?? 50) };
    },
    watch: (id, ctx) => this.follow(id, ctx),
    usage: async (id) => this.conversations.get(id)?.usage,
  };

  private async *follow(id: string, ctx: AppContext): AsyncGenerator<ObservedEvent> {
    const queue: ObservedEvent[] = [];
    let wake: (() => void) | undefined;
    const listener = (event: ObservedEvent) => {
      queue.push(event);
      wake?.();
    };
    this.listeners.add(listener);
    this.watching++;
    const onAbort = () => wake?.();
    ctx.abortSignal?.addEventListener("abort", onAbort);
    try {
      yield { type: "snapshot", conversationId: id };
      for (;;) {
        if (ctx.abortSignal?.aborted === true) return;
        const event = queue.shift();
        if (event !== undefined) {
          yield event;
          continue;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      ctx.abortSignal?.removeEventListener("abort", onAbort);
      this.listeners.delete(listener);
      this.released++;
    }
  }

  readonly runtime: AgentRuntime = {
    dispatch: async (request) => {
      this.dispatched.push(request);
      const busy = this.conversations.get(request.conversation.conversationId)?.busy === true;
      return { kind: busy ? "queued" : "started", requestId: request.requestId };
    },
    abort: async (conversation) => void this.aborted.push(conversation),
    resume: async () => {},
  };

  readonly registry: ConversationRegistry = {
    resolve: async () => {
      throw new Error("not used by admin-api");
    },
    get: async (key) => this.pointers.get(key),
    reset: async (key) => {
      const previous = this.pointers.get(key);
      if (previous === undefined) return undefined;
      const conversation = { ...previous, conversationId: this.idOf(this.next++) };
      this.pointers.set(key, conversation);
      return { conversation, previousConversationId: previous.conversationId, newConversationId: conversation.conversationId };
    },
  };

  component() {
    return defineComponent({
      name: "runtime-test",
      setup: (pikit) => {
        pikit.provide("agent.observe", this.observer);
        pikit.provide("agent.runtime", this.runtime);
        pikit.provide("conversations.registry", this.registry);
      },
    });
  }
}


export interface Logged {
  message: string;
  fields: Record<string, unknown> | undefined;
}

export interface Served {
  app: App;
  logged: Logged[];
  /** A request served the way a server serves it: the most specific matching key. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  keys(): string[];
}

/** An App of `components`, started, whose `http.route`s are served as a server serves them; `stop` it. */
export async function serve(components: ComponentDefinition[], config: Record<string, unknown> = {}, target: Target = "server"): Promise<Served> {
  const logged: Logged[] = [];
  const logger: Logger = {
    ...silentLogger,
    info: (message, fields) => void logged.push({ message, fields }),
    warn: (message, fields) => void logged.push({ message, fields }),
  };
  let routes: { get(key: string): HttpRoute | undefined; keys(): string[] } | undefined;
  const server = defineComponent({
    name: "server-test",
    setup(pikit) {
      const handle = pikit.useKeyed("http.route");
      return { start: () => void (routes = handle) };
    },
  });
  const app = await defineApp({ components: [...components, server], config, logger, target }).create();
  await app.start();
  return {
    app,
    logged,
    keys: () => routes?.keys() ?? [],
    async fetch(path, init = {}) {
      const request = new Request(`http://pikit.test${path}`, init);
      const { pathname } = new URL(request.url);
      const key = (routes?.keys() ?? [])
        .map((each) => ({ each, parsed: parseHttpRouteKey(each) }))
        .filter((r) => r.parsed !== undefined && matchesHttpRoute(r.parsed, request.method, pathname))
        .sort((a, b) => compareHttpRoutes(a.parsed!, b.parsed!))[0]?.each;
      if (key === undefined) return new Response("not found", { status: 404 });
      const ctx = app.context(init.signal ? withAbortSignal(init.signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT);
      return routes!.get(key)!(request, ctx);
    },
  };
}

/** A client of a server-sent event stream: `take(n)` waits for the next `n` `data:` lines. */
export function sse(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    reader,
    async take(count: number): Promise<unknown[]> {
      const data: unknown[] = [];
      while (data.length < count) {
        let end = buffer.indexOf("\n\n");
        while (end !== -1 && data.length < count) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const line of frame.split("\n")) if (line.startsWith("data: ")) data.push(JSON.parse(line.slice(6)));
          end = buffer.indexOf("\n\n");
        }
        if (data.length >= count) break;
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      return data;
    },
  };
}

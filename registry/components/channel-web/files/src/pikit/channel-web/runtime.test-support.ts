/**
 * Test support for channel-web's tests: the runtime's contracts as doubles a test drives (a run's
 * start, its live events, its end), a router, the accounts as a double (never better-auth: its own
 * tests are the accounts'), and an App whose routes are served as a server serves them.
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
  parseHttpRouteKey,
  type RunSettlement,
  type Usage,
} from "@pikit/contracts";
import { createMemoryKeyValueStorage, createMemorySubmissions } from "@pikit/contracts/testing";
import type { AccountLink, AccountSession, AccountState, AccountSummary, AccountsPage, AccountsQuery, AccountUser, Accounts } from "./accounts/types.ts";
import type { AccountsWiring } from "./wiring.ts";

export const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as unknown as Usage;

/** An answer as pi-ai writes it: one text block. */
export const answerOf = (text: string, timestamp = 1000): Record<string, unknown> => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "test",
  provider: "test",
  model: "test/model",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 1 } },
  stopReason: "stop",
  timestamp,
});

/** A 1×1 PNG, base64. */
export const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
/** An image of `bytes` bytes (base64 of zeros). */
export const imageOf = (bytes: number, mimeType = "image/png") => ({ mimeType, data: Buffer.alloc(bytes).toString("base64") });

/** The secrets every test App has: a long enough auth secret. */
export const SECRETS: Record<string, string> = { CHANNEL_WEB_AUTH_SECRET: "a-test-secret-of-more-than-32-characters" };

export const secretsOf = (values: Record<string, string> = SECRETS) =>
  defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => values[name] }) });

/** Every message goes to `assistant`. */
export const router = defineComponent({
  name: "router-test",
  setup: (pikit) => pikit.pipeline("route.resolve", (value) => (value.decision !== undefined ? value : { ...value, decision: { agent: "assistant", access: "allow" } }), { priority: -100 }),
});

/** The operator `ops`, by `authorization: Bearer operator-token`. */
export const OPERATOR = { authorization: "Bearer operator-token" };
export const adminAuth = defineComponent({
  name: "admin-auth-test",
  setup(pikit) {
    const provider: AdminAuth = { verify: async (request) => (request.headers.get("authorization") === OPERATOR.authorization ? { id: "ops" } : undefined) };
    pikit.provide("admin.auth", provider);
  },
});

/**
 * The accounts as a double: users by id, a session a cookie `pikit_chat_test=<user id>` (an unknown,
 * banned or removed one is no session), better-auth's routes answering what they were asked.
 */
export class FakeAccounts implements Accounts {
  users = new Map<string, AccountSummary>();
  /** better-auth's routes asked, as `METHOD /path`. */
  handled: string[] = [];
  invited: { email: string; name?: string; origin: string }[] = [];

  add(id: string, email = `${id}@example.com`): AccountUser {
    const user: AccountSummary = { id, name: id, email, emailVerified: true, methods: ["password"], createdAt: this.users.size + 1, banned: false };
    this.users.set(id, user);
    return user;
  }

  /** The headers of `id`'s session. */
  static session(id: string): Record<string, string> {
    return { cookie: `pikit_chat_test=${id}` };
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.handled.push(`${request.method} ${url.pathname}`);
    return Response.json({ path: url.pathname }, { headers: [["set-cookie", "pikit_chat_a=1; Path=/chat/"], ["set-cookie", "pikit_chat_b=2; Path=/chat/"]] });
  }

  async user(request: Request): Promise<AccountSession | undefined> {
    const id = /(?:^|;\s*)pikit_chat_test=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
    const found = id === undefined ? undefined : this.users.get(id);
    if (found === undefined || found.banned) return undefined;
    const { methods: _methods, createdAt: _created, banned: _banned, lastSeenAt: _seen, ...user } = found;
    return { user, cookies: [] };
  }

  async methods(userId: string): Promise<string[]> {
    return this.users.get(userId)?.methods ?? [];
  }

  async list(query: AccountsQuery): Promise<AccountsPage> {
    const stateOf = (user: AccountSummary): AccountState => (user.banned ? "banned" : user.methods.length === 0 && user.lastSeenAt === undefined ? "invited" : "active");
    const needle = query.q?.toLowerCase() ?? "";
    const searched = [...this.users.values()].filter((user) => `${user.name} ${user.email} ${user.id}`.toLowerCase().includes(needle)).sort((a, b) => b.createdAt - a.createdAt);
    const count = (state: AccountState) => searched.filter((user) => stateOf(user) === state).length;
    const counts = { all: searched.length, active: count("active"), invited: count("invited"), banned: count("banned") };
    const chosen = searched.filter((user) => query.state === undefined || stateOf(user) === query.state);
    return { items: chosen.slice(query.offset, query.offset + query.limit), total: chosen.length, counts };
  }

  async invite(person: { email: string; name?: string }, origin: string): Promise<AccountLink & { userId: string }> {
    if ([...this.users.values()].some((user) => user.email === person.email)) throw Object.assign(new Error("that email has an account"), { code: "exists" });
    this.invited.push({ ...person, origin });
    const user = this.add(`u${this.users.size + 1}`, person.email);
    return { userId: user.id, link: `${origin}/chat/invite?token=secret-token`, expiresAt: 1_000, emailed: false };
  }

  async resetLink(userId: string, origin: string): Promise<AccountLink> {
    if (!this.users.has(userId)) throw Object.assign(new Error("no such user"), { code: "not_found" });
    return { link: `${origin}/chat/reset?token=secret-token`, expiresAt: 1_000, emailed: false };
  }

  async ban(userId: string, banned: boolean): Promise<void> {
    const user = this.users.get(userId);
    if (user === undefined) throw Object.assign(new Error("no such user"), { code: "not_found" });
    user.banned = banned;
  }

  async remove(userId: string): Promise<void> {
    if (!this.users.delete(userId)) throw Object.assign(new Error("no such user"), { code: "not_found" });
  }

  /** The wiring that hands this double to both halves. */
  wiring(): AccountsWiring {
    return { local: () => this, remote: () => this, answer: () => {} };
  }
}

/** The runtime: conversations, live events a test pushes, runs a test ends, and `agent.submissions`. */
export class Runtime {
  conversations = new Map<string, ObservedConversation>();
  pointers = new Map<string, ConversationRef>();
  dispatched: AgentRequest[] = [];
  aborted: ConversationRef[] = [];
  readonly record = createMemorySubmissions();
  /** The next dispatches that throw (the runtime cannot take messages for a while). */
  failing = 0;
  /**
   * A started run starts and ends inside `dispatch`, before it returns: Pi announces a quick run's
   * `agent.started` and its end as `dispatch` returns (a model that answers at once).
   */
  runsAtOnce = false;
  /** The App's context, for the events of runs a test ends. */
  events: AppContext | undefined;
  private listeners = new Set<(event: ObservedEvent) => void>();
  watching = 0;
  released = 0;
  private next = 1;

  constructor(private readonly idOf: (n: number) => string = (n) => `c${n}`) {}

  push(event: ObservedEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  readonly observer: AgentObserver = {
    conversations: async () => ({ items: [...this.conversations.values()] }),
    conversation: async (id) => this.conversations.get(id),
    transcript: async (id) => (this.conversations.has(id) ? { items: [] } : undefined),
    watch: (id, ctx) => this.follow(id, ctx),
    usage: async (id) => this.conversations.get(id)?.usage,
  };

  private async *follow(id: string, ctx: AppContext): AsyncGenerator<ObservedEvent> {
    if (!this.conversations.has(id)) throw new Error(`agent.observe: no conversation ${id}`);
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
      yield { type: "snapshot", ...(this.conversations.get(id)?.busy === true && { run: { requestId: "x" } }) };
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
    dispatch: async (request, ctx) => {
      if (this.failing > 0) {
        this.failing--;
        throw new Error("runtime-test: cannot take messages for a while");
      }
      const duplicate = this.dispatched.some((each) => each.requestId === request.requestId && each.conversation.conversationId === request.conversation.conversationId);
      this.dispatched.push(request);
      const observed = this.conversations.get(request.conversation.conversationId);
      if (observed !== undefined && observed.key === undefined) this.conversations.set(observed.conversationId, { ...observed, key: request.conversation.key, agent: request.conversation.agent });
      const busy = this.conversations.get(request.conversation.conversationId)?.busy === true;
      const admission = { kind: duplicate ? "duplicate" : busy ? "queued" : "started", requestId: request.requestId } as const;
      if (!duplicate) await this.record.submissions.admitted(request.conversation, request.requestId, ctx);
      await ctx.emit("agent.dispatched", { conversation: request.conversation, admission });
      if (this.runsAtOnce && admission.kind === "started") {
        await this.start(request.conversation.key, [request.requestId]);
        await this.end(request.conversation.key, [request.requestId], { text: `answer: ${request.prompt}` });
      }
      return admission;
    },
    abort: async (conversation) => void this.aborted.push(conversation),
    resume: async () => {},
  };

  readonly registry: ConversationRegistry = {
    resolve: async (key, agent, channel) => {
      const known = this.pointers.get(key);
      if (known !== undefined) return known;
      const conversation = { key, agent, channel, conversationId: this.idOf(this.next++) };
      this.conversations.set(conversation.conversationId, { conversationId: conversation.conversationId, key, agent, busy: false, usage: ZERO });
      this.pointers.set(key, conversation);
      return conversation;
    },
    get: async (key) => this.pointers.get(key),
    reset: async (key, agent) => {
      const previous = this.pointers.get(key);
      if (previous === undefined) return undefined;
      const conversation = { ...previous, ...(agent !== undefined && { agent }), conversationId: this.idOf(this.next++) };
      this.pointers.set(key, conversation);
      this.conversations.set(conversation.conversationId, { conversationId: conversation.conversationId, busy: false, usage: ZERO });
      return { conversation, previousConversationId: previous.conversationId, newConversationId: conversation.conversationId };
    },
  };

  private submissions = 0;

  /** The watch's `submission` events for `requestIds`, as Pi reports each request it took: their submission ids. */
  submit(requestIds: string[]): number[] {
    return requestIds.map((requestId) => {
      const id = ++this.submissions;
      this.push({ type: "submission", record: { id, requestId } });
      return id;
    });
  }

  /**
   * A run of `key`'s conversation starts with `requestIds` (busy, `agent.started`, `run_start`); its
   * `run_start` names `inputs` (submission ids), by default new ones whose `submission` events come
   * first, as Pi's do in the commit that starts the run; `null`: none (inputs the watch cannot name).
   */
  async start(key: string, requestIds: string[], inputs: number[] | null = this.submit(requestIds)): Promise<void> {
    const conversation = this.pointers.get(key) as ConversationRef;
    this.conversations.set(conversation.conversationId, { ...(this.conversations.get(conversation.conversationId) as ObservedConversation), busy: true });
    this.push({ type: "run_start", ...(inputs !== null && { inputs }) });
    await this.events?.emit("agent.started", { conversation, requestId: requestIds[0] as string, resumed: false });
  }

  /**
   * The run of `key` that took `requestIds` ends (recorded, then announced unless `quiet`), with what it
   * wrote (`messages`; by default the runtime's own user message, which the user never sees, then its
   * answer, `answerOf(text)`).
   */
  async end(
    key: string,
    requestIds: string[],
    outcome: { kind?: "completed" | "aborted" | "failed"; text?: string; quiet?: boolean; messages?: unknown[] } = {},
  ): Promise<RunSettlement> {
    const conversation = this.pointers.get(key) as ConversationRef;
    const kind = outcome.kind ?? "completed";
    const run: RunSettlement = {
      conversation,
      requestId: requestIds[0] as string,
      requestIds,
      kind,
      ...(kind === "completed" && { text: outcome.text ?? "the answer" }),
      ...(kind === "failed" && { error: { code: "model_error", message: "the model failed" } }),
    };
    this.conversations.set(conversation.conversationId, { ...(this.conversations.get(conversation.conversationId) as ObservedConversation), busy: false });
    await this.record.submissions.settled(run, this.events ?? (undefined as never));
    this.push({ type: "run_end" });
    if (outcome.quiet !== true) {
      const written = outcome.messages ?? [{ role: "user", content: "[the runtime's prompt]", timestamp: 1 }, ...(kind === "completed" ? [answerOf(run.text ?? "")] : [])];
      const result = { ...run, messages: written as never[] };
      if (kind === "failed") await this.events?.emit("agent.failed", { ...result, kind: "failed" });
      else await this.events?.emit("agent.settled", { ...result, kind });
    }
    return run;
  }

  component(): ComponentDefinition {
    return defineComponent({
      name: "runtime-test",
      setup: (pikit) => {
        pikit.provide("agent.observe", this.observer);
        pikit.provide("agent.runtime", this.runtime);
        pikit.provide("conversations.registry", this.registry);
        pikit.provide("agent.submissions", this.record.submissions);
        return {
          start: (ctx) => {
            this.events = ctx.derive(() => BACKGROUND_CONTEXT);
          },
          stop: () => {
            this.events = undefined;
          },
        };
      },
    });
  }
}

/** `storage.kv` in memory, surviving the Apps of a test. */
export function kvOf(storage = createMemoryKeyValueStorage()): ComponentDefinition {
  return defineComponent({ name: "kv-test", setup: (pikit) => pikit.provide("storage.kv", storage) });
}

export interface Logged {
  level: "info" | "warn" | "error";
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

/**
 * An App of `components`, started, whose `http.route`s are served as a server serves them at `origin`
 * (a path, or a whole URL of another host); `stop` it.
 */
export async function serve(components: ComponentDefinition[], config: Record<string, unknown> = {}, target: Target = "server", origin = "http://pikit.test"): Promise<Served> {
  const logged: Logged[] = [];
  const logger: Logger = {
    ...silentLogger,
    info: (message, fields) => void logged.push({ level: "info", message, fields }),
    warn: (message, fields) => void logged.push({ level: "warn", message, fields }),
    error: (message, fields) => void logged.push({ level: "error", message, fields }),
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
      const request = new Request(/^https?:/.test(path) ? path : `${origin}${path}`, init);
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

/** Waits until `probe` returns something defined (at most 2 s). */
export async function eventually<T>(probe: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

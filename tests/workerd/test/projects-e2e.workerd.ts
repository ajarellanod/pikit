/**
 * Projects end to end on Cloudflare, with the real components (features/projects.md), as
 * `tests/acceptance/projects.test.ts` proves them on a server: through deployment-cloudflare's Worker
 * `fetch` (`createWorkerHost`), its objects `PlatformConversation`s (`src/platform.ts`).
 *
 * - The objects' App, composed as a project's: storage-do, storage-kv-sql, actors-do (mailbox, inbox,
 *   wakeups), runtime-pi on provider-faux's `faux/scripted`, conversations-kv, router-basic,
 *   outbound-durable, admin-auth-token, admin-api, execution-do and tool-write (each chat's workspace),
 *   projects-sql (the directory `projects:index`, each project in the object of its space), memory-sql
 *   (each space's memory in its object), memory-recall, tool-space-files (each space's index in its
 *   object), projects-context and channel-web (better-auth in the accounts actor).
 * - The Worker's App: actors-do, admin-auth-token, admin-api's, projects-sql's, memory-sql's,
 *   tool-space-files' and channel-web's Worker halves: the page's routes run there, every store reached
 *   by RPC.
 * - Doubles: `principals` (no kit provider), and `storage.blob` (tool-space-files' in-memory double, one
 *   for the isolate the objects share; on Cloudflare a bucket every App reaches).
 *
 * The flow: people sign up; Ana makes a project on the page, adds Ben, writes its instructions and a
 * core document; Ben's chat in it sees the `<project>` section and only the project's tools; the agent
 * adds a note, a rule, a file and a link, each "Added to the project"; the next section carries the rule
 * with its source; `project_search` finds each kind across the three stores' objects and `project_read`
 * reads them; the chat's notices and History come from the three logs; Ben removes the note and brings
 * it back exactly from History; Cy, no member, gets `404`; Ben removed, his chat refuses his message
 * (`403`); Ana's chat of no project has the plain memory and files tools and no section.
 */

import { type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { defineAgent, type Principal, type Principals } from "@pikit/contracts";
import { afterEach, expect, it, vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import adminApi, { worker as adminApiWorker } from "../../../registry/components/admin-api/files/src/pikit/admin-api/index.ts";
import adminAuthToken from "../../../registry/components/admin-auth-token/files/src/pikit/admin-auth-token/index.ts";
import type { ChatChange, ChatMemory, ChatNotices, ChatPage, ChatProject, ChatTranscriptEntry } from "../../../registry/components/channel-web/files/src/pikit/channel-web/api.ts";
import channelWeb, { worker as channelWebWorker } from "../../../registry/components/channel-web/files/src/pikit/channel-web/index.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import { createWorkerHost } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts";
import executionDo from "../../../registry/components/execution-do/files/src/pikit/execution-do/index.ts";
import memoryRecall from "../../../registry/components/memory-recall/files/src/pikit/memory-recall/index.ts";
import memorySql, { worker as memorySqlWorker } from "../../../registry/components/memory-sql/files/src/pikit/memory-sql/index.ts";
import outboundDurable from "../../../registry/components/outbound-durable/files/src/pikit/outbound-durable/index.ts";
import projectsContext from "../../../registry/components/projects-context/files/src/pikit/projects-context/index.ts";
import projectsSql from "../../../registry/components/projects-sql/files/src/pikit/projects-sql/index.ts";
import { worker as projectsSqlWorker } from "../../../registry/components/projects-sql/files/src/pikit/projects-sql/worker.ts";
import providerFaux from "../../../registry/components/provider-faux/files/src/pikit/provider-faux/index.ts";
import routerBasic from "../../../registry/components/router-basic/files/src/pikit/router-basic/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import toolSpaceFiles, { worker as spaceFilesWorker } from "../../../registry/components/tool-space-files/files/src/pikit/tool-space-files/index.ts";
import { createMemoryBlobStorage, memoryBlob } from "../../../registry/components/tool-space-files/files/src/pikit/tool-space-files/memory-blob.test-support.ts";
import toolWrite from "../../../registry/components/tool-write/files/src/pikit/tool-write/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

afterEach(async () => {
  await resetObjects();
});

const ADMIN_TOKEN = "workerd-operator-token-0123456789abcdef";
const SECRETS: Record<string, string> = { CHANNEL_WEB_AUTH_SECRET: "workerd-chat-secret-0123456789abcdefghijklmnop", PIKIT_ADMIN_TOKEN: ADMIN_TOKEN };
const secrets = defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => SECRETS[name] }) });

const assistant = defineAgent({ name: "assistant", model: "faux/scripted", tools: ["write"], extensions: ["project", "memory", "space-files"] });
const agents = defineComponent({ name: "agents-fixture", setup: (pikit) => pikit.provideKeyed("agent.definition", assistant.name, assistant) });

/** `principals`: each principal only itself (no directory linking identities here). */
const principals = (name: string) =>
  defineComponent({
    name,
    setup: (pikit) => pikit.provide("principals", { of: async (principal: Principal) => [principal], find: async () => [] } satisfies Principals),
  });

const PAGE = "https://agents.example.com/chat/#/projects/{id}";
const WINDOWS = { freshMs: 0, noProjectMs: 0 };

/** Both Apps; the Worker's `fetch`. */
function compose() {
  const blobs = createMemoryBlobStorage();
  const chat = { name: "Ada", signUp: { mode: "open" }, agents: ["assistant"] };
  const objects: ComponentDefinition[] = [
    storageDo,
    storageKvSql,
    actorsDo,
    secrets,
    agents,
    providerFaux,
    runtimePi,
    conversationsKv,
    routerBasic,
    outboundDurable,
    adminAuthToken,
    adminApi,
    executionDo,
    toolWrite,
    memoryBlob(blobs),
    principals("principals-objects"),
    projectsSql,
    memorySql,
    memoryRecall,
    toolSpaceFiles,
    projectsContext,
    channelWeb,
  ];
  composeObjects(objects, {
    "router-basic": { defaultAgent: "assistant" },
    "channel-web": chat,
    "memory-recall": WINDOWS,
    "tool-space-files": WINDOWS,
    "projects-context": { ...WINDOWS, pageUrl: PAGE },
  });
  const worker = defineApp({
    components: [actorsDo, secrets, adminAuthToken, adminApiWorker, memoryBlob(blobs), principals("principals-worker"), projectsSqlWorker, memorySqlWorker, spaceFilesWorker, channelWebWorker],
    config: { "actors-do": { binding: PLATFORM_BINDING }, "channel-web-worker": chat },
    target: "durable",
    logger: silentLogger,
  });
  const host = createWorkerHost(worker, { logger: silentLogger });
  return (url: string, init: RequestInit = {}) => host.fetch(new Request(url, init), workerEnv);
}

type Fetch = ReturnType<typeof compose>;
const ORIGIN = "https://pikit.test";

/** A browser: its cookies sent back on every request, the page's header. */
function browser(fetch: Fetch, ip: string) {
  const jar = new Map<string, string>();
  const send = async (path: string, init: { method?: string; json?: unknown } = {}): Promise<Response> => {
    const headers: Record<string, string> = { origin: ORIGIN, "cf-connecting-ip": ip, "x-pikit-chat": "1" };
    if (jar.size > 0) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    if (init.json !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${ORIGIN}${path}`, {
      method: init.method ?? (init.json === undefined ? "GET" : "POST"),
      headers,
      redirect: "manual",
      ...(init.json !== undefined && { body: JSON.stringify(init.json) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      const value = pair.slice(at + 1);
      if (value === "" || /max-age=0/i.test(cookie)) jar.delete(pair.slice(0, at));
      else jar.set(pair.slice(0, at), value);
    }
    return response;
  };
  /** `path`'s JSON, expecting `status`. */
  const json = async <T>(path: string, init: { method?: string; json?: unknown } = {}, status = 200): Promise<T> => {
    const response = await send(path, init);
    const text = await response.text();
    expect([path, response.status, response.status === status ? "" : text]).toEqual([path, status, ""]);
    return (text === "" ? undefined : JSON.parse(text)) as T;
  };
  return { send, json };
}
type Browser = ReturnType<typeof browser>;

async function signUp(fetch: Fetch, email: string, name: string, ip: string): Promise<Browser> {
  const who = browser(fetch, ip);
  const response = await who.send("/chat/api/auth/sign-up/email", { json: { email, password: "a-long-password-1", name } });
  expect(response.status, await response.clone().text()).toBe(200);
  return who;
}

type Message = { role: string; content: string | { type: string; text?: string }[] };
const textOf = (message: Message): string => (typeof message.content === "string" ? message.content : message.content.map((block) => block.text ?? "").join(""));

/** The answer to request `requestId` of chat `chat`: the last assistant text of its run, once the message is answered. */
async function answerOf(who: Browser, chat: string, requestId: string): Promise<string> {
  return await vi.waitFor(
    async () => {
      const items = (await who.json<ChatPage<ChatTranscriptEntry>>(`/chat/api/conversations/${chat}/transcript?limit=100`)).items;
      const asked = items.find((entry) => entry.id === requestId);
      expect(asked?.state).toBe("answered");
      const run = items.filter((entry) => entry.id.startsWith(`${requestId}#`)).reverse();
      const texts = run.flatMap((entry) => (entry.messages as Message[]).filter((m) => m.role === "assistant").map(textOf)).filter((text) => text !== "");
      expect(texts.length).toBeGreaterThan(0);
      return texts.at(-1) as string;
    },
    { timeout: 20_000, interval: 50 },
  );
}

/** `who` starts a chat (in `project`, when given): its id and the answer. */
async function start(who: Browser, text: string, project?: string): Promise<{ chat: string; answer: string }> {
  const made = await who.json<{ id: string; requestId: string }>("/chat/api/conversations", { json: { text, ...(project !== undefined && { project }) } }, 201);
  return { chat: made.id, answer: await answerOf(who, made.id, made.requestId) };
}
/** `who` says `text` in chat `chat`: the answer. */
async function say(who: Browser, chat: string, text: string): Promise<string> {
  const sent = await who.json<{ requestId: string }>(`/chat/api/conversations/${chat}/messages`, { json: { text } }, 202);
  return answerOf(who, chat, sent.requestId);
}
const call = (tool: string, args: Record<string, unknown>) => `call: ${tool} ${JSON.stringify(args)}`;

it("a project end to end on Cloudflare: made on the page, its chat's agent sees it and adds to it across the stores' objects, History, undo, members", { timeout: 180_000 }, async () => {
  const fetch = compose();
  const ana = await signUp(fetch, "ana@example.com", "Ana", "10.7.0.1");
  const ben = await signUp(fetch, "ben@example.com", "Ben", "10.7.0.2");
  const cy = await signUp(fetch, "cy@example.com", "Cy", "10.7.0.3");

  // Ana makes the project, adds Ben, writes its instructions and a core document.
  const project = await ana.json<ChatProject>("/chat/api/projects", { json: { name: "AECC 2027" } }, 201);
  const P = `/chat/api/projects/${project.id}`;
  await ana.json(`${P}/members`, { json: { email: "ben@example.com" } }, 201);
  await ana.json(`${P}/instructions`, { method: "PUT", json: { text: "Answer the client formally.", ifVersion: 0 } });
  const brief = await ana.json<{ id: string }>(`${P}/documents`, { json: { title: "Brief 2027", mode: "core", text: "The brief: a launch in Valencia, for 300 guests." } }, 201);

  // Ben's chat in it: the project's tools only, and its one section.
  const { chat, answer: tools } = await start(ben, "echo-tools", project.id);
  expect(tools).toBe("project_file_get, project_file_save, project_link, project_note, project_read, project_rule, project_search, propose_preference, write");
  const section = await say(ben, chat, "echo-system project");
  expect(section).toContain(`<project>\nYou work in the project "AECC 2027" (${project.id})`);
  expect(section).toContain("Answer the client formally.");
  expect(section).toContain(`<document id="${brief.id}" title="Brief 2027" version="1"`);
  expect(await say(ben, chat, "echo-system memory")).toBe("(no section memory)");

  // The agent adds a note, a rule, a file and a link: each says so.
  const added = async (text: string) => (await say(ben, chat, text)).split("\n").at(-1);
  expect(await added(call("project_note", { note: "Juan visits Valencia on Tuesdays" }))).toBe("Added to the project: Juan visits Valencia on Tuesdays");
  expect(await added(call("project_rule", { rule: "Quote prices for Valencia in EUR" }))).toBe("Added to the project: Quote prices for Valencia in EUR");
  expect(await say(ben, chat, call("write", { path: "venue.md", content: "The venue in Valencia seats 300 people." }))).toMatch(/^write: /);
  expect(await added(call("project_file_save", { path: "venue.md", description: "Venue notes" }))).toBe("Added to the project: venue.md");
  expect(await added(call("project_link", { url: "https://drive.google.com/valencia", title: "Valencia folder" }))).toBe("Added to the project: Valencia folder");
  expect(await say(ben, chat, "echo-system project")).toMatch(/- Quote prices for Valencia in EUR \(rule:r-[0-9a-f]{8}; added by agent assistant in a web chat, answering web:[^,]+, \d{4}-\d\d-\d\d\)/);

  // One search across the three stores' objects finds each kind; each hit's ref reads.
  const found = (await say(ben, chat, call("project_search", { query: "Valencia" }))).replace(/^project_search: /, "");
  const hits = found.split("\n").flatMap((line) => {
    const hit = /^- \[(\w+)\] .* \(((?:\w+)(?::[^;,)]+)?)[;,)]/.exec(line);
    return hit === null ? [] : [{ kind: hit[1] as string, ref: hit[2] as string }];
  });
  expect(new Set(hits.map((hit) => hit.kind))).toEqual(new Set(["document", "rule", "note", "file", "link"]));
  const refOf = (kind: string) => hits.find((hit) => hit.kind === kind)?.ref as string;
  expect(await say(ben, chat, call("project_read", { item: refOf("file") }))).toMatch(/\nThe venue in Valencia seats 300 people\.$/);
  expect(await say(ben, chat, call("project_read", { item: refOf("note") }))).toMatch(/\nJuan visits Valencia on Tuesdays$/);
  expect(await say(ben, chat, call("project_read", { item: refOf("document") }))).toContain("The brief: a launch in Valencia, for 300 guests.");

  // The chat's notices and History: the three logs, through the Worker's halves.
  const notices = await ben.json<ChatNotices>(`/chat/api/conversations/${chat}/notices`);
  expect(notices.items.map((item) => [item.log, item.item.kind]).sort()).toEqual([
    ["files", "file"],
    ["memory", "note"],
    ["memory", "rule"],
    ["project", "link"],
  ]);
  const history = await ana.json<ChatPage<ChatChange>>(`${P}/history?limit=50`);
  expect(new Set(history.items.map((item) => item.log))).toEqual(new Set(["project", "memory", "files"]));
  expect(history.items).toHaveLength(8);

  // Ben removes the note and brings it back from History: the same id, words and author.
  const note = (await ben.json<ChatMemory>(`${P}/memory`)).notes[0];
  expect(note?.by).toMatchObject({ kind: "agent", agent: "assistant" });
  await ben.json(`${P}/memory/${encodeURIComponent(note?.id ?? "")}`, { method: "DELETE" }, 204);
  const removal = (await ben.json<ChatPage<ChatChange>>(`${P}/history?limit=1`)).items[0] as ChatChange;
  expect(removal).toMatchObject({ log: "memory", action: "removed", item: { kind: "note", id: note?.id } });
  await ben.json(`${P}/history/memory/${removal.n}/restore`, { method: "POST" });
  expect((await ben.json<ChatMemory>(`${P}/memory`)).notes).toEqual([note]);

  // Cy, no member: 404, nothing read.
  for (const path of [P, `${P}/members`, `${P}/files`, `${P}/memory`, `${P}/history`, `${P}/conversations`]) expect([path, (await cy.send(path)).status]).toEqual([path, 404]);
  expect((await cy.send("/chat/api/conversations", { json: { text: "hello", project: project.id } })).status).toBe(404);

  // Ben removed: his chat refuses his message, the project's routes are 404 for him.
  const benId = ((await (await ben.send("/chat/api/me")).json()) as { user: { id: string } }).user.id;
  await ana.json(`${P}/members/${encodeURIComponent(`web:${benId}`)}`, { method: "DELETE" }, 204);
  expect((await ben.send(`/chat/api/conversations/${chat}/messages`, { json: { text: "hello" } })).status).toBe(403);
  expect((await ben.send(`${P}/memory`, { json: { kind: "note", text: "His note" } })).status).toBe(404);

  // Outside a project: the plain memory and files tools, no project_ tool, no <project> section.
  const plain = await start(ana, "echo-tools");
  expect(plain.answer).toBe("files_delete, files_get, files_list, files_save, forget, propose_preference, propose_rule, read_memory, recall, remember, write");
  expect(await say(ana, plain.chat, "echo-system project")).toBe("(no section project)");
});

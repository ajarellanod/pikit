/**
 * The projects' routes (`/chat/api/projects/*`, `api.ts` says what each answers; features/projects.md,
 * "channel-web's routes"), written once over the App's optional capabilities, which both halves have
 * where their routes run (`index.ts` on a server, `worker.ts` on Cloudflare): `projects` (the record,
 * members, instructions, documents, links, its log), `space.files` (the files), `memory` (the space's
 * rules, notes and summaries), `principals` (a person's other identities, a member named by email) and
 * `document.convert` (a document's text from a file). Without `projects` there are no projects: every
 * route here, and a project a chat names, is `404`.
 *
 * - **The caller is the session's.** Every route builds `{ kind: "people", principals }` from the
 *   session's user (`{ channel: "web", id }` with its name, then `principals.of` when given), in one
 *   place (`who`), and an author `{ kind: "person", principal }` from it: never from the page's words.
 * - **The store decides.** A route finds the project's space with `locate(id)` (the former projects
 *   carried over first, `migrateProjects`), then asks the store with that caller: a non-member, a
 *   missing or removed project are `404` alike, with nothing read or written; an owner's act by a member
 *   `403`; a write over a newer version `409`; past a bound or a credential's shape `400` (a file past
 *   its size `413`), each as the store said it (`routes.ts`' `refusalOf`). `space.files` and `memory`
 *   are trusted code that checks no person: their routes ask `projects.roleOf` first (`member`), and a
 *   non-member is `404` before anything of them is read or written. A file read by its route is the
 *   caller's to convert only after that check (a converter costs).
 * - **History** merges the three logs (`projects.changes`, `memory.changes` of the space,
 *   `space.files.changes`) newest first, one log's entries always in its order, with a cursor that keeps
 *   each log's place; a restore goes to the store that holds the entry (`.../history/:log/:n/restore`),
 *   whose rules apply (the project's own record and its members: the owner's). No route edits or
 *   deletes an entry.
 * - **A chat in a project** (`ProjectAccess`, used by `routes.ts`): made only by a member, in a project
 *   not archived, with an agent the project allows (`Project.agents`, when not empty, among those users
 *   may pick), in the project's space (`Project.space`); a message posted in one only while its author
 *   is still a member, the project not archived, and its agent still allowed (`403`). Every member reads
 *   every chat of the project (`.../conversations`, cut by the policy as one's own).
 * - **The notices of a chat** (`GET /chat/api/conversations/:id/notices`): what was added to its project
 *   from it, read from the three logs (entries whose author's `conversation` is this chat's key), shown
 *   by the page under the answer that made it, with Undo: the notice does not depend on the model.
 * - **A user removed** (`userRemoved`, the operator's route): each project they own goes to its oldest
 *   current manual member, else is archived; they leave every project.
 * - **Logs** carry user and project ids, never names, texts, file names or URLs.
 */

import type { AppContext, Pikit } from "@pikit/core";
import {
  type Author,
  type Caller,
  type Change,
  type ChangePage,
  type ChangePageRequest,
  CORE_TOKENS_DEFAULT,
  DOCUMENT_TITLE_MAX,
  type DocumentConverter,
  isTextType,
  type Member,
  mediaTypeOf,
  memberIsCurrent,
  type Principal,
  PRINCIPAL_NAME_MAX,
  type Principals,
  type Project,
  type ProjectDocument,
  type ProjectStore,
  type SpaceFile,
  type SpaceFiles,
  STALE_AFTER_MS_DEFAULT,
  samePrincipal,
  textOf,
} from "@pikit/contracts";
import Type from "typebox";
import type { Accounts, AccountUser } from "./accounts/types.ts";
import {
  type ChatAuthor,
  type ChatChange,
  type ChatConfig,
  type ChatConversation,
  type ChatDocument,
  type ChatDocumentRead,
  type ChatDocuments,
  type ChatFiles,
  type ChatInstructions,
  type ChatInstructionsRead,
  type ChatLink,
  type ChatMember,
  type ChatMemory,
  type ChatMemoryItem,
  type ChatNotices,
  type ChatPage,
  type ChatProject,
  type ChatProjectConversation,
  type ChatProjectFeatures,
  type ChatProjectOverview,
  type ChatSpaceFile,
  type ChatTranscriptEntry,
  type ChatVersion,
  HISTORY_LOGS,
  MAX_UPLOAD_BYTES,
  PROJECT_DESCRIPTION_MAX,
  PROJECT_NAME_MAX,
} from "./api.ts";
import type { ChatBackend } from "./backend.ts";
import { CHANNEL, isChatId, isProjectId, keyOf } from "./chat.ts";
import type { Memory, MemoryOwner, MemoryStore } from "./contract.ts";
import { API, bodyOf, bytesOf, checked, json, pageOf, Refused, shownConversation, userRoutes } from "./routes.ts";
import { projectEntry } from "./visibility.ts";

/** The capabilities the routes use, each optional (`useOptional`), read in a handler. */
export interface ProjectServices {
  projects(): ProjectStore | undefined;
  files(): SpaceFiles | undefined;
  memory(): MemoryStore | undefined;
  principals(): Principals | undefined;
  convert(): DocumentConverter | undefined;
}

export interface ProjectRouteOptions {
  services: ProjectServices;
  /** Read in a handler, never in setup. */
  accounts(): Accounts;
  backend(): ChatBackend;
  /** The page's config: the agents users may pick (`agents`), its `visibility`, whether email is sent. */
  chatConfig(ctx: AppContext): Promise<ChatConfig>;
}

/** What `routes.ts` asks of the projects about a chat. */
export interface ProjectAccess {
  /** What the page shows of projects; `undefined`: no project store, no projects. */
  features(): ChatProjectFeatures | undefined;
  /**
   * A new chat of `user` in project `id`, with `agent` when they picked one: its space and the agent it is
   * made with. Refuses `404` (no project of theirs), `403` (archived), `400` (an agent it does not allow).
   */
  starting(user: AccountUser, id: string, agent: string | undefined, ctx: AppContext): Promise<{ space: string; agent?: string }>;
  /** Before `user`'s message in their `conversation` of a project: `403` once they are no member, it is archived, or its agent is no longer allowed. */
  posting(user: AccountUser, conversation: ChatConversation, ctx: AppContext): Promise<void>;
  /** Before listing `user`'s chats of project `id`: `404` when they are no member. */
  listing(user: AccountUser, id: string, ctx: AppContext): Promise<void>;
  /** The user `userId` was removed by `operator`: their projects handed over (or archived), their memberships gone. Never rejects. */
  userRemoved(userId: string, operator: string, ctx: AppContext): Promise<void>;
}

type Log = (typeof HISTORY_LOGS)[number];
type Who = { principal: Principal; principals: Principal[]; caller: Caller & { kind: "people" }; author: Author };

/** How many entries one page of History reads of each log, at most. */
const HISTORY_MAX = 100;
const HISTORY_DEFAULT = 30;
/** The recent changes an overview shows. */
const RECENT = 10;
/** The notices a chat shows, at most, and how far back in each log they are looked for. */
const NOTICES_MAX = 50;
const NOTICES_READ = 200;
/** The body of a document's text: its characters escaped, at most. */
const DOCUMENT_BODY = 3 * 1024 * 1024;
const SMALL_BODY = 64 * 1024;
const MEMORY_LIST = 200;
const NO_PROJECT = "no such project";

const notFound = (what = NO_PROJECT): Refused => new Refused(404, "not_found", what);
const noContent = (): Response => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

/** Path segment `index` of `request` (`/chat/api/projects/:id/...`: the id is 4), decoded; `""` when it is not one. */
function segment(request: Request, index: number): string {
  const raw = new URL(request.url).pathname.split("/")[index] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

/** An id a store made (a document's, a link's, a memory's): 1 to 256 characters, no control character. */
function itemIdOf(request: Request, index: number, what: string): string {
  const id = segment(request, index);
  if (id === "" || id.length > 256 || [...id].some((char) => char.charCodeAt(0) < 32)) throw notFound(`no such ${what}`);
  return id;
}

/** `?name` of `request`, an integer from 1, or `undefined`. */
function positive(request: Request, name: string): number | undefined {
  const value = new URL(request.url).searchParams.get(name);
  if (value === null) return undefined;
  if (!/^[0-9]{1,9}$/.test(value) || Number(value) < 1) throw new Refused(400, "invalid_request", `${name} is an integer from 1`);
  return Number(value);
}

/**
 * The id of a rule of `text`, as memory-recall makes it (`itemId("rule", text)`: `r-` and the first 4
 * bytes of SHA-256 of its words lowercased): the same words added from the page or by `/rules add` are one
 * rule. Its copy: memory-recall's is the rule `/rules` and `project_rule` use.
 */
export async function ruleId(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized(text).toLowerCase())));
  return `r-${[...digest.slice(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
const normalized = (text: string): string => text.trim().replace(/\s+/g, " ");

/** A History cursor: each log's place (`before`), `0` once read to its end; absent: from its newest. */
type HistoryCursor = Partial<Record<Log, number>>;

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function parseHistoryCursor(text: string): HistoryCursor {
  try {
    const value = JSON.parse(atob(text.replace(/-/g, "+").replace(/_/g, "/"))) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    const cursor: HistoryCursor = {};
    for (const [log, place] of Object.entries(value)) {
      if (!(HISTORY_LOGS as readonly string[]).includes(log) || typeof place !== "number" || !Number.isInteger(place) || place < 0) throw new Error("not a place");
      cursor[log as Log] = place;
    }
    return cursor;
  } catch {
    throw new Refused(400, "invalid_cursor", "the cursor is not one this API gave");
  }
}

/**
 * The pages of each log merged, newest first, at most `limit`: one log's entries always in its order (a
 * k-way merge by time, ties in `HISTORY_LOGS` order), so each log's place is the last entry taken of it.
 */
export function mergeHistory(pages: ReadonlyMap<Log, { page: ChangePage; place: number | undefined }>, limit: number): { items: ChatChange[]; next?: HistoryCursor } {
  const heads = new Map<Log, number>([...pages.keys()].map((log) => [log, 0]));
  const items: ChatChange[] = [];
  while (items.length < limit) {
    let best: Log | undefined;
    for (const log of HISTORY_LOGS) {
      const read = pages.get(log);
      const head = read?.page.items[heads.get(log) ?? 0];
      if (head === undefined) continue;
      const current = best === undefined ? undefined : pages.get(best)?.page.items[heads.get(best) ?? 0];
      if (current === undefined || head.at > current.at) best = log;
    }
    if (best === undefined) break;
    const at = heads.get(best) ?? 0;
    items.push(changeOf(best, (pages.get(best) as { page: ChangePage }).page.items[at] as Change));
    heads.set(best, at + 1);
  }
  const next: HistoryCursor = {};
  let more = false;
  for (const [log, { page, place }] of pages) {
    const taken = heads.get(log) ?? 0;
    const value = taken < page.items.length ? (taken === 0 ? place : page.items[taken - 1]?.n) : (page.next ?? 0);
    if (value !== undefined) next[log] = value;
    if (value !== 0) more = true;
  }
  return { items, ...(more && { next }) };
}

/**
 * Of `entries` (one log's, newest first), the changes whose earlier state is back now, each with the
 * restore that brought it: a `restored` entry whose own change was not restored since (an Undo undone
 * puts it back).
 */
export function undoneIn(entries: readonly Change[]): Map<number, Change> {
  const byNumber = new Map(entries.map((entry) => [entry.n, entry]));
  const restoredBy = new Map<number, Change>();
  // Newest first: the first restore met of each change is its latest.
  for (const entry of entries) if (entry.action === "restored" && entry.restores !== undefined && !restoredBy.has(entry.restores)) restoredBy.set(entry.restores, entry);
  const undone = new Map<number, Change>();
  const isUndone = (n: number, depth = 0): boolean => {
    const restore = restoredBy.get(n);
    if (restore === undefined || depth > 50) return false;
    // A restore that was itself undone leaves the change in place.
    return !isUndone(restore.n, depth + 1);
  };
  for (const n of byNumber.keys()) {
    const restore = restoredBy.get(n);
    if (restore !== undefined && isUndone(n)) undone.set(n, restore);
  }
  return undone;
}

/** An entry as the page shows it, with its log. */
const changeOf = (log: Log, change: Change): ChatChange => ({ log, ...change, by: change.by as ChatAuthor, ...(change.redacted !== undefined && { redacted: { at: change.redacted.at, by: change.redacted.by as ChatAuthor } }) });

const chatProjectOf = (project: Project, chats: number): ChatProject => ({
  id: project.id,
  name: project.name,
  description: project.description,
  agents: [...project.agents],
  owner: project.owner,
  role: project.role ?? "member",
  members: project.members,
  archived: project.archivedAt !== undefined,
  chats,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

const chatDocumentOf = (document: ProjectDocument): ChatDocument => ({ ...document, by: document.by as ChatAuthor });

const chatFileOf = (file: SpaceFile & { versions?: number }): ChatSpaceFile => ({
  name: file.name,
  version: file.version,
  ...(file.versions !== undefined && { versions: file.versions }),
  description: file.description,
  size: file.size,
  ...(file.type !== undefined && { type: file.type }),
  by: file.by as ChatAuthor,
  createdAt: file.createdAt,
  ...(file.trashedAt !== undefined && { trashedAt: file.trashedAt }),
  text: file.text,
});

const MEMORY_KIND: Record<string, ChatMemoryItem["kind"] | undefined> = { rule: "rule", fact: "note", summary: "summary" };
const chatMemoryOf = (memory: Memory): ChatMemoryItem => ({
  id: memory.id,
  kind: MEMORY_KIND[memory.kind] ?? "note",
  status: memory.status,
  text: memory.text,
  createdAt: memory.createdAt,
  ...(memory.updatedAt !== undefined && { updatedAt: memory.updatedAt }),
  ...(memory.by !== undefined && { by: memory.by as ChatAuthor }),
});

const ProjectBody = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: PROJECT_NAME_MAX * 4 }), description: Type.Optional(Type.String({ maxLength: PROJECT_DESCRIPTION_MAX * 2 })) },
  { additionalProperties: false },
);
const UpdateBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: PROJECT_NAME_MAX * 4 })),
    description: Type.Optional(Type.String({ maxLength: PROJECT_DESCRIPTION_MAX * 2 })),
    agents: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 50 })),
    archived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const MemberBody = Type.Object({ email: Type.String({ minLength: 3, maxLength: 254 }) }, { additionalProperties: false });
const PrincipalBody = Type.Object({ channel: Type.String({ minLength: 1, maxLength: 1024 }), id: Type.String({ minLength: 1, maxLength: 1024 }), name: Type.Optional(Type.String({ maxLength: 200 })) }, { additionalProperties: false });
const InstructionsBody = Type.Object({ text: Type.String({ maxLength: 100_000 }), ifVersion: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
const Mode = Type.Union([Type.Literal("core"), Type.Literal("reference")]);
const DocumentBody = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 500 }),
    mode: Mode,
    text: Type.Optional(Type.String()),
    file: Type.Optional(Type.Object({ name: Type.String({ minLength: 1, maxLength: 255 }), version: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);
const DocumentUpdateBody = Type.Object(
  { title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), mode: Type.Optional(Mode), text: Type.Optional(Type.String()), ifVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
const MemoryBody = Type.Object({ kind: Type.Union([Type.Literal("rule"), Type.Literal("note")]), text: Type.String({ minLength: 1, maxLength: 20_000 }) }, { additionalProperties: false });
const MemoryEditBody = Type.Object({ text: Type.String({ minLength: 1, maxLength: 20_000 }) }, { additionalProperties: false });
const LinkBody = Type.Object(
  { url: Type.String({ minLength: 1, maxLength: 4096 }), title: Type.String({ minLength: 1, maxLength: 500 }), note: Type.Optional(Type.String({ maxLength: 2000 })) },
  { additionalProperties: false },
);

/** Registers the projects' routes and gives what `routes.ts` asks of them. */
export function provideProjectRoutes(pikit: Pikit, options: ProjectRouteOptions): ProjectAccess {
  const { services } = options;
  const user = userRoutes(pikit, () => options.accounts());
  const backend = () => options.backend();

  /** The project store, or no projects: `404`. */
  const store = (): ProjectStore => {
    const found = services.projects();
    if (found === undefined) throw notFound();
    return found;
  };

  /** The former projects carried over once, before any project is located (a failure is tried again at the next request). */
  let migration: Promise<void> | undefined;
  const migrated = (ctx: AppContext): Promise<void> => {
    migration ??= backend()
      .migrateProjects(ctx)
      .then(
        () => undefined,
        (error: unknown) => {
          migration = undefined;
          throw error;
        },
      );
    return migration;
  };

  /** The caller and the author of `user`'s requests: the session's, never the page's words. */
  const who = async (me: AccountUser, ctx: AppContext): Promise<Who> => {
    const name = me.name.replace(/\s+/g, " ").trim().slice(0, PRINCIPAL_NAME_MAX);
    const principal: Principal = { channel: CHANNEL, id: me.id, ...(name !== "" && { name }) };
    const directory = services.principals();
    const others = directory === undefined ? [] : await directory.of({ channel: CHANNEL, id: me.id }, ctx);
    const principals = [principal, ...others.filter((each) => !samePrincipal(each, principal))].slice(0, 20);
    return { principal, principals, caller: { kind: "people", principals }, author: { kind: "person", principal } };
  };

  /** The space of project `id` (after the migration), or `404`. */
  const locate = async (id: string, ctx: AppContext): Promise<{ projects: ProjectStore; space: string }> => {
    if (!isProjectId(id)) throw notFound();
    const projects = store();
    await migrated(ctx);
    const space = await projects.locate(id, ctx);
    if (space === undefined) throw notFound();
    return { projects, space };
  };

  /** The project of the route's `:id`, and who asks; the store decides each call. */
  const at = async (request: Request, me: AccountUser, ctx: AppContext) => {
    const id = segment(request, 4);
    const [found, asking] = await Promise.all([locate(id, ctx), who(me, ctx)]);
    return { id, ...found, who: asking };
  };

  /** As `at`, for the stores that check no person (`space.files`, `memory`): a member, else `404` before anything is read. */
  const memberAt = async (request: Request, me: AccountUser, ctx: AppContext) => {
    const found = await at(request, me, ctx);
    const role = await found.projects.roleOf(found.space, found.who.principals, ctx);
    if (role === undefined) throw notFound();
    return { ...found, role };
  };

  const filesOf = (): SpaceFiles => {
    const files = services.files();
    if (files === undefined) throw notFound("this App keeps no files for its projects");
    return files;
  };
  const memoryOf = (): MemoryStore => {
    const memory = services.memory();
    if (memory === undefined) throw notFound("this App keeps no memory for its projects");
    return memory;
  };
  const ownerOf = (space: string): MemoryOwner => ({ type: "space", space });

  /** How many chats `ids` have (every member's). */
  const chatsOf = (ids: readonly string[], ctx: AppContext) => (ids.length === 0 ? Promise.resolve({} as Record<string, number>) : backend().projectChats(ids, ctx));

  /** One page of `log` of `space`, as `who` may read it (the project's log asks the store; the others were checked by `roleOf`). */
  const readLog = (log: Log, space: string, asking: Who, page: ChangePageRequest, ctx: AppContext): Promise<ChangePage> => {
    if (log === "project") return store().changes(space, page, asking.caller, ctx);
    if (log === "memory") return memoryOf().changes(ownerOf(space), page, ctx);
    return filesOf().changes(space, page, ctx);
  };
  /** The logs this App keeps of a project. */
  const logs = (): Log[] => HISTORY_LOGS.filter((log) => log === "project" || (log === "memory" ? services.memory() : services.files()) !== undefined);

  /** A page of the merged History of `space` (the caller a member: checked by the caller). */
  const history = async (space: string, asking: Who, limit: number, cursor: HistoryCursor, ctx: AppContext) => {
    const read = await Promise.all(
      logs().map(async (log) => {
        const place = cursor[log];
        const page: ChangePage = place === 0 ? { items: [] } : await readLog(log, space, asking, { limit, ...(place !== undefined && { before: place }) }, ctx);
        return [log, { page, place }] as const;
      }),
    );
    return mergeHistory(new Map(read), limit);
  };

  /** The text of a file's bytes: its own when it is text, else what `document.convert` makes of it; `415` otherwise. */
  const textFrom = async (bytes: Uint8Array, type: string, name: string, ctx: AppContext): Promise<string> => {
    if (isTextType(type)) {
      const text = textOf(bytes);
      if (text === undefined) throw new Refused(415, "unsupported", "the file is not text in UTF-8");
      return text;
    }
    const converter = services.convert();
    if (converter === undefined || !converter.accepts(type)) throw new Refused(415, "unsupported", "this file cannot be read as text here: give text or Markdown");
    if (bytes.byteLength > converter.maxBytes) throw new Refused(413, "too_large", `a document to convert is at most ${Math.floor(converter.maxBytes / 1024 / 1024)} MB`);
    const converted = await converter.convert({ bytes, type, name }, ctx);
    if (converted === undefined) throw new Refused(415, "unsupported", "this file cannot be read as text here");
    return converted.text;
  };

  /** The agents users may pick now, by name. */
  const offered = async (ctx: AppContext): Promise<string[]> => (await options.chatConfig(ctx)).agents.map((each) => each.name);

  // The projects.

  user(`GET ${API}/projects`, async (request, ctx, me) => {
    const projects = store();
    await migrated(ctx);
    const asking = await who(me, ctx);
    const archived = new URL(request.url).searchParams.get("archived") === "1";
    const found: Project[] = [];
    let cursor: string | undefined;
    // A person is in a few projects: every page (owned ones are at most 100).
    for (let page = 0; page < 10; page++) {
      const read = await projects.list({ archived, limit: 100, ...(cursor !== undefined && { cursor }) }, asking.caller, ctx);
      found.push(...read.items);
      cursor = read.next;
      if (cursor === undefined) break;
    }
    const chats = await chatsOf(
      found.map((each) => each.id),
      ctx,
    );
    return json<ChatPage<ChatProject>>(200, { items: found.map((each) => chatProjectOf(each, chats[each.id] ?? 0)) });
  });

  user(`POST ${API}/projects`, async (request, ctx, me) => {
    const projects = store();
    await migrated(ctx);
    const body = checked(ProjectBody, await bodyOf(request, SMALL_BODY));
    const asking = await who(me, ctx);
    const made = await projects.create({ name: body.name.replace(/\s+/g, " ").trim(), ...(body.description !== undefined && { description: body.description.trim() }) }, asking.caller, ctx);
    ctx.logger.info("channel-web: a user made a project", { user: me.id, project: made.id });
    return json<ChatProject>(201, chatProjectOf(made, 0));
  });

  user(`GET ${API}/projects/:id`, async (request, ctx, me) => {
    const { id, projects, space, who: asking } = await at(request, me, ctx);
    const project = await projects.get(space, asking.caller, ctx);
    if (project === undefined) throw notFound();
    const files = services.files();
    const memory = services.memory();
    const owner = ownerOf(space);
    const [documents, links, chats, recent, usage, counts] = await Promise.all([
      projects.documents(space, asking.caller, ctx),
      projects.links(space, asking.caller, ctx),
      chatsOf([id], ctx),
      history(space, asking, RECENT, {}, ctx),
      files === undefined ? undefined : files.list(space, { limit: 1 }, ctx),
      memory === undefined
        ? undefined
        : Promise.all([
            memory.list(owner, { kinds: ["rule"], status: "active" }, MEMORY_LIST, ctx),
            memory.list(owner, { kinds: ["fact"] }, MEMORY_LIST, ctx),
            memory.list(owner, { kinds: ["summary"] }, MEMORY_LIST, ctx),
          ]),
    ]);
    return json<ChatProjectOverview>(200, {
      project: chatProjectOf(project, chats[id] ?? 0),
      documents: documents.length,
      coreTokens: documents.filter((each) => each.mode === "core").reduce((sum, each) => sum + each.tokens, 0),
      coreBudget: CORE_TOKENS_DEFAULT,
      links: links.length,
      ...(usage !== undefined && { files: { names: usage.usage.names, bytes: usage.usage.bytes } }),
      ...(counts !== undefined && { memory: { rules: counts[0].length, notes: counts[1].length, summaries: counts[2].length } }),
      recent: recent.items,
    });
  });

  user(`PATCH ${API}/projects/:id`, async (request, ctx, me) => {
    const body = checked(UpdateBody, await bodyOf(request, SMALL_BODY));
    const { id, projects, space, who: asking } = await at(request, me, ctx);
    // Only agents users may pick: a project never opens one the operator did not offer.
    if (body.agents !== undefined && body.agents.length > 0) {
      const names = await offered(ctx);
      const unknown = body.agents.find((agent) => !names.includes(agent));
      if (unknown !== undefined) throw new Refused(400, "invalid_request", "/agents: only assistants this chat offers");
    }
    const changed = await projects.update(
      space,
      {
        ...(body.name !== undefined && { name: body.name.replace(/\s+/g, " ").trim() }),
        ...(body.description !== undefined && { description: body.description.trim() }),
        ...(body.agents !== undefined && { agents: [...new Set(body.agents)] }),
        ...(body.archived !== undefined && { archived: body.archived }),
      },
      asking.caller,
      ctx,
    );
    ctx.logger.info("channel-web: a user changed a project", { user: me.id, project: id });
    return json<ChatProject>(200, chatProjectOf(changed, (await chatsOf([id], ctx))[id] ?? 0));
  });

  user(`DELETE ${API}/projects/:id`, async (request, ctx, me) => {
    const { id, projects, space, who: asking } = await at(request, me, ctx);
    const project = await projects.get(space, asking.caller, ctx);
    if (project === undefined) throw notFound();
    // Its chats stay readable: a project with any is archived instead.
    if (((await chatsOf([id], ctx))[id] ?? 0) > 0) throw new Refused(409, "not_empty", "this project has conversations: archive it instead");
    await projects.remove(space, asking.caller, ctx);
    ctx.logger.info("channel-web: a user removed a project", { user: me.id, project: id });
    return noContent();
  });

  // Members.

  const memberOf = (member: Member, asking: Who, now: number): ChatMember => ({
    principal: member.principal,
    role: member.role,
    source: member.source,
    current: memberIsCurrent(member, now, STALE_AFTER_MS_DEFAULT),
    you: asking.principals.some((each) => samePrincipal(each, member.principal)),
    by: member.by as ChatAuthor,
    at: member.at,
  });

  user(`GET ${API}/projects/:id/members`, async (request, ctx, me) => {
    const { projects, space, who: asking } = await at(request, me, ctx);
    const page = await projects.members(space, pageOf(request), asking.caller, ctx);
    const now = ctx.clock.now();
    return json<ChatPage<ChatMember>>(200, { items: page.items.map((each) => memberOf(each, asking, now)), ...(page.next !== undefined && { next: page.next }) });
  });

  /** The principal an email names: the directory's (`principals.find`), else a user of this chat with it (verified when the App sends email). */
  const principalOfEmail = async (email: string, ctx: AppContext): Promise<Principal | undefined> => {
    const directory = services.principals();
    if (directory !== undefined) {
      const [found] = await directory.find(email, ctx);
      if (found !== undefined) return found;
    }
    const wanted = email.trim().toLowerCase();
    const page = await options.accounts().list({ limit: 100, offset: 0, q: wanted }, ctx);
    const match = page.items.find((each) => each.email.toLowerCase() === wanted && !each.banned);
    if (match === undefined) return undefined;
    // An address nobody proved is not a person to give a project to, where the App could have asked them to.
    if (!match.emailVerified && (await options.chatConfig(ctx)).email) return undefined;
    const name = match.name.replace(/\s+/g, " ").trim().slice(0, PRINCIPAL_NAME_MAX);
    return { channel: CHANNEL, id: match.id, ...(name !== "" && { name }) };
  };

  user(`POST ${API}/projects/:id/members`, async (request, ctx, me) => {
    const { email } = checked(MemberBody, await bodyOf(request, SMALL_BODY));
    const { id, projects, space, who: asking } = await at(request, me, ctx);
    // A member first: a non-member learns nothing of who uses this chat.
    if ((await projects.roleOf(space, asking.principals, ctx)) === undefined) throw notFound();
    const principal = await principalOfEmail(email, ctx);
    if (principal === undefined) throw new Refused(404, "not_found", "no one with that email uses this chat");
    const added = await projects.addMember(space, principal, asking.caller, ctx);
    ctx.logger.info("channel-web: a user added a member to a project", { user: me.id, project: id });
    return json<ChatMember>(201, memberOf(added, asking, ctx.clock.now()));
  });

  user(`DELETE ${API}/projects/:id/members/:member`, async (request, ctx, me) => {
    const key = segment(request, 6);
    const split = key.indexOf(":");
    let principal: Principal | undefined;
    try {
      if (split > 0 && split < key.length - 1) principal = { channel: decodeURIComponent(key.slice(0, split)), id: key.slice(split + 1) };
    } catch {
      principal = undefined;
    }
    if (principal === undefined) throw notFound("no such member");
    const { id, projects, space, who: asking } = await at(request, me, ctx);
    if (!(await projects.removeMember(space, principal, asking.caller, ctx))) throw notFound("no such member");
    ctx.logger.info("channel-web: a member left a project, or was removed by its owner", { user: me.id, project: id });
    return noContent();
  });

  user(`POST ${API}/projects/:id/owner`, async (request, ctx, me) => {
    const body = checked(PrincipalBody, await bodyOf(request, SMALL_BODY));
    const { id, projects, space, who: asking } = await at(request, me, ctx);
    const changed = await projects.transferOwnership(space, { channel: body.channel, id: body.id }, asking.caller, ctx);
    ctx.logger.info("channel-web: a project changed owner", { user: me.id, project: id });
    return json<ChatProject>(200, chatProjectOf(changed, (await chatsOf([id], ctx))[id] ?? 0));
  });

  // Instructions and documents.

  user(`GET ${API}/projects/:id/instructions`, async (request, ctx, me) => {
    const version = positive(request, "version");
    const { projects, space, who: asking } = await at(request, me, ctx);
    const found = await projects.instructions(space, version === undefined ? {} : { version }, asking.caller, ctx);
    return json<ChatInstructionsRead>(200, found === undefined ? {} : { instructions: { ...found, by: found.by as ChatAuthor } });
  });

  user(`PUT ${API}/projects/:id/instructions`, async (request, ctx, me) => {
    const body = checked(InstructionsBody, await bodyOf(request, SMALL_BODY * 4));
    const { id, projects, space, who: asking } = await at(request, me, ctx);
    const saved = await projects.setInstructions(space, { text: body.text, ifVersion: body.ifVersion }, asking.caller, ctx);
    ctx.logger.info("channel-web: a user changed a project's instructions", { user: me.id, project: id, version: saved.version });
    return json<ChatInstructions>(200, { ...saved, by: saved.by as ChatAuthor });
  });

  user(`GET ${API}/projects/:id/instructions/versions`, async (request, ctx, me) => {
    const { projects, space, who: asking } = await at(request, me, ctx);
    const versions = await projects.versions(space, { kind: "instructions" }, asking.caller, ctx);
    return json<ChatPage<ChatVersion>>(200, { items: versions.map((each) => ({ ...each, by: each.by as ChatAuthor })) });
  });

  user(`GET ${API}/projects/:id/documents`, async (request, ctx, me) => {
    const { projects, space, who: asking } = await at(request, me, ctx);
    const documents = await projects.documents(space, asking.caller, ctx);
    return json<ChatDocuments>(200, {
      items: documents.map(chatDocumentOf),
      coreTokens: documents.filter((each) => each.mode === "core").reduce((sum, each) => sum + each.tokens, 0),
      coreBudget: CORE_TOKENS_DEFAULT,
    });
  });

  user(`POST ${API}/projects/:id/documents`, async (request, ctx, me) => {
    const body = checked(DocumentBody, await bodyOf(request, DOCUMENT_BODY));
    if ((body.text === undefined) === (body.file === undefined)) throw new Refused(400, "invalid_request", "/text or /file: one of them");
    const { id, projects, space, who: asking } = await at(request, me, ctx);
    let text = body.text;
    let source: { file: string; fileVersion: number } | undefined;
    if (body.file !== undefined) {
      // A saved file's text: the files are read only for a member.
      if ((await projects.roleOf(space, asking.principals, ctx)) === undefined) throw notFound();
      const saved = await filesOf().get(space, body.file.name, body.file.version === undefined ? {} : { version: body.file.version }, ctx);
      if (saved === undefined) throw notFound("no such file");
      text = await textFrom(saved.bytes, saved.file.type ?? "application/octet-stream", saved.file.name, ctx);
      source = { file: saved.file.name, fileVersion: saved.file.version };
    }
    const made = await projects.putDocument(space, { title: body.title.trim(), text: text ?? "", mode: body.mode, ...(source !== undefined && { source }) }, asking.caller, ctx);
    ctx.logger.info("channel-web: a user added a document to a project", { user: me.id, project: id, from: source === undefined ? "text" : "file" });
    return json<ChatDocument>(201, chatDocumentOf(made));
  });

  user(`POST ${API}/projects/:id/documents/upload`, async (request, ctx, me) => {
    const params = new URL(request.url).searchParams;
    const title = params.get("title")?.trim() ?? "";
    const mode = params.get("mode") ?? "reference";
    if (title === "" || title.length > DOCUMENT_TITLE_MAX) throw new Refused(400, "invalid_request", `title: 1 to ${DOCUMENT_TITLE_MAX} characters`);
    if (mode !== "core" && mode !== "reference") throw new Refused(400, "invalid_request", "mode is core or reference");
    const { id, projects, space, who: asking } = await at(request, me, ctx);
    // A member before anything is read or converted: a converter costs.
    if ((await projects.roleOf(space, asking.principals, ctx)) === undefined) throw notFound();
    const bytes = await bytesOf(request, MAX_UPLOAD_BYTES);
    const type = mediaTypeOf(request.headers.get("content-type") ?? "") || "application/octet-stream";
    const text = await textFrom(bytes, type, title, ctx);
    const made = await projects.putDocument(space, { title, text, mode }, asking.caller, ctx);
    ctx.logger.info("channel-web: a user added a document to a project", { user: me.id, project: id, from: "upload" });
    return json<ChatDocument>(201, chatDocumentOf(made));
  });

  user(`GET ${API}/projects/:id/documents/:doc`, async (request, ctx, me) => {
    const doc = itemIdOf(request, 6, "document");
    const part = positive(request, "part") ?? 1;
    const version = positive(request, "version");
    const { projects, space, who: asking } = await at(request, me, ctx);
    const read = await projects.read(space, doc, { part, ...(version !== undefined && { version }) }, asking.caller, ctx);
    if (read === undefined) throw notFound("no such document");
    return json<ChatDocumentRead>(200, { ...read, document: chatDocumentOf(read.document) });
  });

  user(`PATCH ${API}/projects/:id/documents/:doc`, async (request, ctx, me) => {
    const doc = itemIdOf(request, 6, "document");
    const body = checked(DocumentUpdateBody, await bodyOf(request, DOCUMENT_BODY));
    const { id, projects, space, who: asking } = await at(request, me, ctx);
    const current = (await projects.documents(space, asking.caller, ctx)).find((each) => each.id === doc);
    if (current === undefined) throw notFound("no such document");
    // Its title or mode only: its text as it is (every part of the version written over).
    let text = body.text;
    if (text === undefined) {
      const parts: string[] = [];
      for (let part = 1; ; part++) {
        const read = await projects.read(space, doc, { part, version: body.ifVersion }, asking.caller, ctx);
        if (read === undefined) throw new Refused(409, "conflict", "the document changed meanwhile: read it again");
        parts.push(read.text);
        if (part >= read.parts) break;
      }
      text = parts.join("");
    }
    const saved = await projects.putDocument(
      space,
      {
        id: doc,
        title: (body.title ?? current.title).trim(),
        text,
        mode: body.mode ?? current.mode,
        ifVersion: body.ifVersion,
        ...(body.text === undefined && current.source !== undefined && { source: current.source }),
      },
      asking.caller,
      ctx,
    );
    ctx.logger.info("channel-web: a user changed a project's document", { user: me.id, project: id, version: saved.version });
    return json<ChatDocument>(200, chatDocumentOf(saved));
  });

  user(`DELETE ${API}/projects/:id/documents/:doc`, async (request, ctx, me) => {
    const doc = itemIdOf(request, 6, "document");
    const { id, projects, space, who: asking } = await at(request, me, ctx);
    if (!(await projects.removeDocument(space, doc, asking.caller, ctx))) throw notFound("no such document");
    ctx.logger.info("channel-web: a user removed a project's document", { user: me.id, project: id });
    return noContent();
  });

  user(`GET ${API}/projects/:id/documents/:doc/versions`, async (request, ctx, me) => {
    const doc = itemIdOf(request, 6, "document");
    const { projects, space, who: asking } = await at(request, me, ctx);
    const versions = await projects.versions(space, { kind: "document", id: doc }, asking.caller, ctx);
    return json<ChatPage<ChatVersion>>(200, { items: versions.map((each) => ({ ...each, by: each.by as ChatAuthor })) });
  });

  // Files.

  /** A file's name from the path (`:name`, URI-encoded); the store checks its shape. */
  const fileNameOf = (request: Request): string => {
    const name = segment(request, 6);
    if (name === "" || name.length > 255) throw notFound("no such file");
    return name;
  };

  user(`GET ${API}/projects/:id/files`, async (request, ctx, me) => {
    const files = filesOf();
    const { space } = await memberAt(request, me, ctx);
    const trashed = new URL(request.url).searchParams.get("trashed") === "1";
    const listed = await files.list(space, { limit: 1000, ...(trashed && { trashed }) }, ctx);
    return json<ChatFiles>(200, { items: listed.files.map(chatFileOf), usage: listed.usage });
  });

  user(`POST ${API}/projects/:id/files`, async (request, ctx, me) => {
    const files = filesOf();
    const params = new URL(request.url).searchParams;
    const name = params.get("name") ?? "";
    const description = params.get("description") ?? "";
    const given = params.get("id");
    if (given !== null && !/^[0-9a-f]{16,64}$/.test(given)) throw new Refused(400, "invalid_request", "id is 16 to 64 lowercase hex digits");
    const { id, space, who: asking } = await memberAt(request, me, ctx);
    const bytes = await bytesOf(request, MAX_UPLOAD_BYTES);
    const type = mediaTypeOf(request.headers.get("content-type") ?? "");
    try {
      const saved = await files.save(space, { name, description, bytes, ...(type !== "" && { type }), ...(given !== null && { id: given }) }, asking.author, ctx);
      ctx.logger.info("channel-web: a user saved a file in a project", { user: me.id, project: id, version: saved.version, bytes: bytes.byteLength });
      return json<ChatSpaceFile>(201, chatFileOf(saved));
    } catch (error) {
      // Past a file's or a space's size: too large, as a body past its bound.
      if ((error as { code?: unknown }).code === "limit") throw new Refused(413, "limit", (error as Error).message);
      throw error;
    }
  });

  user(`GET ${API}/projects/:id/files/:name`, async (request, ctx, me) => {
    const files = filesOf();
    const name = fileNameOf(request);
    const version = positive(request, "version");
    const { space } = await memberAt(request, me, ctx);
    const found = await files.download(space, name, version === undefined ? {} : { version }, ctx);
    if (found === undefined) throw notFound("no such file");
    const type = mediaTypeOf(found.file.type ?? "") || "application/octet-stream";
    return new Response(found.body, {
      headers: {
        // Downloaded, never shown in the page's origin: a file is anyone's upload.
        "content-type": type,
        "content-length": String(found.size),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(found.file.name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, no-store",
      },
    });
  });

  user(`GET ${API}/projects/:id/files/:name/versions`, async (request, ctx, me) => {
    const files = filesOf();
    const name = fileNameOf(request);
    const { space } = await memberAt(request, me, ctx);
    return json<ChatPage<ChatSpaceFile>>(200, { items: (await files.versions(space, name, ctx)).map(chatFileOf) });
  });

  user(`DELETE ${API}/projects/:id/files/:name`, async (request, ctx, me) => {
    const files = filesOf();
    const name = fileNameOf(request);
    const { id, space, who: asking } = await memberAt(request, me, ctx);
    if (!(await files.trash(space, name, asking.author, ctx))) throw notFound("no such file");
    ctx.logger.info("channel-web: a user trashed a project's file", { user: me.id, project: id });
    return noContent();
  });

  user(`POST ${API}/projects/:id/files/:name/restore`, async (request, ctx, me) => {
    const files = filesOf();
    const name = fileNameOf(request);
    const { id, space, who: asking } = await memberAt(request, me, ctx);
    if ((await files.file(space, name, { trashed: true }, ctx))?.trashedAt === undefined) throw notFound("no such file in the trash");
    // Its newest trashing still restorable, from the log: what History's Undo of it does.
    let before: number | undefined;
    for (let page = 0; page < 10; page++) {
      const read = await files.changes(space, { limit: 200, ...(before !== undefined && { before }) }, ctx);
      const trashed = read.items.find((each) => each.item.kind === "file" && each.item.id === name && each.action === "removed" && each.restorable);
      if (trashed !== undefined) {
        const restored = await files.restore(space, trashed.n, asking.author, ctx);
        ctx.logger.info("channel-web: a user restored a project's file", { user: me.id, project: id });
        return json<ChatChange>(200, changeOf("files", restored));
      }
      before = read.next;
      if (before === undefined) break;
    }
    throw notFound("no such file in the trash");
  });

  // Memory.

  user(`GET ${API}/projects/:id/memory`, async (request, ctx, me) => {
    const memory = memoryOf();
    const { space } = await memberAt(request, me, ctx);
    const owner = ownerOf(space);
    const [rules, notes, summaries, proposed] = await Promise.all([
      memory.list(owner, { kinds: ["rule"], status: "active" }, MEMORY_LIST, ctx),
      memory.list(owner, { kinds: ["fact"] }, MEMORY_LIST, ctx),
      memory.list(owner, { kinds: ["summary"] }, MEMORY_LIST, ctx),
      memory.list(owner, { kinds: ["rule"], status: "pending" }, MEMORY_LIST, ctx),
    ]);
    return json<ChatMemory>(200, { rules: rules.map(chatMemoryOf), notes: notes.map(chatMemoryOf), summaries: summaries.map(chatMemoryOf), proposed: proposed.map(chatMemoryOf) });
  });

  /** The id of a new rule (its words') or note (a new one). */
  const newMemoryId = async (kind: "rule" | "note", text: string): Promise<string> => (kind === "rule" ? ruleId(text) : `note-${crypto.randomUUID().replace(/-/g, "")}`);

  user(`POST ${API}/projects/:id/memory`, async (request, ctx, me) => {
    const memory = memoryOf();
    const body = checked(MemoryBody, await bodyOf(request, SMALL_BODY * 2));
    const { id, space, who: asking } = await memberAt(request, me, ctx);
    const owner = ownerOf(space);
    const text = normalized(body.text);
    const memoryId = await newMemoryId(body.kind, text);
    // Active at once: in a project nothing waits (features/projects.md, decision 5).
    await memory.remember(owner, { id: memoryId, kind: body.kind === "rule" ? "rule" : "fact", status: "active", text, createdAt: ctx.clock.now(), by: asking.author }, ctx);
    // The same words as a pending proposal: a member adds it now.
    if (body.kind === "rule") await memory.approve(owner, memoryId, "rule", asking.author, ctx);
    const kept = await memory.get(owner, memoryId, ctx);
    if (kept === undefined) throw notFound("no such memory");
    ctx.logger.info("channel-web: a user added to a project's memory", { user: me.id, project: id, kind: body.kind });
    return json<ChatMemoryItem>(201, chatMemoryOf(kept));
  });

  user(`PATCH ${API}/projects/:id/memory/:item`, async (request, ctx, me) => {
    const memory = memoryOf();
    const itemId = itemIdOf(request, 6, "memory");
    const body = checked(MemoryEditBody, await bodyOf(request, SMALL_BODY * 2));
    const { id, space, who: asking } = await memberAt(request, me, ctx);
    const owner = ownerOf(space);
    const current = await memory.get(owner, itemId, ctx);
    if (current === undefined || (current.kind !== "rule" && current.kind !== "fact")) throw notFound("no such rule or note");
    const text = normalized(body.text);
    if (text === current.text) return json<ChatMemoryItem>(200, chatMemoryOf(current));
    const kind = current.kind === "rule" ? "rule" : "note";
    let next = await newMemoryId(kind, text);
    // A rule's id is its words': new words of the same id (a case changed) are a new note of it.
    if (next === itemId) next = `${itemId}-${crypto.randomUUID().slice(0, 8)}`;
    const replaced = await memory.replace(owner, itemId, { id: next, kind: current.kind, status: current.status, text, createdAt: ctx.clock.now(), by: asking.author }, ctx);
    if (replaced === undefined) throw notFound("no such rule or note");
    ctx.logger.info("channel-web: a user changed a project's memory", { user: me.id, project: id, kind });
    return json<ChatMemoryItem>(200, chatMemoryOf(replaced));
  });

  user(`DELETE ${API}/projects/:id/memory/:item`, async (request, ctx, me) => {
    const memory = memoryOf();
    const itemId = itemIdOf(request, 6, "memory");
    const { id, space, who: asking } = await memberAt(request, me, ctx);
    if (!(await memory.forget(ownerOf(space), itemId, { kinds: ["rule", "fact", "summary"] }, asking.author, ctx))) throw notFound("no such memory");
    ctx.logger.info("channel-web: a user removed from a project's memory", { user: me.id, project: id });
    return noContent();
  });

  user(`POST ${API}/projects/:id/memory/:item/approve`, async (request, ctx, me) => {
    const memory = memoryOf();
    const itemId = itemIdOf(request, 6, "memory");
    const { id, space, who: asking } = await memberAt(request, me, ctx);
    const owner = ownerOf(space);
    if (!(await memory.approve(owner, itemId, "rule", asking.author, ctx))) throw notFound("no such proposal");
    const kept = await memory.get(owner, itemId, ctx);
    if (kept === undefined) throw notFound("no such proposal");
    ctx.logger.info("channel-web: a user added a rule proposed before the project", { user: me.id, project: id });
    return json<ChatMemoryItem>(200, chatMemoryOf(kept));
  });

  // Links.

  user(`GET ${API}/projects/:id/links`, async (request, ctx, me) => {
    const { projects, space, who: asking } = await at(request, me, ctx);
    const links = await projects.links(space, asking.caller, ctx);
    return json<ChatPage<ChatLink>>(200, { items: links.map((each) => ({ ...each, by: each.by as ChatAuthor })) });
  });

  user(`POST ${API}/projects/:id/links`, async (request, ctx, me) => {
    const body = checked(LinkBody, await bodyOf(request, SMALL_BODY));
    const { id, projects, space, who: asking } = await at(request, me, ctx);
    const link = await projects.addLink(space, { url: body.url.trim(), title: body.title.trim(), ...(body.note !== undefined && body.note.trim() !== "" && { note: body.note.trim() }) }, asking.caller, ctx);
    ctx.logger.info("channel-web: a user added a link to a project", { user: me.id, project: id });
    return json<ChatLink>(201, { ...link, by: link.by as ChatAuthor });
  });

  user(`DELETE ${API}/projects/:id/links/:link`, async (request, ctx, me) => {
    const link = itemIdOf(request, 6, "link");
    const { id, projects, space, who: asking } = await at(request, me, ctx);
    if (!(await projects.removeLink(space, link, asking.caller, ctx))) throw notFound("no such link");
    ctx.logger.info("channel-web: a user removed a project's link", { user: me.id, project: id });
    return noContent();
  });

  // History.

  user(`GET ${API}/projects/:id/history`, async (request, ctx, me) => {
    const params = new URL(request.url).searchParams;
    const limit = positive(request, "limit") ?? HISTORY_DEFAULT;
    if (limit > HISTORY_MAX) throw new Refused(400, "invalid_request", `limit is an integer from 1 to ${HISTORY_MAX}`);
    const given = params.get("cursor");
    const cursor = given === null ? {} : parseHistoryCursor(given);
    const { space, who: asking } = await memberAt(request, me, ctx);
    const page = await history(space, asking, limit, cursor, ctx);
    return json<ChatPage<ChatChange>>(200, { items: page.items, ...(page.next !== undefined && { next: encodeHistoryCursor(page.next) }) });
  });

  user(`POST ${API}/projects/:id/history/:log/:n/restore`, async (request, ctx, me) => {
    const log = segment(request, 6);
    const n = Number(segment(request, 7));
    if (!(HISTORY_LOGS as readonly string[]).includes(log) || !Number.isInteger(n) || n < 1) throw notFound("no such change");
    const { id, projects, space, who: asking } = await memberAt(request, me, ctx);
    let restored: Change;
    // The store that holds the entry restores it, by its own rules (the project's record and members: the owner's).
    if (log === "project") restored = await projects.restore(space, n, asking.caller, ctx);
    else if (log === "memory") restored = await memoryOf().restore(ownerOf(space), n, asking.author, ctx);
    else restored = await filesOf().restore(space, n, asking.author, ctx);
    ctx.logger.info("channel-web: a user restored a project's earlier state", { user: me.id, project: id, log, n });
    return json<ChatChange>(200, changeOf(log as Log, restored));
  });

  // Every member's chats.

  user(`GET ${API}/projects/:id/conversations`, async (request, ctx, me) => {
    const page = pageOf(request);
    const { id, projects, space, who: asking } = await at(request, me, ctx);
    if ((await projects.get(space, asking.caller, ctx)) === undefined) throw notFound();
    const [listed, config] = await Promise.all([backend().projectConversations(id, page, ctx), options.chatConfig(ctx)]);
    return json<ChatPage<ChatProjectConversation>>(200, {
      items: listed.items.map((each) => ({ ...shownConversation(each, config), userId: each.userId, mine: each.userId === me.id })),
      ...(listed.next !== undefined && { next: listed.next }),
    });
  });

  user(`GET ${API}/projects/:id/conversations/:chat/transcript`, async (request, ctx, me) => {
    const chatId = segment(request, 6);
    if (!isChatId(chatId)) throw notFound("no such conversation");
    const page = pageOf(request);
    const { id, projects, space, who: asking } = await at(request, me, ctx);
    if ((await projects.get(space, asking.caller, ctx)) === undefined) throw notFound();
    const { userId } = await backend().projectConversation(id, chatId, ctx);
    const [read, { visibility }] = await Promise.all([backend().transcript({ userId, chatId, key: keyOf(userId, chatId) }, page, ctx), options.chatConfig(ctx)]);
    const items = read.items.flatMap((entry) => projectEntry(entry, visibility) ?? []);
    return json<ChatPage<ChatTranscriptEntry>>(200, { items, ...(read.next !== undefined && { next: read.next }) });
  });

  // A chat's notices: what its agents (or its author's commands) added to its project.

  user(`GET ${API}/conversations/:id/notices`, async (request, ctx, me) => {
    const chatId = segment(request, 4);
    if (!isChatId(chatId)) throw notFound("no such conversation");
    const key = keyOf(me.id, chatId);
    const conversation = await backend().conversation({ userId: me.id, chatId, key }, ctx);
    const project = conversation.project;
    if (project === undefined || services.projects() === undefined) return json<ChatNotices>(200, { items: [] });
    const located = await locate(project, ctx).catch((error: unknown) => {
      if (error instanceof Refused && error.status === 404) return undefined;
      throw error;
    });
    if (located === undefined) return json<ChatNotices>(200, { project, items: [] });
    const { projects, space } = located;
    const asking = await who(me, ctx);
    if ((await projects.roleOf(space, asking.principals, ctx)) === undefined) return json<ChatNotices>(200, { project, items: [] });
    const fromHere = (change: Change): boolean => (change.by.kind === "agent" || change.by.kind === "person") && change.by.conversation === key;
    const undone = new Map<Log, Map<number, Change>>();
    const read = await Promise.all(
      logs().map(async (log) => {
        const page = await readLog(log, space, asking, { limit: NOTICES_READ }, ctx);
        undone.set(log, undoneIn(page.items));
        return [log, { page: { items: page.items.filter(fromHere) }, place: undefined }] as const;
      }),
    );
    const items = mergeHistory(new Map(read), NOTICES_MAX).items.map((item) => {
      const by = undone.get(item.log)?.get(item.n);
      return by === undefined ? item : { ...item, undone: { at: by.at, by: by.by as ChatAuthor } };
    });
    return json<ChatNotices>(200, { project, items });
  });

  return {
    features() {
      if (services.projects() === undefined) return undefined;
      return { files: services.files() !== undefined, memory: services.memory() !== undefined, convert: services.convert() !== undefined };
    },

    async starting(me, id, agent, ctx) {
      const { projects, space } = await locate(id, ctx);
      const asking = await who(me, ctx);
      const project = await projects.get(space, asking.caller, ctx);
      if (project === undefined) throw notFound();
      if (project.archivedAt !== undefined) throw new Refused(403, "forbidden", "this project is archived: it is read only");
      if (project.agents.length === 0) return { space, ...(agent !== undefined && { agent }) };
      // The project's agents, among those users may pick (none offered: the project's own choice).
      const names = await offered(ctx);
      const allowed = project.agents.filter((each) => names.length === 0 || names.includes(each));
      const chosen = agent ?? allowed[0];
      if (chosen === undefined || !allowed.includes(chosen)) throw new Refused(400, "invalid_request", "/agent: not an assistant this project allows");
      return { space, agent: chosen };
    },

    async posting(me, conversation, ctx) {
      if (conversation.project === undefined) return;
      const located = await locate(conversation.project, ctx).catch((error: unknown) => {
        if (error instanceof Refused && error.status === 404) return undefined;
        throw error;
      });
      if (located === undefined) throw new Refused(403, "forbidden", "this chat's project is gone: it is read only");
      const asking = await who(me, ctx);
      const project = await located.projects.get(located.space, asking.caller, ctx);
      if (project === undefined) throw new Refused(403, "forbidden", "you are no longer a member of this chat's project");
      if (project.archivedAt !== undefined) throw new Refused(403, "forbidden", "this chat's project is archived: it is read only");
      if (project.agents.length > 0 && (conversation.agent === undefined || !project.agents.includes(conversation.agent))) {
        throw new Refused(403, "forbidden", "this chat's assistant is no longer one its project allows: start a new chat");
      }
    },

    async listing(me, id, ctx) {
      const { projects, space } = await locate(id, ctx);
      if ((await projects.get(space, (await who(me, ctx)).caller, ctx)) === undefined) throw notFound();
    },

    async userRemoved(userId, operator, ctx) {
      const projects = services.projects();
      if (projects === undefined) return;
      const principal: Principal = { channel: CHANNEL, id: userId };
      const caller: Caller = { kind: "operator", id: operator };
      try {
        await migrated(ctx);
        const theirs: Project[] = [];
        for (const archived of [false, true]) {
          let cursor: string | undefined;
          for (let page = 0; page < 10; page++) {
            const read = await projects.list({ archived, limit: 100, ...(cursor !== undefined && { cursor }) }, { kind: "people", principals: [principal] }, ctx);
            theirs.push(...read.items);
            cursor = read.next;
            if (cursor === undefined) break;
          }
        }
        for (const project of theirs) {
          try {
            if (samePrincipal(project.owner, principal)) {
              // The oldest member who counts now, added by hand: the project is theirs; none: archived, kept.
              const members = await projects.members(project.space, { limit: 200 }, caller, ctx);
              const now = ctx.clock.now();
              const heir = members.items
                .filter((each) => each.source === "manual" && !samePrincipal(each.principal, principal) && memberIsCurrent(each, now, STALE_AFTER_MS_DEFAULT))
                .sort((a, b) => a.at - b.at)[0];
              if (heir === undefined) {
                await projects.update(project.space, { archived: true }, caller, ctx);
                continue;
              }
              await projects.transferOwnership(project.space, heir.principal, caller, ctx);
            }
            await projects.removeMember(project.space, principal, caller, ctx);
          } catch (error) {
            ctx.logger.warn("channel-web: a removed user's project could not be handed over; an operator does it", { user: userId, project: project.id, error: error instanceof Error ? error.message : String(error) });
          }
        }
      } catch (error) {
        ctx.logger.warn("channel-web: a removed user's projects could not be read; an operator hands them over", { user: userId, error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

/**
 * `projects`: a project is the record of one space, shared by its people and agents
 * (features/projects.md). Its record, members (one owner), instructions and documents with their
 * versions, links, and the change log of all of them; the space's memory (memory-sql's `memory`) and
 * files (`space.files`) are the project's at once, kept by their own stores with their own logs.
 *
 *   const projects = pikit.use("projects");
 *   const space = await projects.locate(id, ctx);
 *   const project = space === undefined ? undefined : await projects.get(space, { kind: "people", principals }, ctx);
 *
 * **Collaborative** (the operator's decision, 2026-11-17): any member changes the name, description,
 * instructions, documents and links, adds people, and restores any earlier state, active at once; the
 * owner alone archives, removes, transfers ownership, removes other members and sets the agents. Agents
 * add links (and, through their own stores, notes, rules and files); they never write instructions or
 * documents. Safety is transparency: every change is in the log with its author.
 *
 * What every provider guarantees (`createProjectsConformance` in `@pikit/contracts/testing` checks it):
 * - **One space, one project, for good.** `Project.space` is fixed by `create` (`project:<id>` for a new
 *   one; a trusted caller may adopt an existing space, keeping its string) and never changes; a second
 *   project for a taken space is `space_taken`. People never name a space or an id (`forbidden`).
 * - **Every call is checked where the project is**, against the caller's kind and role (`Caller`), in
 *   the project's actor: no route or tool decides alone. A non-member (and a project that does not
 *   exist, or was removed) is `not_found`, the same answer, with nothing read or written. A member asking
 *   for an owner's act is `forbidden`. An agent acts only in its own space (`forbidden` otherwise), reads,
 *   searches and adds links; any other write of an agent is `forbidden`. An operator may do everything; a
 *   component what its call is for (`syncMembers` is components' only, `redact` operators' only).
 * - **Membership**: exactly one owner, always, a manual member. Any member adds people (idempotent); the
 *   owner removes others; anyone leaves, the owner only after `transferOwnership` (`forbidden`). A sourced
 *   member (`source` other than `manual`) is changed only by `syncMembers` of its source, never by hand
 *   (`forbidden`), and counts as a member only while `checkedAt` is within the provider's `staleAfterMs`
 *   (`memberIsCurrent`); a manual member never expires. `roleOf` is that one check (`roleOfMembers`).
 *   A removed member's next call is `not_found`.
 * - **Every change is in the log** (`../change.ts`; item kinds `project`, `member`, `instructions`,
 *   `document`, `link`), with the author `authorOf(caller)`, in the same transaction; `changeLogCases`
 *   holds for it. `restore(n)` by any member, except the changes of kinds in `OWNER_RESTORES` (the
 *   project's own record and its members: the owner's or an operator's); `redact(n)` operators' only.
 * - **Versions**: instructions and each document keep every version (`versions`, `read` with a
 *   version); a write with `ifVersion` behind the current is `conflict`, the newer kept.
 * - **Bounds**: a name of one line, 1 to `PROJECT_NAME_MAX` characters; a description up to
 *   `PROJECT_DESCRIPTION_MAX`; instructions up to `INSTRUCTIONS_MAX`; a document up to `DOCUMENT_MAX`, at
 *   most `PROJECT_DOCUMENTS_MAX` a project and `PROJECT_TEXT_MAX` characters of current text; the core
 *   documents' tokens (`estimateTokens`) within the provider's `coreTokens` (every `Project` says it:
 *   `Project.coreTokens`), `putDocument` refusing a core document past it (`limit`, saying how many are left); at most `PROJECT_LINKS_MAX` links and
 *   `PROJECTS_OWNED_MAX` projects owned by one principal. Past any: `limit`.
 * - **No credentials**: a name, description, instructions, a document's title or text, a link's URL,
 *   title or note with a known credential's shape (`credentialSettingProblem`) is `refused`, never echoed.
 * - **Search stays in its project and never errs on syntax** (FTS5 over the instructions, the documents'
 *   current text in parts of about `SEARCH_PART` characters, and the links: all words, then the phrase,
 *   then any).
 * - **What crosses an actor is checked on arrival** (`parseCaller`, `parseAuthor`): malformed is
 *   `invalid`. Everything is committed before a call resolves; restarts lose nothing.
 * - **Removal**: `remove` leaves a tombstone, gone for everyone but operators, `recover`able by an
 *   operator for `PROJECT_TOMBSTONE_DAYS`, then purged with the space's memory and files.
 *
 * Errors: `ProjectError` (`code`: `not_found`, `forbidden`, `conflict`, `gone`, `space_taken`, `limit`,
 * `refused`, `invalid`).
 *
 * Provider: projects-sql (an index actor `projects:index` and one actor per project,
 * `projects:space:<space>`, over their `storage.sql`). Users: channel-web (the page), projects-context
 * (the agents' section and tools), memory-recall (whether a space has a project, who is a member),
 * projects-sql's own admin routes (the dashboard). One provider: `experimental`.
 *
 * Also here, because the agents' one read path spans three stores: the federated search's result
 * (`ProjectSearchHit`) and the references `project_read` takes (`ProjectItemRef`), which projects-context
 * builds from `projects.search`, memory's `search` and `space.files.search`; and the line every tool that
 * adds to a project ends its result with (`addedToProject`).
 */

import type { AppContext } from "@pikit/core";
import type { Author, Change, ChangePage, ChangePageRequest, Principal } from "./change.ts";
import { ChangeInputError, changeTitle, parsePrincipal, samePrincipal } from "./change.ts";
import { isJsonObject } from "./json.ts";
import type { Page, PageRequest } from "./page.ts";

export type ProjectRole = "owner" | "member";

/**
 * Who asks. Built by the calling component from what it authenticated, never from a page's or a model's
 * words. A type: it crosses actors as JSON.
 * - `people`: every identity the channel authenticated for one person (`principals.of`), the session's
 *   first; `conversation` is the chat a command was typed in.
 * - `operator`: a route behind `admin.auth`.
 * - `component`: trusted code (an import, a membership sync, memory-recall asking whether a space has a
 *   project, projects-sql's own wakeups).
 * - `agent`: an agent's tool: its `space` is `spaceOf(CONVERSATION)`, `conversation` its key, `for` the
 *   person the run answers.
 */
export type Caller =
  | { kind: "people"; principals: Principal[]; conversation?: string }
  | { kind: "operator"; id: string }
  | { kind: "component"; name: string }
  | { kind: "agent"; agent: string; conversation: string; space: string; for?: Principal };

export type Project = {
  /** 32 lowercase hex: public (URLs), never a space. */
  id: string;
  /** Fixed for good. */
  space: string;
  /** One line, 1 to `PROJECT_NAME_MAX` characters. */
  name: string;
  /** 0 to `PROJECT_DESCRIPTION_MAX` characters. */
  description: string;
  /** The agents a chat may be started with in it; `[]`: the channel's choice. The owner's to set. */
  agents: string[];
  owner: Principal;
  /** The caller's role, when people asked. */
  role?: ProjectRole;
  /** How many members (the owner included). */
  members: number;
  archivedAt?: number;
  /** Set only in an operator's answer: removed, recoverable until purged. */
  removedAt?: number;
  createdAt: number;
  updatedAt: number;
  /** Bumped by every change an agent's context shows (record, members, instructions, documents, links). */
  version: number;
  /** The core documents' budget, in estimated tokens (`estimateTokens`): the provider's, what `putDocument` keeps them within. */
  coreTokens: number;
};

/** A member. `source` is `manual` (added by someone; never stale) or the name of the source a component keeps in step (`googlechat:spaces/AAA`). */
export type Member = { principal: Principal; role: ProjectRole; source: string; checkedAt: number; by: Author; at: number };

export type Instructions = { text: string; version: number; by: Author; at: number };

export type DocumentMode = "core" | "reference";

export type ProjectDocument = {
  id: string;
  title: string;
  mode: DocumentMode;
  chars: number;
  /** `estimateTokens(chars)`. */
  tokens: number;
  version: number;
  /** Pinned from a saved file (`space.files`); absent: text given. */
  source?: { file: string; fileVersion: number };
  /** The latest version's author and time. */
  by: Author;
  at: number;
};

export type Link = { id: string; url: string; title: string; note?: string; by: Author; at: number };

/** One version of instructions or a document, as `versions` lists it. */
export type ItemVersion = { version: number; by: Author; at: number; chars: number; title?: string; mode?: DocumentMode };

/** What `create` is given. `id` and `space` are trusted callers' only (an import, an adopted space); people get `project:<new id>`. */
export type NewProject = { id?: string; space?: string; name: string; description?: string; agents?: string[]; owner?: Principal };

/** What `update` changes; `agents` and `archived` are the owner's. */
export type ProjectUpdate = { name?: string; description?: string; agents?: string[]; archived?: boolean };

/** What `putDocument` is given: a new document without `id`, a new version of one with it. */
export type DocumentInput = { id?: string; title: string; text: string; mode: DocumentMode; source?: ProjectDocument["source"]; ifVersion?: number };

/** A part of a document as `read` gives it: `READ_PART` characters a part, from 1. */
export type DocumentRead = { document: ProjectDocument; text: string; part: number; parts: number };

/** What an agent's section shows of projects-sql's part of the project: whole, or `unchanged` for the version the caller holds. */
export type ProjectContext = {
  project: Project;
  /** The first `CONTEXT_MEMBERS` members, the owner first. */
  members: Member[];
  links: Link[];
  instructions?: Instructions;
  core: { document: ProjectDocument; text: string }[];
  reference: ProjectDocument[];
};

/** What `list` asks for: archived projects apart (`archived: true` lists only those). Operators and components list every project. */
export type ProjectListQuery = PageRequest & { archived?: boolean };

/** Membership kept in step by a component: the whole list of a source at `checkedAt`. */
export type MemberSync = { source: string; principals: Principal[]; checkedAt: number };

/** The `projects` capability. Every method's `ctx` is the App's. */
export interface ProjectStore {
  // The directory (projects-sql's index actor).
  /** A new project. People: owner the caller's first principal, no `id` nor `space` (`forbidden`). Trusted callers name the owner. */
  create(input: NewProject, caller: Caller, ctx: AppContext): Promise<Project>;
  /** People: their projects (`role` set); operators and components: every project. Newest change first. */
  list(query: ProjectListQuery, caller: Caller, ctx: AppContext): Promise<Page<Project>>;
  /** The space of project `id` (it never changes, so a Worker may keep it), or `undefined`. Says nothing of who may see it. */
  locate(id: string, ctx: AppContext): Promise<string | undefined>;

  // One project (its actor). Every call names its space and its caller.
  /** The project of `space` as `caller` may see it; `undefined` when none, or not the caller's (never told apart). */
  get(space: string, caller: Caller, ctx: AppContext): Promise<Project | undefined>;
  /** The best role any of `principals` holds now (owner wins; a stale sourced member none), or `undefined`. For trusted components. */
  roleOf(space: string, principals: readonly Principal[], ctx: AppContext): Promise<ProjectRole | undefined>;
  update(space: string, change: ProjectUpdate, caller: Caller, ctx: AppContext): Promise<Project>;
  members(space: string, page: PageRequest, caller: Caller, ctx: AppContext): Promise<Page<Member>>;
  /** Any member adds a manual member; idempotent (a member already: as it is). */
  addMember(space: string, principal: Principal, caller: Caller, ctx: AppContext): Promise<Member>;
  /** Oneself (not the owner), or the owner another; never a sourced member. `false` when not a member. */
  removeMember(space: string, principal: Principal, caller: Caller, ctx: AppContext): Promise<boolean>;
  /** The owner, to a member (made manual); the old owner stays a member. */
  transferOwnership(space: string, principal: Principal, caller: Caller, ctx: AppContext): Promise<Project>;
  /** Components only: `sync.source`'s members are exactly `sync.principals` now, checked at `sync.checkedAt`. */
  syncMembers(space: string, sync: MemberSync, caller: Caller, ctx: AppContext): Promise<void>;
  instructions(space: string, query: { version?: number }, caller: Caller, ctx: AppContext): Promise<Instructions | undefined>;
  /** People and operators; `conflict` when the current version is not `ifVersion` (0: none yet). */
  setInstructions(space: string, input: { text: string; ifVersion: number }, caller: Caller, ctx: AppContext): Promise<Instructions>;
  documents(space: string, caller: Caller, ctx: AppContext): Promise<ProjectDocument[]>;
  /** People and operators. A core document past the budget is `limit`; `ifVersion` behind is `conflict`. */
  putDocument(space: string, input: DocumentInput, caller: Caller, ctx: AppContext): Promise<ProjectDocument>;
  removeDocument(space: string, id: string, caller: Caller, ctx: AppContext): Promise<boolean>;
  read(space: string, id: string, query: { part: number; version?: number }, caller: Caller, ctx: AppContext): Promise<DocumentRead | undefined>;
  versions(space: string, item: { kind: "instructions" } | { kind: "document"; id: string }, caller: Caller, ctx: AppContext): Promise<ItemVersion[]>;
  /** The instructions, documents and links matching `query`, the best `limit` first, typed with their provenance. */
  search(space: string, query: string, limit: number, caller: Caller, ctx: AppContext): Promise<ProjectSearchHit[]>;
  links(space: string, caller: Caller, ctx: AppContext): Promise<Link[]>;
  /** People, operators and agents; idempotent by URL (the link kept first is answered). */
  addLink(space: string, link: { url: string; title: string; note?: string }, caller: Caller, ctx: AppContext): Promise<Link>;
  /** People and operators. */
  removeLink(space: string, id: string, caller: Caller, ctx: AppContext): Promise<boolean>;
  /** The section's part; `unchanged` when `known` is the current `Project.version`; `undefined` when the space has no project. */
  context(space: string, known: number | undefined, caller: Caller, ctx: AppContext): Promise<ProjectContext | "unchanged" | undefined>;
  changes(space: string, page: ChangePageRequest, caller: Caller, ctx: AppContext): Promise<ChangePage>;
  /** Any member, except `OWNER_RESTORES` kinds (the owner's); `gone` past retention or redacted. */
  restore(space: string, n: number, caller: Caller, ctx: AppContext): Promise<Change>;
  /** Operators only. */
  redact(space: string, n: number, caller: Caller, ctx: AppContext): Promise<void>;
  /** The owner or an operator: a tombstone, purged after `PROJECT_TOMBSTONE_DAYS` with the space's memory and files. */
  remove(space: string, caller: Caller, ctx: AppContext): Promise<void>;
  /** Operators only, before the purge: the project back as it was. */
  recover(space: string, caller: Caller, ctx: AppContext): Promise<Project>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    projects: ProjectStore;
  }
}

/** Why a call rejected: see the header. */
export type ProjectErrorCode = "not_found" | "forbidden" | "conflict" | "gone" | "space_taken" | "limit" | "refused" | "invalid";

export class ProjectError extends Error {
  readonly code: ProjectErrorCode;
  constructor(code: ProjectErrorCode, message: string) {
    super(message);
    this.name = "ProjectError";
    this.code = code;
  }
}

export const PROJECT_NAME_MAX = 60;
export const PROJECT_DESCRIPTION_MAX = 500;
export const INSTRUCTIONS_MAX = 8_000;
export const DOCUMENT_TITLE_MAX = 120;
export const DOCUMENT_MAX = 500_000;
export const PROJECT_DOCUMENTS_MAX = 200;
/** Characters of current text in a project; with earlier versions, `PROJECT_TEXT_WITH_VERSIONS_MAX` (the oldest versions dropped past it). */
export const PROJECT_TEXT_MAX = 5_000_000;
export const PROJECT_TEXT_WITH_VERSIONS_MAX = 20_000_000;
export const PROJECT_LINKS_MAX = 200;
export const LINK_URL_MAX = 2_048;
export const LINK_NOTE_MAX = 500;
export const PROJECTS_OWNED_MAX = 100;
/** The core documents' budget by default, in estimated tokens (projects-sql's `coreTokens`). */
export const CORE_TOKENS_DEFAULT = 8_000;
/** A sourced member counts while checked within this, by default (projects-sql's `staleAfterMs`). */
export const STALE_AFTER_MS_DEFAULT = 30 * 60_000;
export const PROJECT_TOMBSTONE_DAYS = 30;
/** Characters a `read` part holds. */
export const READ_PART = 20_000;
/** About how many characters a search part holds. */
export const SEARCH_PART = 1_500;
/** The members `context` gives. */
export const CONTEXT_MEMBERS = 30;
/** The most hits one search answers. */
export const SEARCH_MAX = 50;
/** The prefix of the spaces new projects get. */
export const PROJECT_SPACE_PREFIX = "project:";
/** The change kinds whose restore is the owner's (or an operator's). */
export const OWNER_RESTORES: readonly string[] = ["project", "member"];

const PROJECT_ID = /^[0-9a-f]{32}$/;

/** Whether `id` is a project's id: 32 lowercase hex. */
export const isProjectId = (id: unknown): id is string => typeof id === "string" && PROJECT_ID.test(id);

/** The space of a new project `id`: `project:<id>`. */
export const projectSpace = (id: string): string => `${PROJECT_SPACE_PREFIX}${id}`;

/** Estimated tokens of `chars` characters: `ceil(chars / 4)`. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

/** Why `name` cannot name a project, or `undefined`. */
export function projectNameProblem(name: string): string | undefined {
  if (name.trim() === "" || name.length > PROJECT_NAME_MAX) return `a project's name is 1 to ${PROJECT_NAME_MAX} characters`;
  if (/[\r\n]/.test(name)) return "a project's name is one line";
  return undefined;
}

/** Why `url` cannot be a link, or `undefined`: an absolute `http` or `https` URL of at most `LINK_URL_MAX` characters, with no user or password. */
export function linkUrlProblem(url: string): string | undefined {
  if (url.length === 0 || url.length > LINK_URL_MAX) return `a link is 1 to ${LINK_URL_MAX} characters`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "a link is an absolute URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "a link is an http or https URL";
  if (parsed.username !== "" || parsed.password !== "") return "a link carries no user or password";
  return undefined;
}

/** The author a change made by `caller` records: a person is the session's first principal. */
export function authorOf(caller: Caller): Author {
  switch (caller.kind) {
    case "people": {
      const [principal] = caller.principals;
      if (principal === undefined) throw new ProjectError("invalid", "a people caller has at least one principal");
      return { kind: "person", principal, ...(caller.conversation !== undefined && { conversation: caller.conversation }) };
    }
    case "agent":
      return { kind: "agent", agent: caller.agent, conversation: caller.conversation, ...(caller.for !== undefined && { for: caller.for }) };
    case "operator":
      return { kind: "operator", id: caller.id };
    case "component":
      return { kind: "component", name: caller.name };
  }
}

/** A caller that crossed as JSON, checked and copied: what the project's actor runs on arrival. Throws `ProjectError` `invalid`. */
export function parseCaller(value: unknown): Caller {
  const text = (field: unknown, what: string): string => {
    if (typeof field !== "string" || field.trim() === "" || field.length > 1024) throw new ProjectError("invalid", `${what} is a non-empty string of at most 1024 characters`);
    return field;
  };
  try {
    if (!isJsonObject(value)) throw new ProjectError("invalid", "a caller is a JSON object");
    switch (value.kind) {
      case "people": {
        if (!Array.isArray(value.principals) || value.principals.length === 0 || value.principals.length > 20) throw new ProjectError("invalid", "caller.principals is a list of 1 to 20 principals");
        const caller: Caller = { kind: "people", principals: value.principals.map((each) => parsePrincipal(each, "caller.principals[]")) };
        if (value.conversation !== undefined && value.conversation !== null) caller.conversation = text(value.conversation, "caller.conversation");
        return caller;
      }
      case "agent": {
        const caller: Caller = { kind: "agent", agent: text(value.agent, "caller.agent"), conversation: text(value.conversation, "caller.conversation"), space: text(value.space, "caller.space") };
        if (value.for !== undefined && value.for !== null) caller.for = parsePrincipal(value.for, "caller.for");
        return caller;
      }
      case "operator":
        return { kind: "operator", id: text(value.id, "caller.id") };
      case "component":
        return { kind: "component", name: text(value.name, "caller.name") };
      default:
        throw new ProjectError("invalid", 'caller.kind is "people", "agent", "operator" or "component"');
    }
  } catch (error) {
    if (error instanceof ChangeInputError) throw new ProjectError("invalid", error.message);
    throw error;
  }
}

/** Whether `member` counts now: a manual member always; a sourced one while checked within `staleAfterMs`. */
export const memberIsCurrent = (member: Pick<Member, "source" | "checkedAt">, now: number, staleAfterMs: number): boolean =>
  member.source === "manual" || now - member.checkedAt <= staleAfterMs;

/** The best role any of `principals` holds among `members` now (the owner's wins), or `undefined`: `roleOf`'s one rule. */
export function roleOfMembers(members: readonly Pick<Member, "principal" | "role" | "source" | "checkedAt">[], principals: readonly Principal[], now: number, staleAfterMs: number): ProjectRole | undefined {
  let role: ProjectRole | undefined;
  for (const member of members) {
    if (!principals.some((principal) => samePrincipal(principal, member.principal)) || !memberIsCurrent(member, now, staleAfterMs)) continue;
    if (member.role === "owner") return "owner";
    role = "member";
  }
  return role;
}

/** Whether restoring `change` is the owner's (or an operator's) rather than any member's. */
export const restoreNeedsOwner = (change: Pick<Change, "item">): boolean => OWNER_RESTORES.includes(change.item.kind);

// The agents' one read path: the federated search and the items it finds.

/**
 * What the agents of a project find and read, whichever store keeps it: projects-sql (`instructions`,
 * `document`, `link`), memory (`rule`, `note` = a fact, `summary`), `space.files` (`file`).
 */
export type ProjectItemKind = "instructions" | "document" | "link" | "rule" | "note" | "summary" | "file";

export const PROJECT_ITEM_KINDS: readonly ProjectItemKind[] = ["instructions", "document", "link", "rule", "note", "summary", "file"];

/** One item of a project, as a hit names it and `project_read` takes it: `<kind>:<id>` (`instructions` alone, its only one). */
export type ProjectItemRef = { kind: ProjectItemKind; id: string };

/** `ref` as one string: `document:d-91c2`, `file:brief.pdf`, `instructions`. */
export function formatItemRef(ref: ProjectItemRef): string {
  return ref.kind === "instructions" ? "instructions" : `${ref.kind}:${ref.id}`;
}

/** A string `formatItemRef` made, or `undefined` for anything else. The id is everything after the first `:` (a file's name may hold `:`). */
export function parseItemRef(text: string): ProjectItemRef | undefined {
  const trimmed = text.trim();
  if (trimmed === "instructions") return { kind: "instructions", id: "" };
  const at = trimmed.indexOf(":");
  if (at <= 0) return undefined;
  const kind = trimmed.slice(0, at) as ProjectItemKind;
  const id = trimmed.slice(at + 1);
  if (!PROJECT_ITEM_KINDS.includes(kind) || kind === "instructions" || id === "" || id.length > 1024) return undefined;
  return { kind, id };
}

/**
 * One result of `project_search`, typed with its provenance, from any of the three stores. `ref` is
 * what `project_read` takes. Built by each store's search (projects-sql's directly; memory's and
 * `space.files`' mapped by projects-context).
 */
export type ProjectSearchHit = {
  ref: string;
  kind: ProjectItemKind;
  /** One line, at most `CHANGE_TITLE_MAX` characters: a document's or file's title, a link's, a note's first words. */
  title: string;
  /** The words around the match, the matched words in `[` `]`. */
  snippet: string;
  /** Who wrote the version found (its source conversation is the author's); absent: kept before authors were recorded. */
  by?: Author;
  version?: number;
  /** The `read` part (documents) or text part (files) the match is in. */
  part?: number;
  /** When the version found was written. */
  at: number;
};

/** Merges each store's hits (each already best first) into one list of at most `limit`: one from each in turn, in the order given, each `ref` once. */
export function mergeSearchHits(lists: readonly (readonly ProjectSearchHit[])[], limit: number): ProjectSearchHit[] {
  const merged: ProjectSearchHit[] = [];
  const seen = new Set<string>();
  for (let index = 0; merged.length < limit && lists.some((list) => index < list.length); index++) {
    for (const list of lists) {
      const hit = list[index];
      if (hit === undefined || seen.has(hit.ref)) continue;
      seen.add(hit.ref);
      merged.push(hit);
      if (merged.length === limit) break;
    }
  }
  return merged;
}

/** The line every tool that adds to a project ends its result with, for the agent to say in its answer. */
export const addedToProject = (title: string): string => `Added to the project: ${changeTitle(title)}`;

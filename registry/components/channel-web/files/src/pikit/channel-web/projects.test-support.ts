/**
 * Doubles of the capabilities channel-web's project routes use, built on their contracts
 * (`@pikit/contracts`' `projects`, `space.files`, `principals`, `document.convert`; memory-sql's
 * `memory`): in memory, with the rules a provider keeps that the routes rely on (a non-member's call
 * `not_found`, an owner's act by a member `forbidden`, versions and `conflict`, one log entry per change
 * with its author, restore of the state before an entry). They are doubles, not providers: the stores'
 * own suites prove the providers (projects-sql, tool-space-files, memory-sql). Each records the methods
 * called (`calls`), so a test sees that nothing was read or written for a non-member.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import {
  ActorCallError,
  type Author,
  authorOf,
  type Caller,
  type Change,
  type ChangePage,
  changeTitle,
  ConvertError,
  CORE_TOKENS_DEFAULT,
  type DocumentConverter,
  estimateTokens,
  type Instructions,
  type Link,
  linkUrlProblem,
  type ListedSpaceFile,
  type Member,
  mediaTypeOf,
  OWNER_RESTORES,
  type Principal,
  type Principals,
  type Project,
  type ProjectDocument,
  ProjectError,
  projectNameProblem,
  projectSpace,
  type ProjectStore,
  READ_PART,
  roleOfMembers,
  type SpaceFile,
  SpaceFilesError,
  type SpaceFiles,
  STALE_AFTER_MS_DEFAULT,
  samePrincipal,
  textOf,
} from "@pikit/contracts";
import { audienceStage } from "@pikit/contracts";
import type { Memory, MemoryFilter, MemoryOwner, MemoryStore, NewMemory } from "./contract.ts";

type Entry = Change & { before?: unknown; after?: unknown };

/** A log with the state before each entry, as a store keeps one. */
class Log {
  readonly entries: Entry[] = [];
  add(at: number, by: Author, action: Change["action"], item: Change["item"], extra: { before?: unknown; after?: unknown; version?: number; restores?: number } = {}): Change {
    const entry: Entry = {
      n: this.entries.length + 1,
      at,
      by,
      action,
      item: { ...item, title: changeTitle(item.title) },
      ...(extra.version !== undefined && { version: extra.version }),
      ...(extra.restores !== undefined && { restores: extra.restores }),
      restorable: true,
      before: extra.before,
      after: extra.after,
    };
    this.entries.push(entry);
    return this.public(entry);
  }
  public(entry: Entry): Change {
    const { before: _b, after: _a, ...change } = entry;
    return structuredClone(change);
  }
  page(before: number | undefined, limit: number): ChangePage {
    const shown = this.entries.filter((each) => before === undefined || each.n < before).reverse();
    const items = shown.slice(0, limit).map((each) => this.public(each));
    const last = items.at(-1);
    return { items, ...(shown.length > limit && last !== undefined && { next: last.n }) };
  }
  get(n: number): Entry {
    const found = this.entries[n - 1];
    if (found === undefined) throw new ProjectError("not_found", "no such change");
    if (!found.restorable) throw new ProjectError("gone", "that change can no longer be undone");
    return found;
  }
}

type DocVersion = { title: string; text: string; mode: "core" | "reference"; source?: ProjectDocument["source"]; by: Author; at: number; version: number };
type ProjectRecord = {
  project: Omit<Project, "role" | "members">;
  members: Member[];
  instructions: Instructions[];
  documents: Map<string, { versions: DocVersion[]; removed: boolean }>;
  links: Link[];
  log: Log;
  removed: boolean;
};

const copy = <T>(value: T): T => structuredClone(value);

/** `projects`, in memory: the rules of `projects.ts` the routes rely on. */
export class MemoryProjects implements ProjectStore {
  readonly calls: string[] = [];
  spaces = new Map<string, ProjectRecord>();
  readonly ids = new Map<string, string>();
  /** The next call of `method` rejects with this (an unavailable store, an `invalid`). */
  failNext: { method: string; error: Error } | undefined;
  constructor(
    readonly now: () => number = () => Date.now(),
    readonly coreTokens = CORE_TOKENS_DEFAULT,
  ) {}

  private record(space: string): ProjectRecord | undefined {
    const found = this.spaces.get(space);
    return found === undefined || found.removed ? undefined : found;
  }
  private enter(method: string): void {
    this.calls.push(method);
    const failing = this.failNext;
    if (failing !== undefined && failing.method === method) {
      this.failNext = undefined;
      throw failing.error;
    }
  }
  private role(record: ProjectRecord, caller: Caller): "owner" | "member" | "trusted" | undefined {
    if (caller.kind === "operator" || caller.kind === "component") return "trusted";
    if (caller.kind === "agent") return caller.space === record.project.space ? "member" : undefined;
    return roleOfMembers(record.members, caller.principals, this.now(), STALE_AFTER_MS_DEFAULT);
  }
  /** The project at `space` for `caller` (people: a member; `owner`: the owner's act), else the store's refusal. */
  private open(space: string, caller: Caller, need: "member" | "owner" | "people" = "member"): ProjectRecord {
    const record = this.record(space);
    const role = record === undefined ? undefined : this.role(record, caller);
    if (record === undefined || role === undefined) throw new ProjectError("not_found", "no such project");
    if (caller.kind === "agent" && need !== "member") throw new ProjectError("forbidden", "agents do not write this");
    if (need === "owner" && role === "member") throw new ProjectError("forbidden", "the owner's act");
    return record;
  }
  private shown(record: ProjectRecord, caller: Caller): Project {
    const role = this.role(record, caller);
    return { ...copy(record.project), members: record.members.length, ...((role === "owner" || role === "member") && caller.kind === "people" && { role }) };
  }
  private bump(record: ProjectRecord): void {
    record.project.version++;
    record.project.updatedAt = this.now();
  }

  async create(input: Parameters<ProjectStore["create"]>[0], caller: Caller, _ctx: AppContext): Promise<Project> {
    this.enter("create");
    if (caller.kind === "people" && (input.id !== undefined || input.space !== undefined)) throw new ProjectError("forbidden", "people name no space");
    if (caller.kind === "agent") throw new ProjectError("forbidden", "agents make no project");
    const problem = projectNameProblem(input.name);
    if (problem !== undefined) throw new ProjectError("invalid", problem);
    const id = input.id ?? crypto.randomUUID().replace(/-/g, "");
    const space = input.space ?? projectSpace(id);
    if (this.spaces.has(space)) throw new ProjectError("space_taken", "that space has a project");
    const owner = caller.kind === "people" ? (caller.principals[0] as Principal) : input.owner;
    if (owner === undefined) throw new ProjectError("invalid", "an owner");
    const owned = [...this.spaces.values()].filter((each) => !each.removed && samePrincipal(each.project.owner, owner)).length;
    if (owned >= 100) throw new ProjectError("limit", "at most 100 projects owned");
    const at = this.now();
    const by = authorOf(caller);
    const record: ProjectRecord = {
      project: { id, space, name: input.name, description: input.description ?? "", agents: [...(input.agents ?? [])], owner, createdAt: at, updatedAt: at, version: 1, coreTokens: this.coreTokens },
      members: [{ principal: owner, role: "owner", source: "manual", checkedAt: at, by, at }],
      instructions: [],
      documents: new Map(),
      links: [],
      log: new Log(),
      removed: false,
    };
    record.log.add(at, by, "added", { kind: "project", id, title: input.name });
    this.spaces.set(space, record);
    this.ids.set(id, space);
    return this.shown(record, caller);
  }

  async list(query: Parameters<ProjectStore["list"]>[0], caller: Caller): Promise<{ items: Project[]; next?: string }> {
    this.enter("list");
    const all = [...this.spaces.values()].filter((each) => !each.removed && (query.archived === true) === (each.project.archivedAt !== undefined));
    const mine = caller.kind === "people" ? all.filter((each) => this.role(each, caller) !== undefined) : all;
    return { items: mine.sort((a, b) => b.project.updatedAt - a.project.updatedAt).map((each) => this.shown(each, caller)) };
  }

  async locate(id: string): Promise<string | undefined> {
    this.enter("locate");
    return this.ids.get(id);
  }

  async get(space: string, caller: Caller): Promise<Project | undefined> {
    this.enter("get");
    const record = this.record(space);
    if (record === undefined || this.role(record, caller) === undefined) return undefined;
    return this.shown(record, caller);
  }

  /**
   * The spaces `principals` are current members of (only `space` when given), each with their role: what
   * projects-sql's stage of `conversation.audience` answers (`audienceStage("projects", ...)`), so the
   * directory lists a project's chats to its members. Not one of the store's calls (`calls`).
   */
  grants(principals: readonly Principal[], space: string | undefined): { space: string; role: "owner" | "member" }[] {
    return [...this.spaces.values()].flatMap((record) => {
      if (record.removed || (space !== undefined && record.project.space !== space)) return [];
      const role = roleOfMembers(record.members, principals, this.now(), STALE_AFTER_MS_DEFAULT);
      return role === undefined ? [] : [{ space: record.project.space, role }];
    });
  }

  async roleOf(space: string, principals: readonly Principal[]): Promise<"owner" | "member" | undefined> {
    this.enter("roleOf");
    const record = this.record(space);
    return record === undefined ? undefined : roleOfMembers(record.members, principals, this.now(), STALE_AFTER_MS_DEFAULT);
  }

  async update(space: string, change: Parameters<ProjectStore["update"]>[1], caller: Caller): Promise<Project> {
    this.enter("update");
    const owners = change.agents !== undefined || change.archived !== undefined;
    const record = this.open(space, caller, owners ? "owner" : "people");
    if (change.name !== undefined) {
      const problem = projectNameProblem(change.name);
      if (problem !== undefined) throw new ProjectError("invalid", problem);
    }
    const before = copy(record.project);
    if (change.name !== undefined) record.project.name = change.name;
    if (change.description !== undefined) record.project.description = change.description;
    if (change.agents !== undefined) record.project.agents = [...change.agents];
    if (change.archived === true) record.project.archivedAt = this.now();
    if (change.archived === false) delete record.project.archivedAt;
    this.bump(record);
    record.log.add(this.now(), authorOf(caller), "changed", { kind: "project", id: record.project.id, title: record.project.name }, { before });
    return this.shown(record, caller);
  }

  async members(space: string, _page: unknown, caller: Caller): Promise<{ items: Member[] }> {
    this.enter("members");
    return { items: copy(this.open(space, caller).members) };
  }

  async addMember(space: string, principal: Principal, caller: Caller): Promise<Member> {
    this.enter("addMember");
    const record = this.open(space, caller, "people");
    const found = record.members.find((each) => samePrincipal(each.principal, principal));
    if (found !== undefined) return copy(found);
    const at = this.now();
    const member: Member = { principal, role: "member", source: "manual", checkedAt: at, by: authorOf(caller), at };
    record.members.push(member);
    this.bump(record);
    record.log.add(at, authorOf(caller), "added", { kind: "member", id: `${principal.channel}:${principal.id}`, title: principal.name ?? principal.id }, { after: member });
    return copy(member);
  }

  async removeMember(space: string, principal: Principal, caller: Caller): Promise<boolean> {
    this.enter("removeMember");
    const record = this.open(space, caller, "people");
    const self = caller.kind === "people" && caller.principals.some((each) => samePrincipal(each, principal));
    const role = this.role(record, caller);
    if (!self && role === "member") throw new ProjectError("forbidden", "the owner removes others");
    const at = record.members.findIndex((each) => samePrincipal(each.principal, principal));
    if (at === -1) return false;
    const member = record.members[at] as Member;
    if (member.role === "owner") throw new ProjectError("forbidden", "the owner leaves after a transfer");
    if (member.source !== "manual") throw new ProjectError("forbidden", "a sourced member follows its source");
    record.members.splice(at, 1);
    this.bump(record);
    record.log.add(this.now(), authorOf(caller), "removed", { kind: "member", id: `${principal.channel}:${principal.id}`, title: principal.name ?? principal.id }, { before: member });
    return true;
  }

  async transferOwnership(space: string, principal: Principal, caller: Caller): Promise<Project> {
    this.enter("transferOwnership");
    const record = this.open(space, caller, "owner");
    const heir = record.members.find((each) => samePrincipal(each.principal, principal));
    if (heir === undefined) throw new ProjectError("not_found", "not a member");
    for (const member of record.members) member.role = member === heir ? "owner" : "member";
    heir.source = "manual";
    record.project.owner = heir.principal;
    this.bump(record);
    record.log.add(this.now(), authorOf(caller), "changed", { kind: "project", id: record.project.id, title: record.project.name });
    return this.shown(record, caller);
  }

  async syncMembers(): Promise<void> {
    this.enter("syncMembers");
    throw new ProjectError("forbidden", "components only (not doubled)");
  }

  async instructions(space: string, query: { version?: number }, caller: Caller): Promise<Instructions | undefined> {
    this.enter("instructions");
    const record = this.open(space, caller);
    return copy(query.version === undefined ? record.instructions.at(-1) : record.instructions.find((each) => each.version === query.version));
  }

  async setInstructions(space: string, input: { text: string; ifVersion: number }, caller: Caller): Promise<Instructions> {
    this.enter("setInstructions");
    const record = this.open(space, caller, "people");
    const current = record.instructions.at(-1);
    if ((current?.version ?? 0) !== input.ifVersion) throw new ProjectError("conflict", "the instructions changed meanwhile");
    if (input.text.length > 8_000) throw new ProjectError("limit", "instructions are at most 8000 characters");
    if (/sk-[A-Za-z0-9]{20,}/.test(input.text)) throw new ProjectError("refused", "that looks like a credential");
    const saved: Instructions = { text: input.text, version: (current?.version ?? 0) + 1, by: authorOf(caller), at: this.now() };
    record.instructions.push(saved);
    this.bump(record);
    record.log.add(saved.at, saved.by, current === undefined ? "added" : "changed", { kind: "instructions", id: "instructions", title: "Instructions" }, { version: saved.version, before: current });
    return copy(saved);
  }

  private document(id: string, versions: DocVersion[]): ProjectDocument {
    const last = versions.at(-1) as DocVersion;
    return { id, title: last.title, mode: last.mode, chars: last.text.length, tokens: estimateTokens(last.text.length), version: last.version, ...(last.source !== undefined && { source: last.source }), by: last.by, at: last.at };
  }

  async documents(space: string, caller: Caller): Promise<ProjectDocument[]> {
    this.enter("documents");
    const record = this.open(space, caller);
    return [...record.documents].filter(([, doc]) => !doc.removed).map(([id, doc]) => this.document(id, doc.versions));
  }

  async putDocument(space: string, input: Parameters<ProjectStore["putDocument"]>[1], caller: Caller): Promise<ProjectDocument> {
    this.enter("putDocument");
    const record = this.open(space, caller, "people");
    const id = input.id ?? `d-${crypto.randomUUID().slice(0, 8)}`;
    const doc = record.documents.get(id);
    if (input.id !== undefined && (doc === undefined || doc.removed)) throw new ProjectError("not_found", "no such document");
    const current = doc?.versions.at(-1);
    if (input.ifVersion !== undefined && current?.version !== input.ifVersion) throw new ProjectError("conflict", "the document changed meanwhile");
    if (/sk-[A-Za-z0-9]{20,}/.test(input.text)) throw new ProjectError("refused", "that looks like a credential");
    if (input.mode === "core") {
      const used = [...record.documents].filter(([other, each]) => other !== id && !each.removed && each.versions.at(-1)?.mode === "core").reduce((sum, [, each]) => sum + estimateTokens((each.versions.at(-1) as DocVersion).text.length), 0);
      const left = this.coreTokens - used;
      if (estimateTokens(input.text.length) > left) throw new ProjectError("limit", `the core documents' budget has ${left} tokens left`);
    }
    const version: DocVersion = { title: input.title, text: input.text, mode: input.mode, ...(input.source !== undefined && { source: input.source }), by: authorOf(caller), at: this.now(), version: (current?.version ?? 0) + 1 };
    if (doc === undefined) record.documents.set(id, { versions: [version], removed: false });
    else doc.versions.push(version);
    this.bump(record);
    record.log.add(version.at, version.by, current === undefined ? "added" : "changed", { kind: "document", id, title: input.title }, { version: version.version, before: current });
    return this.document(id, record.documents.get(id)?.versions as DocVersion[]);
  }

  async removeDocument(space: string, id: string, caller: Caller): Promise<boolean> {
    this.enter("removeDocument");
    const record = this.open(space, caller, "people");
    const doc = record.documents.get(id);
    if (doc === undefined || doc.removed) return false;
    doc.removed = true;
    this.bump(record);
    record.log.add(this.now(), authorOf(caller), "removed", { kind: "document", id, title: (doc.versions.at(-1) as DocVersion).title });
    return true;
  }

  async read(space: string, id: string, query: { part: number; version?: number }, caller: Caller) {
    this.enter("read");
    const record = this.open(space, caller);
    const doc = record.documents.get(id);
    if (doc === undefined || doc.removed) return undefined;
    const version = query.version === undefined ? doc.versions.at(-1) : doc.versions.find((each) => each.version === query.version);
    if (version === undefined) return undefined;
    const parts = Math.max(1, Math.ceil(version.text.length / READ_PART));
    if (query.part > parts) return undefined;
    return { document: this.document(id, doc.versions), text: version.text.slice((query.part - 1) * READ_PART, query.part * READ_PART), part: query.part, parts };
  }

  async versions(space: string, item: { kind: "instructions" } | { kind: "document"; id: string }, caller: Caller) {
    this.enter("versions");
    const record = this.open(space, caller);
    if (item.kind === "instructions") return record.instructions.map((each) => ({ version: each.version, by: each.by, at: each.at, chars: each.text.length }));
    const doc = record.documents.get(item.id);
    if (doc === undefined) throw new ProjectError("not_found", "no such document");
    return doc.versions.map((each) => ({ version: each.version, by: each.by, at: each.at, chars: each.text.length, title: each.title, mode: each.mode }));
  }

  async search(): Promise<[]> {
    this.enter("search");
    return [];
  }

  async links(space: string, caller: Caller): Promise<Link[]> {
    this.enter("links");
    return copy(this.open(space, caller).links);
  }

  async addLink(space: string, link: { url: string; title: string; note?: string }, caller: Caller): Promise<Link> {
    this.enter("addLink");
    const record = this.open(space, caller);
    const problem = linkUrlProblem(link.url);
    if (problem !== undefined) throw new ProjectError("invalid", problem);
    const found = record.links.find((each) => each.url === link.url);
    if (found !== undefined) return copy(found);
    const kept: Link = { id: `l-${crypto.randomUUID().slice(0, 8)}`, ...link, by: authorOf(caller), at: this.now() };
    record.links.push(kept);
    this.bump(record);
    record.log.add(kept.at, kept.by, "added", { kind: "link", id: kept.id, title: kept.title });
    return copy(kept);
  }

  async removeLink(space: string, id: string, caller: Caller): Promise<boolean> {
    this.enter("removeLink");
    const record = this.open(space, caller, "people");
    const at = record.links.findIndex((each) => each.id === id);
    if (at === -1) return false;
    const [link] = record.links.splice(at, 1);
    this.bump(record);
    record.log.add(this.now(), authorOf(caller), "removed", { kind: "link", id, title: (link as Link).title }, { before: link });
    return true;
  }

  async context(): Promise<undefined> {
    this.enter("context");
    return undefined;
  }

  async changes(space: string, page: { before?: number; limit: number }, caller: Caller): Promise<ChangePage> {
    this.enter("changes");
    return this.open(space, caller).log.page(page.before, page.limit);
  }

  async restore(space: string, n: number, caller: Caller): Promise<Change> {
    this.enter("restore");
    const record = this.open(space, caller, "people");
    const entry = record.log.get(n);
    if (OWNER_RESTORES.includes(entry.item.kind) && this.role(record, caller) === "member") throw new ProjectError("forbidden", "the owner's to restore");
    const by = authorOf(caller);
    const at = this.now();
    if (entry.item.kind === "document") {
      const doc = record.documents.get(entry.item.id);
      if (doc === undefined) throw new ProjectError("gone", "no such document");
      if (entry.action === "removed") doc.removed = false;
      else if (entry.before === undefined) doc.removed = true;
      else doc.versions.push({ ...(entry.before as DocVersion), version: (doc.versions.at(-1)?.version ?? 0) + 1 });
    } else if (entry.item.kind === "instructions") {
      const before = entry.before as Instructions | undefined;
      const last = record.instructions.at(-1);
      record.instructions.push({ text: before?.text ?? "", version: (last?.version ?? 0) + 1, by: before?.by ?? by, at });
    } else if (entry.item.kind === "link") {
      if (entry.action === "removed") record.links.push(entry.before as Link);
      else record.links = record.links.filter((each) => each.id !== entry.item.id);
    } else if (entry.item.kind === "member") {
      if (entry.action === "removed") record.members.push(entry.before as Member);
      else record.members = record.members.filter((each) => `${each.principal.channel}:${each.principal.id}` !== entry.item.id || each.role === "owner");
    } else if (entry.item.kind === "project" && entry.before !== undefined) {
      record.project = { ...(entry.before as ProjectRecord["project"]), version: record.project.version };
    }
    this.bump(record);
    return record.log.add(at, by, "restored", entry.item, { restores: n });
  }

  async redact(_space: string, _n: number, caller: Caller): Promise<void> {
    this.enter("redact");
    if (caller.kind !== "operator") throw new ProjectError("forbidden", "operators only");
  }

  async remove(space: string, caller: Caller): Promise<void> {
    this.enter("remove");
    const record = this.open(space, caller, "owner");
    record.removed = true;
  }

  async recover(): Promise<Project> {
    this.enter("recover");
    throw new ProjectError("forbidden", "operators only (not doubled)");
  }

  /** `principal` a manual member of `space`'s project, by trusted code (a test's shortcut). */
  join(space: string, principal: Principal): void {
    const record = this.spaces.get(space);
    if (record === undefined) throw new Error("no such project");
    record.members.push({ principal, role: "member", source: "manual", checkedAt: this.now(), by: { kind: "component", name: "test" }, at: this.now() });
  }
}

type SavedVersion = { file: SpaceFile; bytes: Uint8Array };

/** `space.files`, in memory. */
export class MemorySpaceFiles implements SpaceFiles {
  readonly calls: string[] = [];
  readonly spaces = new Map<string, { names: Map<string, { versions: SavedVersion[]; trashedAt?: number }>; log: Log; ids: Map<string, SpaceFile> }>();
  constructor(
    readonly now: () => number = () => Date.now(),
    readonly maxBytes = 1024 * 1024,
  ) {}

  private space(space: string) {
    let found = this.spaces.get(space);
    if (found === undefined) {
      found = { names: new Map(), log: new Log(), ids: new Map() };
      this.spaces.set(space, found);
    }
    return found;
  }
  private newest(versions: SavedVersion[], trashedAt?: number): SpaceFile {
    return { ...copy((versions.at(-1) as SavedVersion).file), ...(trashedAt !== undefined && { trashedAt }) };
  }

  async list(space: string, query: { limit: number; trashed?: boolean }) {
    this.calls.push("list");
    const kept = this.space(space);
    // The newest version of each name, newest first (`SpaceFiles.list`).
    const files: ListedSpaceFile[] = [...kept.names.values()]
      .reverse()
      .filter((each) => (query.trashed === true) === (each.trashedAt !== undefined))
      .map((each) => ({ ...this.newest(each.versions, each.trashedAt), versions: each.versions.length }));
    const all = [...kept.names.values()].flatMap((each) => each.versions);
    return { files: files.slice(0, query.limit), usage: { files: all.length, names: kept.names.size, bytes: all.reduce((sum, each) => sum + each.file.size, 0) } };
  }

  async file(space: string, name: string, query: { version?: number; trashed?: boolean }) {
    this.calls.push("file");
    const found = this.space(space).names.get(name);
    if (found === undefined || (found.trashedAt !== undefined && query.trashed !== true)) return undefined;
    const version = (query.version === undefined ? found.versions.at(-1) : found.versions.find((each) => each.file.version === query.version))?.file;
    return version === undefined ? undefined : { ...copy(version), ...(found.trashedAt !== undefined && { trashedAt: found.trashedAt }) };
  }

  async get(space: string, name: string, query: { version?: number }) {
    this.calls.push("get");
    const found = this.space(space).names.get(name);
    if (found === undefined || found.trashedAt !== undefined) return undefined;
    const version = query.version === undefined ? found.versions.at(-1) : found.versions.find((each) => each.file.version === query.version);
    return version === undefined ? undefined : { file: copy(version.file), bytes: version.bytes.slice() };
  }

  async download(space: string, name: string, query: { version?: number }) {
    this.calls.push("download");
    const found = await this.get(space, name, query);
    if (found === undefined) return undefined;
    const bytes = found.bytes;
    return { file: found.file, size: bytes.byteLength, body: new Response(bytes).body as ReadableStream<Uint8Array> };
  }

  async save(space: string, input: Parameters<SpaceFiles["save"]>[1], by: Author): Promise<SpaceFile> {
    this.calls.push("save");
    const kept = this.space(space);
    if (input.id !== undefined && kept.ids.has(input.id)) return copy(kept.ids.get(input.id) as SpaceFile);
    if (input.name === "" || /[/\\]/.test(input.name)) throw new SpaceFilesError("invalid", "a file's name is not a path");
    if (input.description.trim() === "") throw new SpaceFilesError("invalid", "a description is 1 to 500 characters");
    if (input.bytes.byteLength > this.maxBytes) throw new SpaceFilesError("limit", "a file is at most 1 MB here");
    const text = input.type !== undefined && mediaTypeOf(input.type).startsWith("text/") ? textOf(input.bytes) : undefined;
    if (text !== undefined && /sk-[A-Za-z0-9]{20,}/.test(text)) throw new SpaceFilesError("refused", "that looks like a credential");
    const at = this.now();
    const existing = kept.names.get(input.name);
    const before = existing === undefined ? undefined : this.newest(existing.versions);
    const file: SpaceFile = {
      id: input.id ?? crypto.randomUUID().replace(/-/g, ""),
      name: input.name,
      version: (existing?.versions.length ?? 0) + 1,
      description: input.description,
      size: input.bytes.byteLength,
      sha256: "0".repeat(64),
      ...(input.type !== undefined && { type: input.type }),
      by,
      createdAt: at,
      text: text === undefined ? "none" : "indexed",
    };
    if (existing === undefined) kept.names.set(input.name, { versions: [{ file, bytes: input.bytes.slice() }] });
    else {
      existing.versions.push({ file, bytes: input.bytes.slice() });
      delete existing.trashedAt;
      // Listed newest first: the name saved last goes last in the map.
      kept.names.delete(input.name);
      kept.names.set(input.name, existing);
    }
    kept.ids.set(file.id, file);
    kept.log.add(at, by, existing === undefined ? "added" : "changed", { kind: "file", id: input.name, title: input.name }, { version: file.version, before });
    return copy(file);
  }

  async versions(space: string, name: string): Promise<SpaceFile[]> {
    this.calls.push("versions");
    return copy(this.space(space).names.get(name)?.versions.map((each) => each.file) ?? []);
  }

  async trash(space: string, name: string, by: Author): Promise<boolean> {
    this.calls.push("trash");
    const kept = this.space(space);
    const found = kept.names.get(name);
    if (found === undefined || found.trashedAt !== undefined) return false;
    if (by.kind === "agent" && found.versions.some((each) => each.file.by.kind !== "agent")) throw new SpaceFilesError("forbidden", "an agent never trashes a person's file");
    found.trashedAt = this.now();
    kept.log.add(found.trashedAt, by, "removed", { kind: "file", id: name, title: name });
    return true;
  }

  async search(): Promise<[]> {
    this.calls.push("search");
    return [];
  }

  async text(): Promise<undefined> {
    this.calls.push("text");
    return undefined;
  }

  async changes(space: string, page: { before?: number; limit: number }): Promise<ChangePage> {
    this.calls.push("changes");
    return this.space(space).log.page(page.before, page.limit);
  }

  async restore(space: string, n: number, by: Author): Promise<Change> {
    this.calls.push("restore");
    const kept = this.space(space);
    const entry = kept.log.entries[n - 1];
    if (entry === undefined) throw new SpaceFilesError("not_found", "no such change");
    const found = kept.names.get(entry.item.id);
    if (found === undefined) throw new SpaceFilesError("gone", "purged");
    const at = this.now();
    if (entry.action === "removed") delete found.trashedAt;
    else if (entry.before === undefined) found.trashedAt = at;
    else {
      const before = found.versions.find((each) => each.file.version === (entry.before as SpaceFile).version) as SavedVersion;
      found.versions.push({ file: { ...before.file, version: found.versions.length + 1, createdAt: at }, bytes: before.bytes });
    }
    return kept.log.add(at, by, "restored", entry.item, { restores: n });
  }

  async redact(_space: string, _n: number, by: Author): Promise<void> {
    this.calls.push("redact");
    if (by.kind !== "operator") throw new SpaceFilesError("forbidden", "operators only");
  }

  async purge(space: string): Promise<void> {
    this.calls.push("purge");
    this.spaces.delete(space);
  }
}

const ownerKey = (owner: MemoryOwner): string => JSON.stringify(owner);
const MEMORY_KIND: Record<string, string> = { fact: "note", summary: "summary", rule: "rule", preference: "preference" };

/** memory-sql's `memory`, in memory: kinds, idempotent `remember`, `replace`, a log with restore. */
export class MemoryMemory implements MemoryStore {
  readonly calls: string[] = [];
  readonly owners = new Map<string, { items: Map<string, Memory>; log: Log }>();
  constructor(readonly now: () => number = () => Date.now()) {}

  private owner(owner: MemoryOwner) {
    const key = ownerKey(owner);
    let found = this.owners.get(key);
    if (found === undefined) {
      found = { items: new Map(), log: new Log() };
      this.owners.set(key, found);
    }
    return found;
  }

  ownerOf(conversation: { space?: string; key: string }): MemoryOwner {
    return { type: "space", space: conversation.space ?? conversation.key };
  }

  async list(owner: MemoryOwner, filter: MemoryFilter, limit: number): Promise<Memory[]> {
    this.calls.push("list");
    return copy([...this.owner(owner).items.values()].filter((each) => filter.kinds.includes(each.kind) && (filter.status === undefined || each.status === filter.status)).slice(-limit));
  }

  async get(owner: MemoryOwner, id: string): Promise<Memory | undefined> {
    this.calls.push("get");
    return copy(this.owner(owner).items.get(id));
  }

  async remember(owner: MemoryOwner, memory: NewMemory): Promise<void> {
    this.calls.push("remember");
    if (/sk-[A-Za-z0-9]{20,}/.test(memory.text)) throw new ActorCallError("invalid", "that looks like a credential");
    const kept = this.owner(owner);
    if (kept.items.has(memory.id)) return;
    kept.items.set(memory.id, copy(memory));
    kept.log.add(this.now(), memory.by, "added", { kind: MEMORY_KIND[memory.kind] as string, id: memory.id, title: memory.text });
  }

  async approve(owner: MemoryOwner, id: string, kind: Memory["kind"], by: Author): Promise<boolean> {
    this.calls.push("approve");
    const kept = this.owner(owner);
    const found = kept.items.get(id);
    if (found === undefined || found.kind !== kind) return false;
    if (found.status === "pending") {
      const before = copy(found);
      found.status = "active";
      found.updatedAt = this.now();
      kept.log.add(this.now(), by, "changed", { kind: MEMORY_KIND[kind] as string, id, title: found.text }, { before });
    }
    return true;
  }

  async forget(owner: MemoryOwner, id: string, filter: MemoryFilter, by: Author): Promise<boolean> {
    this.calls.push("forget");
    const kept = this.owner(owner);
    const found = kept.items.get(id);
    if (found === undefined || !filter.kinds.includes(found.kind) || (filter.status !== undefined && found.status !== filter.status)) return false;
    kept.items.delete(id);
    kept.log.add(this.now(), by, "removed", { kind: MEMORY_KIND[found.kind] as string, id, title: found.text }, { before: found });
    return true;
  }

  async replace(owner: MemoryOwner, id: string, memory: NewMemory): Promise<Memory | undefined> {
    this.calls.push("replace");
    const kept = this.owner(owner);
    const found = kept.items.get(id);
    if (found === undefined) return undefined;
    kept.items.delete(id);
    const next: Memory = { ...copy(memory), kind: found.kind, status: found.status, updatedAt: this.now() };
    kept.items.set(next.id, next);
    kept.log.add(this.now(), memory.by, "changed", { kind: MEMORY_KIND[found.kind] as string, id: next.id, title: next.text }, { before: found, after: next });
    return copy(next);
  }

  async search(): Promise<[]> {
    this.calls.push("search");
    return [];
  }

  async changes(owner: MemoryOwner, page: { before?: number; limit: number }): Promise<ChangePage> {
    this.calls.push("changes");
    return this.owner(owner).log.page(page.before, page.limit);
  }

  async restore(owner: MemoryOwner, n: number, by: Author): Promise<Change> {
    this.calls.push("restore");
    const kept = this.owner(owner);
    const entry = kept.log.entries[n - 1];
    if (entry === undefined) throw new ActorCallError("not_found", "no such change");
    if (entry.action === "added") kept.items.delete(entry.item.id);
    else if (entry.before !== undefined) {
      const before = entry.before as Memory;
      if (entry.after !== undefined) kept.items.delete((entry.after as Memory).id);
      kept.items.set(before.id, copy(before));
    }
    return kept.log.add(this.now(), by, "restored", entry.item, { restores: n });
  }

  async redact(_owner: MemoryOwner, _n: number, by: Author): Promise<void> {
    this.calls.push("redact");
    if (by.kind !== "operator") throw new ActorCallError("forbidden", "operators only");
  }

  async purge(owner: MemoryOwner): Promise<void> {
    this.calls.push("purge");
    this.owners.delete(ownerKey(owner));
  }
}

/** `principals`: a directory of links by email. */
export class FakePrincipals implements Principals {
  readonly people: Principal[][] = [];
  readonly emails = new Map<string, Principal[]>();
  /** `principals` are one person, `email` theirs. */
  link(email: string, ...principals: Principal[]): void {
    this.people.push(principals);
    this.emails.set(email.toLowerCase(), principals);
  }
  async of(principal: Principal): Promise<Principal[]> {
    const person = this.people.find((each) => each.some((one) => samePrincipal(one, principal)));
    return person === undefined ? [principal] : [principal, ...person.filter((one) => !samePrincipal(one, principal))];
  }
  async find(email: string): Promise<Principal[]> {
    return copy(this.emails.get(email.trim().toLowerCase()) ?? []);
  }
}

/** `document.convert`: PDFs "converted" to a line naming their bytes' text. */
export class FakeConverter implements DocumentConverter {
  readonly maxBytes = 25 * 1024 * 1024;
  readonly converted: string[] = [];
  accepts(type: string): boolean {
    return mediaTypeOf(type) === "application/pdf";
  }
  async convert(input: { bytes: Uint8Array; type: string; name?: string }): Promise<{ text: string } | undefined> {
    if (!this.accepts(input.type)) return undefined;
    const text = new TextDecoder().decode(input.bytes);
    if (text.trim() === "") throw new ConvertError("empty", "no text in it");
    this.converted.push(input.name ?? "");
    return { text: `# Converted\n\n${text}` };
  }
}

/** The doubles, together. */
export interface ProjectDoubles {
  projects: MemoryProjects;
  files: MemorySpaceFiles;
  memory: MemoryMemory;
  principals: FakePrincipals;
  convert: FakeConverter;
}

export function projectDoubles(now: () => number = () => Date.now()): ProjectDoubles {
  return { projects: new MemoryProjects(now), files: new MemorySpaceFiles(now), memory: new MemoryMemory(now), principals: new FakePrincipals(), convert: new FakeConverter() };
}

/**
 * A component providing `doubles` (those given: `projects` alone gives no files, memory...), and with
 * `projects` its stage of `conversation.audience`, as projects-sql's halves give both.
 */
export function projectsComponent(doubles: Partial<ProjectDoubles>, name = "projects-doubles") {
  return defineComponent({
    name,
    setup(pikit) {
      const projects = doubles.projects;
      if (projects !== undefined) {
        pikit.provide("projects", projects);
        pikit.pipeline("conversation.audience", audienceStage("projects", { grants: async (principals, space) => projects.grants(principals, space) }), { id: name });
      }
      if (doubles.files !== undefined) pikit.provide("space.files", doubles.files);
      if (doubles.memory !== undefined) pikit.provide("memory", doubles.memory);
      if (doubles.principals !== undefined) pikit.provide("principals", doubles.principals);
      if (doubles.convert !== undefined) pikit.provide("document.convert", doubles.convert);
    },
  });
}

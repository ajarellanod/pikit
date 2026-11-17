/**
 * Doubles of the stores projects-context reads, for its tests: `projects` (what an agent caller may
 * call: `context`, `search`, `read`, `instructions`, `links`, `addLink`, `get`, checked as the contract
 * says: an agent only in its own space), memory-sql's `memory` (per owner, as memory-sql keeps it) and
 * `space.files` (per space, with texts). Each counts the calls it takes, so a test sees what a request
 * cost. They keep what a test seeds, never more; methods the extension never calls throw.
 */

import {
  authorOf,
  type Author,
  type Caller,
  CORE_TOKENS_DEFAULT,
  estimateTokens,
  formatItemRef,
  type Instructions,
  type Link,
  type ListedSpaceFile,
  type Member,
  type Project,
  type ProjectDocument,
  ProjectError,
  type ProjectSearchHit,
  type ProjectStore,
  READ_PART,
  SPACE_FILE_TEXT_PART,
  type SpaceFile,
  type SpaceFiles,
  spaceOf,
} from "@pikit/contracts";
import type { Memory, MemoryOwner, MemoryStore } from "./contract.ts";

/** The words of `query`, lower case. */
const words = (query: string) => query.toLowerCase().split(/\W+/).filter((word) => word !== "");
/** Whether `text` holds every word of `query`. */
const matches = (text: string, query: string) => words(query).length > 0 && words(query).every((word) => text.toLowerCase().includes(word));
/** `text` with each word of `query` in `[` `]`. */
export const snippet = (text: string, query: string) => words(query).reduce((each, word) => each.replace(new RegExp(`(${word})`, "gi"), "[$1]"), text.replace(/\s+/g, " ").trim());

const notInDouble = (method: string) => async (): Promise<never> => {
  throw new Error(`the double does not answer ${method}`);
};

/** One project the double keeps. */
type Kept = { project: Project; members: Member[]; instructions?: Instructions; documents: { document: ProjectDocument; text: string }[]; links: Link[] };

/** A `projects` double: `seed` makes a project, the setters change it as a person on its page would (bumping its version). */
export function fakeProjects(clock: () => number = Date.now) {
  const kept = new Map<string, Kept>();
  const calls: string[] = [];
  const person = (name: string): Author => ({ kind: "person", principal: { channel: "web", id: name.toLowerCase(), name } });

  /** The project of `space` for `caller`: an agent only in its own space; nobody else is a caller here. */
  const of = (space: string, caller: Caller, method: string) => {
    calls.push(`${method} ${space}`);
    if (caller.kind !== "agent") throw new ProjectError("forbidden", "the double takes agent callers");
    if (caller.space !== space) throw new ProjectError("forbidden", "an agent acts only in its own space");
    const found = kept.get(space);
    if (found === undefined) throw new ProjectError("not_found", "no such project");
    return found;
  };
  const bump = (space: string) => {
    const found = kept.get(space);
    if (found !== undefined) found.project = { ...found.project, version: found.project.version + 1, updatedAt: clock() };
  };

  const store: ProjectStore = {
    create: notInDouble("create"),
    list: notInDouble("list"),
    locate: notInDouble("locate"),
    get: async (space, caller) => {
      calls.push(`get ${space}`);
      return caller.kind === "agent" && caller.space !== space ? undefined : kept.get(space)?.project;
    },
    roleOf: notInDouble("roleOf"),
    update: notInDouble("update"),
    members: notInDouble("members"),
    addMember: notInDouble("addMember"),
    removeMember: notInDouble("removeMember"),
    transferOwnership: notInDouble("transferOwnership"),
    syncMembers: notInDouble("syncMembers"),
    instructions: async (space, _query, caller) => of(space, caller, "instructions").instructions,
    setInstructions: notInDouble("setInstructions"),
    documents: notInDouble("documents"),
    putDocument: notInDouble("putDocument"),
    removeDocument: notInDouble("removeDocument"),
    read: async (space, id, query, caller) => {
      const found = of(space, caller, "read").documents.find((each) => each.document.id === id);
      if (found === undefined) return undefined;
      const parts = Math.max(1, Math.ceil(found.text.length / READ_PART));
      if (query.part > parts) return undefined;
      return { document: found.document, text: found.text.slice((query.part - 1) * READ_PART, query.part * READ_PART), part: query.part, parts };
    },
    versions: notInDouble("versions"),
    search: async (space, query, limit, caller) => {
      const found = of(space, caller, "search");
      const hits: ProjectSearchHit[] = [];
      if (found.instructions !== undefined && matches(found.instructions.text, query)) {
        hits.push({ ref: "instructions", kind: "instructions", title: "Instructions", snippet: snippet(found.instructions.text, query), by: found.instructions.by, version: found.instructions.version, at: found.instructions.at });
      }
      for (const { document, text } of found.documents) {
        if (matches(text, query)) hits.push({ ref: formatItemRef({ kind: "document", id: document.id }), kind: "document", title: document.title, snippet: snippet(text, query), by: document.by, version: document.version, part: 1, at: document.at });
      }
      for (const link of found.links) {
        const text = `${link.title} ${link.url} ${link.note ?? ""}`;
        if (matches(text, query)) hits.push({ ref: formatItemRef({ kind: "link", id: link.id }), kind: "link", title: link.title, snippet: snippet(text, query), by: link.by, at: link.at });
      }
      return hits.slice(0, limit);
    },
    links: async (space, caller) => of(space, caller, "links").links,
    addLink: async (space, link, caller) => {
      const found = of(space, caller, "addLink");
      const existing = found.links.find((each) => each.url === link.url);
      if (existing !== undefined) return existing;
      const added: Link = { id: `l-${found.links.length + 1}`, url: link.url, title: link.title, ...(link.note !== undefined && { note: link.note }), by: authorOf(caller), at: clock() };
      found.links.push(added);
      bump(space);
      return added;
    },
    removeLink: notInDouble("removeLink"),
    context: async (space, known, caller) => {
      calls.push(`context ${space}`);
      if (caller.kind !== "agent" || caller.space !== space) throw new ProjectError("forbidden", "an agent acts only in its own space");
      const found = kept.get(space);
      if (found === undefined) return undefined;
      if (known === found.project.version) return "unchanged";
      return {
        project: found.project,
        members: [...found.members],
        links: [...found.links],
        ...(found.instructions !== undefined && { instructions: found.instructions }),
        core: found.documents.filter((each) => each.document.mode === "core"),
        reference: found.documents.filter((each) => each.document.mode === "reference").map((each) => each.document),
      };
    },
    changes: notInDouble("changes"),
    restore: notInDouble("restore"),
    redact: notInDouble("redact"),
    remove: notInDouble("remove"),
    recover: notInDouble("recover"),
  };

  return {
    store,
    calls,
    person,
    /** A project for `space`: owner Ana Garcia, with `members` more members (the first named Luis Perez). */
    seed(space: string, input: { id?: string; name?: string; description?: string; members?: number } = {}): Project {
      const at = clock();
      const owner = { channel: "web", id: "ana", name: "Ana Garcia" };
      const extra = Array.from({ length: input.members ?? 1 }, (_, i) => (i === 0 ? { channel: "web", id: "luis", name: "Luis Perez" } : { channel: "googlechat", id: `users/${i}` }));
      const project: Project = {
        id: input.id ?? "3f2a9c1b3f2a9c1b3f2a9c1b3f2a9c1b",
        space,
        name: input.name ?? "AECC 2027",
        description: input.description ?? "",
        agents: [],
        owner,
        members: 1 + extra.length,
        coreTokens: CORE_TOKENS_DEFAULT,
        createdAt: at,
        updatedAt: at,
        version: 1,
      };
      const manual = (principal: Member["principal"], role: Member["role"]): Member => ({ principal, role, source: "manual", checkedAt: at, by: { kind: "person", principal: owner }, at });
      kept.set(space, { project, members: [manual(owner, "owner"), ...extra.map((each) => manual(each, "member"))], documents: [], links: [] });
      return project;
    },
    setInstructions(space: string, text: string, by: Author = person("Ana Garcia")) {
      const found = kept.get(space) as Kept;
      found.instructions = { text, version: (found.instructions?.version ?? 0) + 1, by, at: clock() };
      bump(space);
    },
    putDocument(space: string, input: { id: string; title: string; text: string; mode: "core" | "reference"; by?: Author; version?: number }) {
      const found = kept.get(space) as Kept;
      const document: ProjectDocument = { id: input.id, title: input.title, mode: input.mode, chars: input.text.length, tokens: estimateTokens(input.text.length), version: input.version ?? 1, by: input.by ?? person("Ana Garcia"), at: clock() };
      found.documents = [...found.documents.filter((each) => each.document.id !== input.id), { document, text: input.text }];
      bump(space);
    },
    addLink(space: string, link: Omit<Link, "at">) {
      (kept.get(space) as Kept).links.push({ ...link, at: clock() });
      bump(space);
    },
  };
}

/** A `memory` double, as memory-sql keeps it: per owner, idempotent by id, search by words with the filter. */
export function fakeMemory(agentScope: readonly string[] = []) {
  const kept = new Map<string, Memory[]>();
  const calls: string[] = [];
  const of = (owner: MemoryOwner) => {
    const key = JSON.stringify(owner);
    if (!kept.has(key)) kept.set(key, []);
    return kept.get(key) as Memory[];
  };
  const store: MemoryStore = {
    ownerOf: (conversation) => (agentScope.includes(conversation.agent) ? { type: "agent", agent: conversation.agent } : { type: "space", space: spaceOf(conversation) }),
    list: async (owner, filter, limit) => {
      calls.push(`list ${JSON.stringify(owner)} ${filter.kinds.join(",")}`);
      return of(owner).filter((m) => filter.kinds.includes(m.kind) && (filter.status === undefined || m.status === filter.status)).slice(-limit);
    },
    get: async (owner, id) => of(owner).find((m) => m.id === id),
    remember: async (owner, memory) => {
      if (!of(owner).some((m) => m.id === memory.id)) of(owner).push({ ...memory });
    },
    approve: notInDouble("approve"),
    forget: notInDouble("forget"),
    replace: notInDouble("replace"),
    search: async (owner, query, limit, _ctx, filter = { kinds: ["fact", "summary"] }) => {
      calls.push(`search ${JSON.stringify(owner)}`);
      return of(owner)
        .filter((m) => filter.kinds.includes(m.kind) && (filter.status === undefined || m.status === filter.status) && matches(m.text, query))
        .slice(0, limit)
        .map((m) => ({ ...m, snippet: snippet(m.text, query) }));
    },
    changes: notInDouble("changes"),
    restore: notInDouble("restore"),
    redact: notInDouble("redact"),
    purge: notInDouble("purge"),
  };
  return { store, calls };
}

/** A `space.files` double: per space, the newest version of each name, with a text when it has one. */
export function fakeFiles(clock: () => number = Date.now) {
  const kept = new Map<string, { file: SpaceFile; text?: string }[]>();
  const calls: string[] = [];
  const of = (space: string) => {
    if (!kept.has(space)) kept.set(space, []);
    return kept.get(space) as { file: SpaceFile; text?: string }[];
  };
  const store: SpaceFiles = {
    list: async (space, query) => {
      calls.push(`list ${space}`);
      const files: ListedSpaceFile[] = [...of(space)].reverse().slice(0, query.limit).map(({ file }) => ({ ...file, versions: file.version }));
      return { files, usage: { files: of(space).length, names: of(space).length, bytes: of(space).reduce((sum, each) => sum + each.file.size, 0) } };
    },
    file: async (space, name) => of(space).find((each) => each.file.name === name)?.file,
    get: notInDouble("get"),
    download: notInDouble("download"),
    save: notInDouble("save"),
    versions: notInDouble("versions"),
    trash: notInDouble("trash"),
    search: async (space, query, limit) => {
      calls.push(`search ${space}`);
      return of(space)
        .filter(({ file, text }) => matches(`${file.name} ${file.description} ${text ?? ""}`, query))
        .slice(0, limit)
        .map(({ file, text }) => ({ file, snippet: snippet(text ?? file.description, query), ...(text !== undefined && { part: 1 }) }));
    },
    text: async (space, name, query) => {
      const found = of(space).find((each) => each.file.name === name);
      if (found?.text === undefined) return undefined;
      const parts = Math.max(1, Math.ceil(found.text.length / SPACE_FILE_TEXT_PART));
      if (query.part > parts) return undefined;
      return { file: found.file, text: found.text.slice((query.part - 1) * SPACE_FILE_TEXT_PART, query.part * SPACE_FILE_TEXT_PART), part: query.part, parts };
    },
    changes: notInDouble("changes"),
    restore: notInDouble("restore"),
    redact: notInDouble("redact"),
    purge: notInDouble("purge"),
  };
  return {
    store,
    calls,
    /** Saves a version of `name` (the next one), by `by`, with `text` when it has one. */
    save(space: string, input: { name: string; description: string; size: number; by: Author; type?: string; text?: string }) {
      const list = of(space);
      const before = list.find((each) => each.file.name === input.name);
      const file: SpaceFile = {
        id: `${input.name}-${(before?.file.version ?? 0) + 1}`,
        name: input.name,
        version: (before?.file.version ?? 0) + 1,
        description: input.description,
        size: input.size,
        sha256: "0".repeat(64),
        ...(input.type !== undefined && { type: input.type }),
        by: input.by,
        createdAt: clock(),
        text: input.text === undefined ? "none" : "indexed",
      };
      kept.set(space, [...list.filter((each) => each.file.name !== input.name), { file, ...(input.text !== undefined && { text: input.text }) }]);
    },
  };
}

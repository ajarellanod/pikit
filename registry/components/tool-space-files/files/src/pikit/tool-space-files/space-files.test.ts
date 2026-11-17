/**
 * `space.files` as tool-space-files provides it, copied with the component: its App over
 * `sqliteStorage()`, an in-memory mailbox (every key's actor is the App, as on a server), an in-memory
 * `storage.blob` (`memory-blob.test-support.ts`), `createMemoryWakeups()` and a manual clock. The change
 * log's suite (`changeLogCases`) twice (people and a component; agents), then each guarantee of the
 * contract with its negative cases: per space, the one save path (names, descriptions, credentials,
 * limits, bytes first, idempotent), versions and authors, text and search, trash and its purge, restore
 * and redaction, the space's purge, a restart, and the Worker half over a mailbox to the actors' App.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppContext, BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createManualClock, type ManualClock } from "@pikit/core/testing";
import {
  ActorCallError,
  type ActorMailbox,
  type Author,
  type Change,
  CONVERT_TEXT_MAX,
  ConvertError,
  type DocumentConverter,
  type JsonValue,
  SPACE_FILE_TEXT_PART,
  type SpaceFiles,
  SpaceFilesError,
  type SqlDatabase,
} from "@pikit/contracts";
import { type ChangeLogAuthors, type ChangeLogSubject, changeLogCases, createMemoryMailbox, createMemoryWakeups, LOG_AGENT, LOG_OPERATOR, LOG_OTHER, LOG_PERSON } from "@pikit/contracts/testing";
import { createLocalExecution } from "@pikit/pi-adapter/node";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import toolSpaceFiles, { type SpaceFilesConfig, spaceFilesOver, worker } from "./index.ts";
import { createMemoryBlobStorage, memoryBlob } from "./memory-blob.test-support.ts";
import { actorKey, blobKey, CALL, CHANGES, SWEEP_BATCH } from "./space.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const DAY = 86_400_000;
/** A credential's shape the kit's detector knows. */
const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";
/** Bytes that are no UTF-8 text. */
const BINARY = new Uint8Array(512).map((_, i) => (i * 7 + 3) % 256);
const enc = (text: string) => new TextEncoder().encode(text);
const ANA: Author = LOG_PERSON;
const BOT: Author = { kind: "agent", agent: "assistant", conversation: "web:u-ana:c-1", for: { channel: "web", id: "u-ana" } };
const OTHER_BOT: Author = { kind: "agent", agent: "researcher", conversation: "web:u-luis:c-9" };

const execution = defineComponent({ name: "execution-test", setup: (pikit) => pikit.provide("execution", createLocalExecution({ cwd: tmpdir(), env: {} })) });
const provided = <K extends "document.convert">(name: K, value: DocumentConverter) =>
  defineComponent({ name: `${name.replace(".", "-")}-test`, setup: (pikit) => pikit.provide(name, value) });

type Options = { config?: Partial<SpaceFilesConfig>; clock?: ManualClock; path?: string; blobs?: ReturnType<typeof createMemoryBlobStorage>; convert?: DocumentConverter };

/** An App of tool-space-files; `files` is its `space.files`. */
async function start(options: Options = {}) {
  const clock = options.clock ?? createManualClock();
  const blobs = options.blobs ?? createMemoryBlobStorage();
  /** Set: every put fails (the bucket is down). */
  const broken = { put: false };
  const storage = {
    ...blobs,
    namespace(name: string) {
      const inner = blobs.namespace(name);
      return { ...inner, put: (key: string, bytes: Uint8Array, put?: { contentType?: string }) => (broken.put ? Promise.reject(new Error("the bucket is down")) : inner.put(key, bytes, put)) };
    },
  };
  let reached: { files: SpaceFiles; sql: SqlDatabase; mailbox: ActorMailbox; ctx: AppContext } | undefined;
  const probe = defineComponent({
    name: "probe",
    setup(pikit) {
      const files = pikit.use("space.files");
      const sql = pikit.use("storage.sql");
      const mailbox = pikit.use("actor.mailbox");
      return { start: (ctx) => void (reached = { files: files.get(), sql: sql.get(), mailbox: mailbox.get(), ctx: ctx.derive(() => BACKGROUND_CONTEXT) }) };
    },
  });
  const app = await defineApp({
    components: [
      sqliteStorage(options.path),
      createMemoryMailbox(),
      createMemoryWakeups(),
      memoryBlob(storage),
      execution,
      ...(options.convert === undefined ? [] : [provided("document.convert", options.convert)]),
      toolSpaceFiles,
      probe,
    ],
    config: { "tool-space-files": options.config ?? {} },
    logger: silentLogger,
    clock,
  }).create();
  await app.start();
  let stopped = false;
  const stop = async () => {
    if (!stopped) await app.stop();
    stopped = true;
  };
  cleanup.push(stop);
  const live = reached as NonNullable<typeof reached>;
  return {
    ...live,
    clock,
    blobs,
    broken,
    stop,
    /** The bytes kept for `space`, by key. */
    async kept(space: string) {
      const prefix = `${(await blobKey(space, "x")).split("/")[0]}/`;
      return [...(blobs.data.get("tool-space-files")?.keys() ?? [])].filter((key) => key.startsWith(prefix)).sort();
    },
    /** The whole log of `space`, oldest first. */
    async log(space: string): Promise<Change[]> {
      const all: Change[] = [];
      let before: number | undefined;
      for (;;) {
        const page = await live.files.changes(space, { limit: 2, ...(before !== undefined && { before }) }, live.ctx);
        all.push(...page.items);
        if (page.next === undefined) return all.reverse();
        before = page.next;
      }
    },
    call: (key: string, type: string, message: JsonValue) => live.mailbox.call(key, type, message, live.ctx),
  };
}

const codeOf = (work: Promise<unknown>) =>
  work.then(
    () => "resolved",
    (error: unknown) => (error instanceof SpaceFilesError || error instanceof ActorCallError ? error.code : String(error)),
  );
const failure = (work: Promise<unknown>) =>
  work.then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

// The change log's suite.

const SPACE = "gchat:spaces/AAA";

/** A subject over a fresh App: items are file names, a change a new version, a removal the trash. */
async function logSubject(): Promise<ChangeLogSubject> {
  const s = await start();
  let k = 0;
  let armed = false;
  /** A write that fails inside its transaction after the item is written: a trigger on the log's insert. */
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    if (!armed) return work();
    await s.sql.run(`CREATE TRIGGER IF NOT EXISTS tool_space_files_fail BEFORE INSERT ON ${CHANGES} BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    try {
      return await work();
    } finally {
      armed = false;
      await s.sql.run("DROP TRIGGER IF EXISTS tool_space_files_fail");
    }
  };
  return {
    add: (by) =>
      guarded(async () => {
        const name = `f-${++k}.md`;
        await s.files.save(SPACE, { name, description: `File ${k}`, bytes: enc(`first words ${k}`), type: "text/markdown" }, by, s.ctx);
        return name;
      }),
    change: (id, by) =>
      guarded(async () => {
        k++;
        await s.files.save(SPACE, { name: id, description: `Changed ${k}`, bytes: enc(`other words ${k}`) }, by, s.ctx);
      }),
    remove: (id, by) =>
      guarded(async () => {
        if (!(await s.files.trash(SPACE, id, by, s.ctx))) throw new Error("not trashed");
      }),
    restore: (n, by) => s.files.restore(SPACE, n, by, s.ctx),
    async state(id) {
      const file = await s.files.file(SPACE, id, {}, s.ctx);
      if (file === undefined) return undefined;
      const text = await s.files.text(SPACE, id, { part: 1 }, s.ctx);
      const { name, description, size, sha256, type, by } = file;
      return { name, description, size, sha256, type: type ?? null, by, text: text?.text ?? null } as unknown as JsonValue;
    },
    changes: () => s.log(SPACE),
    async repeat(id, by) {
      const newest = await s.files.file(SPACE, id, {}, s.ctx);
      await s.files.save(SPACE, { id: newest?.id ?? "", name: id, description: "Again", bytes: enc("again") }, by, s.ctx);
    },
    expire: () => s.clock.advance(366 * DAY),
    redact: (n, by) => s.files.redact(SPACE, n, by, s.ctx),
    failNextCommit: () => void (armed = true),
  };
}

const PEOPLE: ChangeLogAuthors = { first: LOG_PERSON, second: { kind: "component", name: "importer" }, third: LOG_OTHER, operator: LOG_OPERATOR };
// An agent trashes only what agents alone saved: the agents' run makes and removes items as agents.
const AGENTS: ChangeLogAuthors = { first: { kind: "agent", agent: "writer", conversation: "web:u-ana:c-2" }, second: LOG_AGENT, third: LOG_PERSON, operator: LOG_OPERATOR };
for (const c of changeLogCases("space.files (people)", logSubject, PEOPLE)) test(`${c.group}: ${c.name}`, () => c.run());
for (const c of changeLogCases("space.files (agents)", logSubject, AGENTS)) test(`${c.group}: ${c.name}`, () => c.run());

// What setup declares.

test("what setup declares: the default half and the Worker half", async () => {
  const app = await defineApp({ components: [sqliteStorage(), createMemoryMailbox(), createMemoryWakeups(), memoryBlob(), execution, toolSpaceFiles], logger: silentLogger }).create();
  expect(app.describe().components.find((component) => component.name === "tool-space-files")).toEqual({
    name: "tool-space-files",
    provides: ["space.files", "agent.extension"],
    requires: ["storage.sql", "storage.blob", "actor.mailbox", "actor.inbox", "wakeups", "execution"],
    optional: ["workspace", "projects", "document.convert"],
  });
  const half = await defineApp({ components: [createMemoryMailbox(), memoryBlob(), worker], logger: silentLogger }).create();
  expect(half.describe().components.find((component) => component.name === "tool-space-files-worker")).toEqual({
    name: "tool-space-files-worker",
    provides: ["space.files"],
    requires: ["actor.mailbox", "storage.blob"],
    optional: ["document.convert"],
  });
});

// The one save path.

test("save: a new name is version 1 by its author, saved again version 2; get gives the newest or the one asked, byte for byte", async () => {
  const s = await start();
  const first = await s.files.save(SPACE, { name: "brief.pdf", description: "The brief", bytes: BINARY, type: "application/pdf" }, ANA, s.ctx);
  const second = await s.files.save(SPACE, { name: "brief.pdf", description: "The brief, revised", bytes: enc("v2") }, BOT, s.ctx);

  expect(first).toMatchObject({ name: "brief.pdf", version: 1, size: 512, type: "application/pdf", by: ANA, text: "none" });
  expect(first.id).toMatch(/^[0-9a-f]{32}$/);
  expect(second).toMatchObject({ version: 2, by: BOT, text: "indexed" });
  expect((await s.files.get(SPACE, "brief.pdf", {}, s.ctx))?.bytes).toEqual(enc("v2"));
  expect((await s.files.get(SPACE, "brief.pdf", { version: 1 }, s.ctx))?.bytes).toEqual(BINARY);
  expect(await s.files.get(SPACE, "brief.pdf", { version: 3 }, s.ctx)).toBeUndefined();
  expect((await s.files.versions(SPACE, "brief.pdf", s.ctx)).map((f) => [f.version, f.by])).toEqual([
    [1, ANA],
    [2, BOT],
  ]);
  const listed = await s.files.list(SPACE, { limit: 10 }, s.ctx);
  expect(listed.files.map((f) => [f.name, f.version, f.versions, f.description])).toEqual([["brief.pdf", 2, 2, "The brief, revised"]]);
  expect(listed.usage).toEqual({ files: 2, names: 1, bytes: 514 });
  expect((await s.log(SPACE)).map((c) => [c.n, c.action, c.item, c.version, c.by])).toEqual([
    [1, "added", { kind: "file", id: "brief.pdf", title: "brief.pdf" }, 1, ANA],
    [2, "changed", { kind: "file", id: "brief.pdf", title: "brief.pdf" }, 2, BOT],
  ]);
});

test("save is idempotent by id: the same id answers the version kept the first time, writes nothing and logs nothing", async () => {
  const s = await start();
  const id = "ab".repeat(16);
  const first = await s.files.save(SPACE, { id, name: "a.txt", description: "A", bytes: enc("first") }, ANA, s.ctx);
  const again = await s.files.save(SPACE, { id, name: "b.txt", description: "B", bytes: enc("second") }, BOT, s.ctx);

  expect(again).toEqual(first);
  expect((await s.files.get(SPACE, "a.txt", {}, s.ctx))?.bytes).toEqual(enc("first"));
  expect(await s.files.file(SPACE, "b.txt", {}, s.ctx)).toBeUndefined();
  expect(await s.log(SPACE)).toHaveLength(1);
  expect(await s.kept(SPACE)).toEqual([await blobKey(SPACE, id)]);
});

test("save refuses a bad name, description, type, id, author or space as invalid, with nothing written", async () => {
  const s = await start();
  const ok = { name: "a.txt", description: "A", bytes: enc("a") };
  for (const [input, by, space] of [
    [{ ...ok, name: "a/b" }, ANA, SPACE],
    [{ ...ok, name: " a" }, ANA, SPACE],
    [{ ...ok, name: ".." }, ANA, SPACE],
    [{ ...ok, name: "x".repeat(256) }, ANA, SPACE],
    [{ ...ok, description: " " }, ANA, SPACE],
    [{ ...ok, description: "d".repeat(501) }, ANA, SPACE],
    [{ ...ok, type: "pdf" }, ANA, SPACE],
    [{ ...ok, id: "not-hex" }, ANA, SPACE],
    [{ ...ok, bytes: "text" as unknown as Uint8Array }, ANA, SPACE],
    [ok, { kind: "agent", agent: "a" } as unknown as Author, SPACE],
    [ok, { kind: "robot" } as unknown as Author, SPACE],
    [ok, ANA, ""],
  ] as const) {
    expect(await codeOf(s.files.save(space, input, by, s.ctx))).toBe("invalid");
  }
  expect(await s.kept(SPACE)).toEqual([]);
  expect(await s.log(SPACE)).toEqual([]);
});

test("credentials: a name, a description, a text file's content (any type) or a converted document holding one is refused and never echoed; a binary file is kept unchecked", async () => {
  const pdf = enc("%PDF-1.7 binary-ish");
  const convert: DocumentConverter = {
    maxBytes: 25 * 1024 * 1024,
    accepts: (type) => type === "application/pdf",
    convert: async (input) => ({ text: input.bytes.byteLength === pdf.byteLength ? `# Notes\nthe key is ${SECRET}` : "# Clean" }),
  };
  const s = await start({ convert });
  for (const input of [
    { name: SECRET, description: "Fine", bytes: enc("fine") },
    { name: "a.txt", description: `the key is ${SECRET}`, bytes: enc("fine") },
    { name: ".env", description: "Settings", bytes: enc(`# settings\nexport ANTHROPIC_API_KEY=${SECRET}\n`) },
    { name: "config.json", description: "Config", bytes: enc(JSON.stringify({ apiKey: SECRET })), type: "application/json" },
    { name: "data.bin", description: "Bytes", bytes: enc(`key=${SECRET}`), type: "application/octet-stream" },
    { name: "notes.pdf", description: "Notes", bytes: pdf, type: "application/pdf" },
  ]) {
    const message = await failure(s.files.save(SPACE, input, BOT, s.ctx));
    expect(message).toContain("looks like it holds a credential");
    expect(message).not.toContain("sk-ant");
    expect(await codeOf(s.files.save(SPACE, input, BOT, s.ctx))).toBe("refused");
  }
  expect(await s.kept(SPACE)).toEqual([]);
  const binary = new Uint8Array([0xff, 0xfe, ...enc(SECRET)]);
  expect((await s.files.save(SPACE, { name: "blob.bin", description: "Binary", bytes: binary }, BOT, s.ctx)).text).toBe("none");
});

test("the actor checks what crosses to it: a credential, a malformed call, another space's key", async () => {
  const s = await start();
  const file = { id: "a".repeat(32), name: "a.txt", description: "A", size: 1, sha256: "b".repeat(64) };
  const save = (space: string, fields: Record<string, JsonValue>) => s.call(actorKey(space), CALL.save, { space, file, by: ANA, ...fields } as JsonValue);
  const code = (work: Promise<unknown>) => codeOf(work);

  expect(await code(save(SPACE, { file: { ...file, text: `x ${SECRET}` } }))).toBe("refused");
  expect(await code(save(SPACE, { file: { ...file, description: SECRET } }))).toBe("refused");
  expect(await code(save(SPACE, { by: { kind: "person" } }))).toBe("invalid");
  expect(await code(save(SPACE, { file: { ...file, sha256: "x" } }))).toBe("invalid");
  expect(await code(save(SPACE, { file: { ...file, size: -1 } }))).toBe("invalid");
  expect(await code(s.call(actorKey("other"), CALL.save, { space: SPACE, file, by: ANA }))).toBe("invalid");
  expect(await code(s.call(actorKey("other"), CALL.list, { space: SPACE, limit: 10 }))).toBe("invalid");
  expect(await code(s.call(actorKey(SPACE), CALL.list, { limit: 10 }))).toBe("invalid");
  expect(await code(s.call(actorKey(SPACE), CALL.list, ["not", "an", "object"]))).toBe("invalid");
  expect(await code(s.call(actorKey(SPACE), CALL.changes, { space: SPACE, page: { limit: 0 } }))).toBe("invalid");
  expect(await code(s.call(actorKey(SPACE), CALL.text, { space: SPACE, name: "a.txt", part: 0 }))).toBe("invalid");
  expect((await s.files.list(SPACE, { limit: 10 }, s.ctx)).files).toEqual([]);
});

test("limits: a file too large, a space full of files or of bytes is refused before its bytes are written; trashed files count until purged", async () => {
  const s = await start({ config: { maxFileBytes: 100, maxSpaceBytes: 150, maxFiles: 2 } });
  const save = (name: string, size: number) => s.files.save(SPACE, { name, description: name, bytes: new Uint8Array(size) }, ANA, s.ctx);

  expect(await failure(save("big", 101))).toBe("the file has 101 bytes; a saved file has at most 100");
  await save("eighty", 80);
  expect(await failure(save("again", 80))).toContain("the space keeps 80 bytes; with this file's 80 it would pass its most, 150");
  await save("ten", 10);
  expect(await codeOf(save("third", 1))).toBe("limit");
  await s.files.trash(SPACE, "ten", ANA, s.ctx);
  // Refused before a byte is written: with every put failing, the answer is still the limit.
  s.broken.put = true;
  expect(await failure(save("third", 1))).toContain("the space already keeps 2 files");
  expect(await failure(save("big", 101))).toBe("the file has 101 bytes; a saved file has at most 100");
  s.broken.put = false;
  expect(await s.kept(SPACE)).toHaveLength(2);
});

test("the actor holds the limits in its transaction: saves at once never both pass one, nor take one version; the refused save's bytes go", async () => {
  const s = await start({ config: { maxFiles: 3 } });
  const saves = await Promise.allSettled(["1", "2", "3", "4", "5"].map((n) => s.files.save(SPACE, { name: "same.txt", description: n, bytes: enc(n) }, ANA, s.ctx)));

  expect(saves.flatMap((each) => (each.status === "fulfilled" ? [each.value.version] : [])).sort()).toEqual([1, 2, 3]);
  expect(saves.flatMap((each) => (each.status === "rejected" ? [(each.reason as SpaceFilesError).code] : []))).toEqual(["limit", "limit"]);
  expect(await s.kept(SPACE)).toHaveLength(3);
});

test("bytes first: a write of the bytes that fails keeps no row and logs nothing; a save refused after its bytes were written deletes them", async () => {
  const s = await start({ config: { maxFiles: 1 } });
  s.broken.put = true;
  expect(await failure(s.files.save(SPACE, { name: "a.txt", description: "A", bytes: enc("a") }, ANA, s.ctx))).toBe("the bucket is down");
  s.broken.put = false;
  expect((await s.files.list(SPACE, { limit: 10 }, s.ctx)).files).toEqual([]);
  expect(await s.log(SPACE)).toEqual([]);

  // A limit passed between the early check and the actor's transaction (a stale status): refused there, its bytes go.
  await s.files.save(SPACE, { name: "a.txt", description: "A", bytes: enc("a") }, ANA, s.ctx);
  const stale = spaceFilesOver({
    call: async (key, type, message, ctx) =>
      type === CALL.status ? ({ saved: null, usage: { files: 0, names: 0, bytes: 0 }, limits: { maxFileBytes: 100, maxSpaceBytes: 100, maxFiles: 100 } } as JsonValue) : s.mailbox.call(key, type, message, ctx),
    blobs: () => s.blobs.namespace("tool-space-files"),
    convert: () => undefined,
  });
  expect(await codeOf(stale.save(SPACE, { name: "b.txt", description: "B", bytes: enc("b") }, ANA, s.ctx))).toBe("limit");
  expect(await s.kept(SPACE)).toHaveLength(1);

  // A save cut after its bytes (the actor unreachable) keeps them; the same id then saves once.
  const id = "cd".repeat(16);
  let cut = true;
  const cutting = spaceFilesOver({
    call: async (key, type, message, ctx) => {
      if (type === CALL.save && cut) {
        cut = false;
        throw new ActorCallError("unreachable", "the object was evicted");
      }
      return s.mailbox.call(key, type, message, ctx);
    },
    blobs: () => s.blobs.namespace("tool-space-files"),
    convert: () => undefined,
  });
  await s.files.trash(SPACE, "a.txt", ANA, s.ctx);
  await s.clock.advance(31 * DAY);
  await waitFor(async () => (await s.kept(SPACE)).length === 0);
  expect(await failure(cutting.save(SPACE, { id, name: "c.txt", description: "C", bytes: enc("c") }, ANA, s.ctx))).toBe("the object was evicted");
  expect(await s.kept(SPACE)).toHaveLength(1);
  expect((await cutting.save(SPACE, { id, name: "c.txt", description: "C", bytes: enc("c") }, ANA, s.ctx)).version).toBe(1);
  expect(await s.kept(SPACE)).toHaveLength(1);
});

test("versions, trash and its listing: a trashed name is hidden from list, file, get, search and text, listed with trashed: true; saving it again brings it back", async () => {
  const s = await start();
  await s.files.save(SPACE, { name: "plan.md", description: "The plan", bytes: enc("launch on friday") }, ANA, s.ctx);

  expect(await s.files.trash(SPACE, "plan.md", ANA, s.ctx)).toBe(true);
  expect(await s.files.trash(SPACE, "plan.md", ANA, s.ctx)).toBe(false);
  expect(await s.files.trash(SPACE, "missing", ANA, s.ctx)).toBe(false);
  expect((await s.files.list(SPACE, { limit: 10 }, s.ctx)).files).toEqual([]);
  const trashed = await s.files.list(SPACE, { limit: 10, trashed: true }, s.ctx);
  expect(trashed.files.map((f) => [f.name, f.trashedAt])).toEqual([["plan.md", s.clock.now()]]);
  expect(await s.files.file(SPACE, "plan.md", {}, s.ctx)).toBeUndefined();
  expect((await s.files.file(SPACE, "plan.md", { trashed: true }, s.ctx))?.trashedAt).toBe(s.clock.now());
  expect(await s.files.get(SPACE, "plan.md", {}, s.ctx)).toBeUndefined();
  expect(await s.files.text(SPACE, "plan.md", { part: 1 }, s.ctx)).toBeUndefined();
  expect(await s.files.search(SPACE, "friday", 5, s.ctx)).toEqual([]);

  const back = await s.files.save(SPACE, { name: "plan.md", description: "The plan again", bytes: enc("launch on monday") }, ANA, s.ctx);
  expect([back.version, back.trashedAt]).toEqual([2, undefined]);
  expect((await s.log(SPACE)).map((c) => c.action)).toEqual(["added", "removed", "changed"]);
});

test("an agent trashes only names agents alone saved: never a person's upload, nor a name a person saved a version of", async () => {
  const s = await start();
  await s.files.save(SPACE, { name: "upload.pdf", description: "Ana's", bytes: BINARY }, ANA, s.ctx);
  await s.files.save(SPACE, { name: "chart.png", description: "A chart", bytes: BINARY }, BOT, s.ctx);
  await s.files.save(SPACE, { name: "mixed.md", description: "Both", bytes: enc("bot") }, BOT, s.ctx);
  await s.files.save(SPACE, { name: "mixed.md", description: "Both", bytes: enc("ana") }, ANA, s.ctx);

  expect(await codeOf(s.files.trash(SPACE, "upload.pdf", OTHER_BOT, s.ctx))).toBe("forbidden");
  expect(await codeOf(s.files.trash(SPACE, "mixed.md", BOT, s.ctx))).toBe("forbidden");
  expect(await s.files.trash(SPACE, "chart.png", OTHER_BOT, s.ctx)).toBe(true);
  expect(await s.files.trash(SPACE, "upload.pdf", LOG_OTHER, s.ctx)).toBe(true);
  expect((await s.files.list(SPACE, { limit: 10 }, s.ctx)).files.map((f) => f.name)).toEqual(["mixed.md"]);
});

test("per space: nothing is listed, read, searched, trashed, restored or logged across another space", async () => {
  const s = await start();
  await s.files.save(SPACE, { name: "secret-plan.md", description: "Our plan", bytes: enc("acquire the competitor") }, ANA, s.ctx);
  const other = "gchat:spaces/BBB";

  expect((await s.files.list(other, { limit: 10 }, s.ctx)).files).toEqual([]);
  expect(await s.files.file(other, "secret-plan.md", {}, s.ctx)).toBeUndefined();
  expect(await s.files.get(other, "secret-plan.md", {}, s.ctx)).toBeUndefined();
  expect(await s.files.search(other, "competitor", 5, s.ctx)).toEqual([]);
  expect(await s.files.text(other, "secret-plan.md", { part: 1 }, s.ctx)).toBeUndefined();
  expect(await s.files.trash(other, "secret-plan.md", ANA, s.ctx)).toBe(false);
  expect(await codeOf(s.files.restore(other, 1, ANA, s.ctx))).toBe("not_found");
  expect((await s.files.changes(other, { limit: 10 }, s.ctx)).items).toEqual([]);
  expect((await s.files.search(SPACE, "competitor", 5, s.ctx)).map((m) => m.file.name)).toEqual(["secret-plan.md"]);
});

// Text and search.

test("text: a text file's own text in parts of 20,000 characters; a binary none; text cut to CONVERT_TEXT_MAX", async () => {
  const s = await start({ config: { maxFileBytes: 25 * 1024 * 1024 } });
  const long = `${"a".repeat(SPACE_FILE_TEXT_PART)}${"b".repeat(5)}`;
  await s.files.save(SPACE, { name: "long.txt", description: "Long", bytes: enc(long) }, ANA, s.ctx);
  const second = await s.files.text(SPACE, "long.txt", { part: 2 }, s.ctx);
  expect([second?.text, second?.part, second?.parts]).toEqual(["bbbbb", 2, 2]);
  expect(await codeOf(s.files.text(SPACE, "long.txt", { part: 3 }, s.ctx))).toBe("invalid");

  await s.files.save(SPACE, { name: "img.png", description: "Image", bytes: BINARY, type: "image/png" }, ANA, s.ctx);
  expect(await s.files.text(SPACE, "img.png", { part: 1 }, s.ctx)).toBeUndefined();

  const huge = "word ".repeat(CONVERT_TEXT_MAX / 4);
  await s.files.save(SPACE, { name: "huge.md", description: "Huge", bytes: enc(huge), type: "text/markdown" }, ANA, s.ctx);
  const parts = (await s.files.text(SPACE, "huge.md", { part: 1 }, s.ctx))?.parts as number;
  const last = await s.files.text(SPACE, "huge.md", { part: parts }, s.ctx);
  expect(parts).toBe(Math.ceil(CONVERT_TEXT_MAX / SPACE_FILE_TEXT_PART));
  expect(last?.text.endsWith("[cut: the document is longer]")).toBe(true);
});

test("text with document.convert: a document it accepts is converted and searched; one that fails, too large, or not accepted is kept with no text", async () => {
  const asked: string[] = [];
  const convert: DocumentConverter = {
    maxBytes: 25 * 1024 * 1024,
    accepts: (type) => type === "application/pdf",
    async convert(input) {
      asked.push(input.type);
      if (input.bytes[0] === 0) throw new ConvertError("failed", "the document is damaged");
      return { text: "# Brief\nThe client wants the Valencia campaign in March." };
    },
  };
  const s = await start({ convert });
  const brief = await s.files.save(SPACE, { name: "brief.pdf", description: "The brief", bytes: enc("%PDF"), type: "application/pdf" }, ANA, s.ctx);
  const broken = await s.files.save(SPACE, { name: "broken.pdf", description: "Broken", bytes: new Uint8Array([0, 1]), type: "application/pdf" }, ANA, s.ctx);
  const word = await s.files.save(SPACE, { name: "notes.docx", description: "Notes", bytes: BINARY, type: "application/msword" }, ANA, s.ctx);

  expect([brief.text, broken.text, word.text]).toEqual(["indexed", "none", "none"]);
  expect(asked).toEqual(["application/pdf", "application/pdf"]);
  expect((await s.files.text(SPACE, "brief.pdf", { part: 1 }, s.ctx))?.text).toContain("Valencia campaign");
  const [hit] = await s.files.search(SPACE, "valencia", 5, s.ctx);
  expect([hit?.file.name, hit?.part, hit?.snippet]).toEqual(["brief.pdf", 1, expect.stringContaining("[Valencia]")]);
  expect((await s.files.search(SPACE, "broken", 5, s.ctx)).map((m) => [m.file.name, m.part])).toEqual([["broken.pdf", undefined]]);
});

test("search: names, descriptions and texts, the newest version of each name, best first, each file once; no query is a syntax error", async () => {
  const s = await start();
  await s.files.save(SPACE, { name: "budget-q1.csv", description: "Budget", bytes: enc("channel,cpa\nsearch,18\nsocial,22") }, ANA, s.ctx);
  await s.files.save(SPACE, { name: "notes.md", description: "Meeting notes about the budget", bytes: enc("old words: zebra") }, ANA, s.ctx);
  await s.files.save(SPACE, { name: "notes.md", description: "Meeting notes", bytes: enc("new words: giraffe") }, BOT, s.ctx);

  expect((await s.files.search(SPACE, "budget", 5, s.ctx)).map((m) => m.file.name)).toEqual(["budget-q1.csv"]);
  expect((await s.files.search(SPACE, "giraffe", 5, s.ctx)).map((m) => [m.file.name, m.file.version, m.part])).toEqual([["notes.md", 2, 1]]);
  expect(await s.files.search(SPACE, "zebra", 5, s.ctx)).toEqual([]);
  expect((await s.files.search(SPACE, "notes", 5, s.ctx)).map((m) => [m.file.name, m.part])).toEqual([["notes.md", undefined]]);
  for (const query of ['ana@example.com "NOT" (cake*', "?! -- ...", "AND OR NEAR(", "https://x.y/z?q=1"]) {
    expect(Array.isArray(await s.files.search(SPACE, query, 5, s.ctx))).toBe(true);
  }
  expect((await s.files.search(SPACE, "cpa social", 1, s.ctx)).length).toBe(1);
});

// Restore, redaction, retention.

test("restore: a trashed name back; an older version saved again as the newest, its bytes and original author kept, the restorer the entry's", async () => {
  const s = await start();
  await s.files.save(SPACE, { name: "plan.md", description: "One", bytes: enc("one") }, ANA, s.ctx);
  await s.files.save(SPACE, { name: "plan.md", description: "Two", bytes: enc("two") }, BOT, s.ctx);
  const restored = await s.files.restore(SPACE, 2, LOG_OTHER, s.ctx);

  expect([restored.n, restored.action, restored.restores, restored.by, restored.version]).toEqual([3, "restored", 2, LOG_OTHER, 3]);
  const newest = await s.files.file(SPACE, "plan.md", {}, s.ctx);
  expect([newest?.version, newest?.description, newest?.by]).toEqual([3, "One", ANA]);
  expect((await s.files.get(SPACE, "plan.md", {}, s.ctx))?.bytes).toEqual(enc("one"));
  expect((await s.files.list(SPACE, { limit: 1 }, s.ctx)).usage).toEqual({ files: 3, names: 1, bytes: 6 });

  await s.files.trash(SPACE, "plan.md", ANA, s.ctx);
  await s.files.restore(SPACE, 4, ANA, s.ctx);
  expect((await s.files.file(SPACE, "plan.md", {}, s.ctx))?.version).toBe(3);
  expect(await codeOf(s.files.restore(SPACE, 99, ANA, s.ctx))).toBe("not_found");
});

test("redact is an operator's only: anyone else forbidden; the entry keeps who and when, says redacted, and is no longer restorable", async () => {
  const s = await start();
  await s.files.save(SPACE, { name: "ana-garcia-cv.pdf", description: "A CV", bytes: BINARY }, ANA, s.ctx);
  for (const by of [ANA, BOT, { kind: "component", name: "x" } as Author]) expect(await codeOf(s.files.redact(SPACE, 1, by, s.ctx))).toBe("forbidden");
  expect(await codeOf(s.files.redact(SPACE, 7, LOG_OPERATOR, s.ctx))).toBe("not_found");
  await s.files.redact(SPACE, 1, LOG_OPERATOR, s.ctx);

  const [entry] = await s.log(SPACE);
  expect([entry?.by, entry?.item.title, entry?.restorable, entry?.redacted?.by]).toEqual([ANA, "redacted", false, LOG_OPERATOR]);
  expect(await codeOf(s.files.restore(SPACE, 1, ANA, s.ctx))).toBe("gone");
});

test("the trash is purged 30 days on by the sweep: rows, texts and bytes, a removed entry not restorable, the earlier entries gone; not a day before", async () => {
  const s = await start();
  await s.files.save(SPACE, { name: "old.md", description: "Old", bytes: enc("forgotten words") }, ANA, s.ctx);
  await s.files.save(SPACE, { name: "old.md", description: "Old 2", bytes: enc("forgotten again") }, ANA, s.ctx);
  await s.files.save(SPACE, { name: "kept.md", description: "Kept", bytes: enc("kept") }, ANA, s.ctx);
  await s.files.trash(SPACE, "old.md", ANA, s.ctx);

  await s.clock.advance(29 * DAY);
  expect((await s.files.list(SPACE, { limit: 10, trashed: true }, s.ctx)).files).toHaveLength(1);
  expect(await s.kept(SPACE)).toHaveLength(3);

  await s.clock.advance(1 * DAY + 1);
  await waitFor(async () => (await s.kept(SPACE)).length === 1);
  expect((await s.files.list(SPACE, { limit: 10, trashed: true }, s.ctx)).files).toEqual([]);
  expect((await s.files.list(SPACE, { limit: 10 }, s.ctx)).usage).toEqual({ files: 1, names: 1, bytes: 4 });
  const log = await s.log(SPACE);
  expect(log.at(-1)).toMatchObject({ action: "removed", by: { kind: "component", name: "tool-space-files" }, item: { id: "old.md" }, restorable: false });
  expect(log.filter((c) => c.item.id === "old.md").every((c) => !c.restorable)).toBe(true);
  expect(log.find((c) => c.item.id === "kept.md")?.restorable).toBe(true);
  expect(await codeOf(s.files.restore(SPACE, 4, ANA, s.ctx))).toBe("gone");
  expect(await s.files.search(SPACE, "forgotten", 5, s.ctx)).toEqual([]);
});

test("the sweep deletes many bytes in batches, asking to run again until none is left", async () => {
  const s = await start();
  for (let i = 0; i < SWEEP_BATCH + 5; i++) await s.files.save(SPACE, { name: "many.bin", description: `${i}`, bytes: new Uint8Array([i]) }, BOT, s.ctx);
  await s.files.trash(SPACE, "many.bin", BOT, s.ctx);
  await s.clock.advance(31 * DAY);
  await waitFor(async () => (await s.kept(SPACE)).length === 0);
});

test("purge(space): every row, entry and byte of the space for good (orphans included), another space untouched", async () => {
  const s = await start();
  await s.files.save(SPACE, { name: "a.md", description: "A", bytes: enc("a") }, ANA, s.ctx);
  await s.files.save(SPACE, { name: "b.md", description: "B", bytes: enc("b") }, ANA, s.ctx);
  await s.blobs.namespace("tool-space-files").put(await blobKey(SPACE, "f".repeat(32)), enc("an orphan of a cut save"));
  await s.files.save("other", { name: "a.md", description: "A", bytes: enc("a") }, ANA, s.ctx);

  await s.files.purge(SPACE, s.ctx);
  expect(await s.kept(SPACE)).toEqual([]);
  expect((await s.files.list(SPACE, { limit: 10 }, s.ctx)).files).toEqual([]);
  expect(await s.log(SPACE)).toEqual([]);
  expect(await s.files.search(SPACE, "a", 5, s.ctx)).toEqual([]);
  expect((await s.files.list("other", { limit: 10 }, s.ctx)).files).toHaveLength(1);
  expect(await s.kept("other")).toHaveLength(1);
});

test("get and download refuse bytes missing or damaged in storage (gone); a download streams the bytes whole", async () => {
  const s = await start();
  const saved = await s.files.save(SPACE, { name: "a.bin", description: "A", bytes: BINARY }, ANA, s.ctx);
  const down = await s.files.download(SPACE, "a.bin", {}, s.ctx);
  expect([down?.size, new Uint8Array(await new Response(down?.body).arrayBuffer())]).toEqual([512, BINARY]);

  const key = await blobKey(SPACE, saved.id);
  await s.blobs.namespace("tool-space-files").put(key, new Uint8Array(512));
  expect(await codeOf(s.files.get(SPACE, "a.bin", {}, s.ctx))).toBe("gone");
  const damaged = await s.files.download(SPACE, "a.bin", {}, s.ctx);
  expect(await failure(new Response(damaged?.body).arrayBuffer())).toContain("missing or damaged");
  await s.blobs.namespace("tool-space-files").delete(key);
  expect(await codeOf(s.files.get(SPACE, "a.bin", {}, s.ctx))).toBe("gone");
  expect(await codeOf(s.files.download(SPACE, "a.bin", {}, s.ctx))).toBe("gone");
});

test("committed before each call resolves: a new App over the same database and bytes keeps files, texts, the trash and the log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-space-files-restart-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "pikit.db");
  const blobs = createMemoryBlobStorage();
  const clock = createManualClock();
  const first = await start({ path, blobs, clock });
  await first.files.save(SPACE, { name: "a.md", description: "A", bytes: enc("the harbour plan") }, ANA, first.ctx);
  await first.files.save(SPACE, { name: "b.md", description: "B", bytes: enc("b") }, ANA, first.ctx);
  await first.files.trash(SPACE, "b.md", ANA, first.ctx);
  await first.stop();

  const second = await start({ path, blobs, clock });
  expect((await second.files.list(SPACE, { limit: 10 }, second.ctx)).files.map((f) => f.name)).toEqual(["a.md"]);
  expect((await second.files.search(SPACE, "harbour", 5, second.ctx)).map((m) => m.file.name)).toEqual(["a.md"]);
  expect((await second.log(SPACE)).map((c) => c.action)).toEqual(["added", "added", "removed"]);
  // The sweep was asked again at start: the trash is purged on time.
  await clock.advance(31 * DAY);
  await waitFor(async () => (await second.kept(SPACE)).length === 1);
});

// The Worker half.

test("the Worker half: an upload in the Worker's App lands in the space's actor, with the bytes every App reaches; the limits come from the actor", async () => {
  const blobs = createMemoryBlobStorage();
  const s = await start({ blobs, config: { maxFileBytes: 1000 } });
  // The Worker's mailbox reaches the actors' App, as actors-do reaches the space's object.
  const remote = defineComponent({
    name: "mailbox-to-objects",
    setup: (pikit) =>
      pikit.provide("actor.mailbox", {
        send: () => Promise.reject(new Error("not used")),
        call: (key, type, message) => s.mailbox.call(key, type, message, s.ctx),
        stream: () => Promise.reject(new Error("not used")),
      }),
  });
  let files: SpaceFiles | undefined;
  const probe = defineComponent({
    name: "probe",
    setup(pikit) {
      const handle = pikit.use("space.files");
      return { start: () => void (files = handle.get()) };
    },
  });
  const app = await defineApp({ components: [remote, memoryBlob(blobs), worker, probe], logger: silentLogger }).create();
  await app.start();
  cleanup.push(() => app.stop());
  const ctx = app.context();
  const half = files as SpaceFiles;

  const uploaded = await half.save(SPACE, { name: "brief.md", description: "The brief", bytes: enc("valencia in march"), type: "text/markdown" }, ANA, ctx);
  expect(uploaded).toMatchObject({ version: 1, by: ANA, text: "indexed" });
  expect((await s.files.get(SPACE, "brief.md", {}, s.ctx))?.bytes).toEqual(enc("valencia in march"));
  expect((await s.files.search(SPACE, "valencia", 5, s.ctx)).map((m) => m.file.name)).toEqual(["brief.md"]);
  expect(new TextDecoder().decode(await new Response((await half.download(SPACE, "brief.md", {}, ctx))?.body).arrayBuffer())).toBe("valencia in march");
  expect(await failure(half.save(SPACE, { name: "big", description: "Big", bytes: new Uint8Array(1001) }, ANA, ctx))).toBe("the file has 1001 bytes; a saved file has at most 1000");
  expect(await half.trash(SPACE, "brief.md", ANA, ctx)).toBe(true);
  expect((await half.changes(SPACE, { limit: 10 }, ctx)).items.map((c) => c.action)).toEqual(["removed", "added"]);
});

async function waitFor(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}


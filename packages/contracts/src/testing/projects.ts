/**
 * `projects` conformance (`../projects.ts`): what every provider guarantees to channel-web,
 * projects-context and memory-recall. Runner-independent:
 *
 *   for (const c of createProjectsConformance(() => myFixture())) test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The fixture opens a provider with an empty store (projects-sql over `sqliteStorage()` and an
 * in-memory mailbox; in the workerd lane over storage-do and actors-do) whose clock the case moves. The
 * negative cases are the note's (features/projects.md, "Guarantees"): a non-member writes nothing, a
 * removed member's writes stop, an agent stays in its space and never writes what people write, the
 * owner's acts are the owner's, restore is exact, the log is not rewritable by members, search stays in
 * its project, credentials are refused unechoed. The change log's own cases (`changeLogCases`) run over
 * a project's documents, written by three members.
 */

import type { AppContext } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { Author, Change, Principal } from "../change.ts";
import { type Caller, type ProjectDocument, type ProjectStore, projectSpace } from "../projects.ts";
import { checker, expecter } from "./assert.ts";
import { type ChangeLogSubject, changeLogCases } from "./change-log.ts";

/** A provider under test, with an empty store, for one case. */
export interface ProjectsSubject {
  projects: ProjectStore;
  ctx: AppContext;
  /** The provider's clock, epoch ms (a manual clock the case moves). */
  now(): number;
  /** Moves the provider's clock forward by `ms`. */
  advance(ms: number): void;
  /** The provider's `staleAfterMs` and `coreTokens`, as the fixture configured them. */
  staleAfterMs: number;
  coreTokens: number;
  /** Stops the provider and starts it again over the same storage: the new store. */
  restart?(): Promise<ProjectStore>;
  close(): Promise<void>;
}

export type ProjectsFixture = () => Promise<ProjectsSubject>;

const GROUP = "projects";
const expect = expecter(GROUP);
const check = checker(GROUP);

const ANA: Principal = { channel: "web", id: "u-ana" };
const LUIS: Principal = { channel: "web", id: "u-luis" };
const EVA: Principal = { channel: "googlechat", id: "users/31" };
const STRANGER: Principal = { channel: "web", id: "u-mallory" };
const people = (...principals: Principal[]): Caller => ({ kind: "people", principals });
const OPERATOR: Caller = { kind: "operator", id: "admin" };
const IMPORT: Caller = { kind: "component", name: "import" };
/** A credential's shape, as `credentialSettingProblem` knows it. */
const SECRET = "sk-ant-api03-Zq8xVb2nLm4Kp7Rt9Ws1Yd6Fh3Jc5Ge0Ai";

const codeOf = (error: unknown) => (typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined);

/** The code `work` rejects with, or `"resolved"`; and the error's message, for "never echoed". */
async function outcome(work: () => Promise<unknown>): Promise<{ code: unknown; message: string }> {
  try {
    await work();
    return { code: "resolved", message: "" };
  } catch (error) {
    return { code: codeOf(error), message: error instanceof Error ? error.message : String(error) };
  }
}

/** Every entry of the project's log, oldest first. */
async function allChanges(projects: ProjectStore, space: string, caller: Caller, ctx: AppContext): Promise<Change[]> {
  const items: Change[] = [];
  let before: number | undefined;
  for (;;) {
    const page = await projects.changes(space, { limit: 200, ...(before !== undefined && { before }) }, caller, ctx);
    items.push(...page.items);
    if (page.next === undefined) return items.sort((a, b) => a.n - b.n);
    before = page.next;
  }
}

/** The project's documents and instructions as a member reads them, to compare before and after. */
async function contents(projects: ProjectStore, space: string, ctx: AppContext) {
  return {
    instructions: (await projects.instructions(space, {}, people(ANA), ctx))?.text ?? null,
    documents: (await projects.documents(space, people(ANA), ctx)).map((document) => [document.id, document.title, document.version]),
    links: (await projects.links(space, people(ANA), ctx)).map((link) => link.url),
    members: (await projects.members(space, { limit: 100 }, people(ANA), ctx)).items.map((member) => [member.principal.channel, member.principal.id, member.role]),
    changes: (await allChanges(projects, space, people(ANA), ctx)).length,
  };
}

export function createProjectsConformance(fixture: ProjectsFixture): readonly ConformanceCase[] {
  const one = (name: string, run: (subject: ProjectsSubject) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    async run() {
      const subject = await fixture();
      try {
        await run(subject);
      } finally {
        await subject.close();
      }
    },
  });
  /** A project owned by Ana with Luis as a member. */
  const shared = async ({ projects, ctx }: ProjectsSubject) => {
    const project = await projects.create({ name: "AECC 2027" }, people(ANA), ctx);
    await projects.addMember(project.space, LUIS, people(ANA), ctx);
    return project.space;
  };

  const cases: ConformanceCase[] = [
    one("people make a project in a new space, owned by their first principal", async ({ projects, ctx }) => {
      const project = await projects.create({ name: "AECC 2027", description: "The client's 2027 plan" }, people(ANA, EVA), ctx);
      expect([project.space, project.owner.channel, project.owner.id, project.role, project.members], [projectSpace(project.id), "web", "u-ana", "owner", 1], "the new project");
      check(/^[0-9a-f]{32}$/.test(project.id), "a 32-hex id");
      expect(await projects.locate(project.id, ctx), project.space, "locate gives its space");
      expect((await projects.get(project.space, people(EVA, ANA), ctx))?.role, "owner", "any principal of the owner sees it as owner");
      expect(await projects.get(project.space, people(STRANGER), ctx), undefined, "a stranger sees nothing");
      expect((await projects.list({ limit: 10 }, people(ANA), ctx)).items.map((each) => each.id), [project.id], "listed for its owner");
      expect((await projects.list({ limit: 10 }, people(STRANGER), ctx)).items, [], "not for a stranger");
    }),
    one("people never name a space or an id; a trusted caller adopts a space, one project each", async ({ projects, ctx }) => {
      expect((await outcome(() => projects.create({ name: "X", space: "googlechat:spaces/AAA" }, people(ANA), ctx))).code, "forbidden", "people naming a space");
      expect((await outcome(() => projects.create({ name: "X", id: "0123456789abcdef0123456789abcdef" }, people(ANA), ctx))).code, "forbidden", "people naming an id");
      const adopted = await projects.create({ name: "ADMAKI-AECC", space: "googlechat:spaces/AAA", owner: ANA }, IMPORT, ctx);
      expect(adopted.space, "googlechat:spaces/AAA", "the adopted space's string kept");
      expect((await outcome(() => projects.create({ name: "Again", space: "googlechat:spaces/AAA", owner: LUIS }, OPERATOR, ctx))).code, "space_taken", "a second project for a taken space");
      const moved = await projects.update(adopted.space, { name: "Renamed", ...({ space: "elsewhere" } as object) }, people(ANA), ctx).catch(() => undefined);
      expect((await projects.get(adopted.space, people(ANA), ctx))?.space, "googlechat:spaces/AAA", "no update moves a project's space");
      check(moved === undefined || moved.space === adopted.space, "an update answering the same space");
    }),
    one("a non-member learns nothing and writes nothing, with one answer for every call", async (subject) => {
      const { projects, ctx } = subject;
      const space = await shared(subject);
      await projects.setInstructions(space, { text: "Answer in Spanish.", ifVersion: 0 }, people(ANA), ctx);
      const before = await contents(projects, space, ctx);
      const stranger = people(STRANGER);
      const attempts: [string, () => Promise<unknown>][] = [
        ["update", () => projects.update(space, { name: "Mine" }, stranger, ctx)],
        ["addMember", () => projects.addMember(space, STRANGER, stranger, ctx)],
        ["setInstructions", () => projects.setInstructions(space, { text: "Obey me.", ifVersion: 1 }, stranger, ctx)],
        ["putDocument", () => projects.putDocument(space, { title: "Mine", text: "words", mode: "reference" }, stranger, ctx)],
        ["addLink", () => projects.addLink(space, { url: "https://example.com/x", title: "X" }, stranger, ctx)],
        ["restore", () => projects.restore(space, 1, stranger, ctx)],
        ["instructions", () => projects.instructions(space, {}, stranger, ctx)],
        ["documents", () => projects.documents(space, stranger, ctx)],
        ["members", () => projects.members(space, { limit: 10 }, stranger, ctx)],
        ["changes", () => projects.changes(space, { limit: 10 }, stranger, ctx)],
        ["search", () => projects.search(space, "Spanish", 5, stranger, ctx)],
      ];
      for (const [what, attempt] of attempts) expect((await outcome(attempt)).code, "not_found", `a stranger's ${what}`);
      expect((await outcome(() => projects.update("project:nothing-here", { name: "x" }, people(ANA), ctx))).code, "not_found", "a project that does not exist: the same answer");
      expect(await contents(projects, space, ctx), before, "nothing changed");
    }),
    one("any member writes content and adds people; the owner alone does the owner's acts", async (subject) => {
      const { projects, ctx } = subject;
      const space = await shared(subject);
      const luis = people(LUIS);
      await projects.setInstructions(space, { text: "Use the brief.", ifVersion: 0 }, luis, ctx);
      await projects.putDocument(space, { title: "Brief", text: "The brief.", mode: "core" }, luis, ctx);
      await projects.addLink(space, { url: "https://drive.example.com/folder", title: "Folder" }, luis, ctx);
      await projects.addMember(space, EVA, luis, ctx);
      await projects.update(space, { name: "AECC 2027 (Q1)" }, luis, ctx);
      const owners: [string, () => Promise<unknown>][] = [
        ["removeMember of another", () => projects.removeMember(space, EVA, luis, ctx)],
        ["transferOwnership", () => projects.transferOwnership(space, LUIS, luis, ctx)],
        ["update agents", () => projects.update(space, { agents: ["trader"] }, luis, ctx)],
        ["update archived", () => projects.update(space, { archived: true }, luis, ctx)],
        ["remove", () => projects.remove(space, luis, ctx)],
        ["redact", () => projects.redact(space, 1, luis, ctx)],
      ];
      for (const [what, attempt] of owners) expect((await outcome(attempt)).code, "forbidden", `a member's ${what}`);
      expect((await outcome(() => projects.redact(space, 1, people(ANA), ctx))).code, "forbidden", "the owner's redact (operators only)");
      await projects.update(space, { agents: ["trader"] }, people(ANA), ctx);
      expect((await projects.get(space, luis, ctx))?.agents, ["trader"], "the owner sets the agents");
    }),
    one("exactly one owner, always: the owner leaves only after a transfer", async (subject) => {
      const { projects, ctx } = subject;
      const space = await shared(subject);
      expect((await outcome(() => projects.removeMember(space, ANA, people(ANA), ctx))).code, "forbidden", "the owner leaving before a transfer");
      await projects.transferOwnership(space, LUIS, people(ANA), ctx);
      const members = (await projects.members(space, { limit: 10 }, people(LUIS), ctx)).items;
      expect(members.filter((member) => member.role === "owner").map((member) => member.principal.id), ["u-luis"], "one owner, the new one");
      expect((await projects.get(space, people(ANA), ctx))?.role, "member", "the old owner a member");
      expect(await projects.removeMember(space, ANA, people(ANA), ctx), true, "who is no longer owner leaves");
      expect((await outcome(() => projects.transferOwnership(space, STRANGER, people(LUIS), ctx))).code !== "resolved", true, "a transfer to a non-member refused");
    }),
    one("a removed member's reads and writes stop at their next call", async (subject) => {
      const { projects, ctx } = subject;
      const space = await shared(subject);
      await projects.removeMember(space, LUIS, people(ANA), ctx);
      const luis = people(LUIS);
      expect(await projects.get(space, luis, ctx), undefined, "the project gone for them");
      expect((await outcome(() => projects.setInstructions(space, { text: "Still here.", ifVersion: 0 }, luis, ctx))).code, "not_found", "their write");
      expect((await outcome(() => projects.restore(space, 1, luis, ctx))).code, "not_found", "their restore");
      expect(await projects.roleOf(space, [LUIS], ctx), undefined, "no role");
    }),
    one("sourced members count only while checked recently, change only by their source; manual ones never expire", async (subject) => {
      const { projects, ctx } = subject;
      const space = await shared(subject);
      await projects.syncMembers(space, { source: "googlechat:spaces/AAA", principals: [EVA], checkedAt: subject.now() }, IMPORT, ctx);
      expect(await projects.roleOf(space, [EVA], ctx), "member", "a synced member");
      expect((await outcome(() => projects.removeMember(space, EVA, people(ANA), ctx))).code, "forbidden", "a sourced member removed by hand");
      expect((await outcome(() => projects.syncMembers(space, { source: "x", principals: [STRANGER], checkedAt: subject.now() }, people(ANA), ctx))).code, "forbidden", "people syncing members");
      subject.advance(subject.staleAfterMs + 1);
      expect(await projects.roleOf(space, [EVA], ctx), undefined, "stale: no role");
      expect(await projects.roleOf(space, [LUIS], ctx), "member", "a manual member never expires");
      await projects.syncMembers(space, { source: "googlechat:spaces/AAA", principals: [EVA], checkedAt: subject.now() }, IMPORT, ctx);
      expect(await projects.roleOf(space, [EVA], ctx), "member", "a later sync restores it");
      await projects.syncMembers(space, { source: "googlechat:spaces/AAA", principals: [], checkedAt: subject.now() + 1 }, IMPORT, ctx);
      expect(await projects.roleOf(space, [EVA], ctx), undefined, "gone when the source no longer has them");
    }),
    one("an agent acts only in its own space, reads and adds links, and writes nothing people write", async (subject) => {
      const { projects, ctx } = subject;
      const space = await shared(subject);
      const other = (await projects.create({ name: "Other" }, people(LUIS), ctx)).space;
      const agent: Caller = { kind: "agent", agent: "trader", conversation: "web:u-ana:c-1", space, for: ANA };
      check((await projects.context(space, undefined, agent, ctx)) !== undefined, "its project's context");
      expect((await outcome(() => projects.context(other, undefined, agent, ctx))).code, "forbidden", "another space's context");
      expect((await outcome(() => projects.addLink(other, { url: "https://example.com/a", title: "A" }, agent, ctx))).code, "forbidden", "a link in another space");
      const link = await projects.addLink(space, { url: "https://docs.example.com/sheet", title: "Sheet" }, agent, ctx);
      expect(link.by, { kind: "agent", agent: "trader", conversation: "web:u-ana:c-1", for: ANA } satisfies Author, "the link's author is the agent, its chat and the person it answered");
      expect((await projects.addLink(space, { url: "https://docs.example.com/sheet", title: "Again" }, agent, ctx)).id, link.id, "idempotent by URL");
      const refused: [string, () => Promise<unknown>][] = [
        ["setInstructions", () => projects.setInstructions(space, { text: "x", ifVersion: 0 }, agent, ctx)],
        ["putDocument", () => projects.putDocument(space, { title: "x", text: "x", mode: "reference" }, agent, ctx)],
        ["removeLink", () => projects.removeLink(space, link.id, agent, ctx)],
        ["addMember", () => projects.addMember(space, STRANGER, agent, ctx)],
        ["update", () => projects.update(space, { name: "x" }, agent, ctx)],
        ["restore", () => projects.restore(space, 1, agent, ctx)],
      ];
      for (const [what, attempt] of refused) expect((await outcome(attempt)).code, "forbidden", `an agent's ${what}`);
    }),
    one("restore brings back a document's and the instructions' exact earlier state, as a new version", async (subject) => {
      const { projects, ctx } = subject;
      const space = await shared(subject);
      const v1 = await projects.putDocument(space, { title: "Brief", text: "Version one.", mode: "core" }, people(ANA), ctx);
      await projects.putDocument(space, { id: v1.id, title: "Brief 2", text: "Version two.", mode: "reference", ifVersion: v1.version }, people(LUIS), ctx);
      const changed = (await allChanges(projects, space, people(ANA), ctx)).at(-1) as Change;
      await projects.restore(space, changed.n, people(LUIS), ctx);
      const read = await projects.read(space, v1.id, { part: 1 }, people(ANA), ctx);
      const same = (document: ProjectDocument | undefined) => [document?.title, document?.mode, document?.source];
      expect([...same(read?.document), read?.text], [...same(v1), "Version one."], "the document as it was (title, mode, source, text)");
      check((read?.document.version ?? 0) > 2, "restored as a new version");
      const i1 = await projects.setInstructions(space, { text: "First.", ifVersion: 0 }, people(ANA), ctx);
      await projects.setInstructions(space, { text: "Second.", ifVersion: i1.version }, people(LUIS), ctx);
      const second = (await allChanges(projects, space, people(ANA), ctx)).at(-1) as Change;
      const restored = await projects.restore(space, second.n, people(LUIS), ctx);
      expect((await projects.instructions(space, {}, people(ANA), ctx))?.text, "First.", "the instructions as they were");
      expect([restored.action, restored.restores], ["restored", second.n], "a restored entry");
    }),
    one("members cannot rewrite the log: owner's changes are the owner's to restore, redact is operators'", async (subject) => {
      const { projects, ctx } = subject;
      const space = await shared(subject);
      await projects.addMember(space, EVA, people(LUIS), ctx);
      await projects.removeMember(space, EVA, people(ANA), ctx);
      const removal = (await allChanges(projects, space, people(ANA), ctx)).at(-1) as Change;
      expect(removal.item.kind, "member", "a member's removal logged");
      expect((await outcome(() => projects.restore(space, removal.n, people(LUIS), ctx))).code, "forbidden", "a member undoing the owner's removal");
      const before = (await allChanges(projects, space, people(ANA), ctx)).map((entry) => JSON.stringify(entry));
      await projects.restore(space, removal.n, people(ANA), ctx);
      const after = (await allChanges(projects, space, people(ANA), ctx)).map((entry) => JSON.stringify(entry));
      expect(after.slice(0, before.length), before, "earlier entries unchanged");
      expect(await projects.roleOf(space, [EVA], ctx), "member", "the owner's restore brought them back");
      await projects.redact(space, 1, OPERATOR, ctx);
      const redacted = (await allChanges(projects, space, people(ANA), ctx))[0];
      expect([redacted?.restorable, redacted?.redacted?.by], [false, { kind: "operator", id: "admin" }], "an operator's redaction, shown");
    }),
    one("a write behind the current version is a conflict, the newer text kept", async (subject) => {
      const { projects, ctx } = subject;
      const space = await shared(subject);
      await projects.setInstructions(space, { text: "Ana's words.", ifVersion: 0 }, people(ANA), ctx);
      expect((await outcome(() => projects.setInstructions(space, { text: "Luis's words.", ifVersion: 0 }, people(LUIS), ctx))).code, "conflict", "a save behind");
      expect((await projects.instructions(space, {}, people(LUIS), ctx))?.text, "Ana's words.", "the newer kept");
    }),
    one("core documents fit the budget: one past it is refused, saying what is left", async (subject) => {
      const { projects, ctx } = subject;
      const space = await shared(subject);
      const result = await outcome(() => projects.putDocument(space, { title: "Huge", text: "word ".repeat(subject.coreTokens), mode: "core" }, people(ANA), ctx));
      expect(result.code, "limit", "a core document past coreTokens");
      check(/\d/.test(result.message), "the refusal says how many tokens are left");
      await projects.putDocument(space, { title: "Huge", text: "word ".repeat(subject.coreTokens), mode: "reference" }, people(ANA), ctx);
    }),
    one("search stays in its project and never errs on syntax", async (subject) => {
      const { projects, ctx } = subject;
      const space = await shared(subject);
      const other = (await projects.create({ name: "Other" }, people(STRANGER), ctx)).space;
      await projects.putDocument(space, { title: "Media plan", text: "The target CPA is 18 EUR for search campaigns.", mode: "reference" }, people(ANA), ctx);
      await projects.putDocument(other, { title: "Secret plan", text: "zanzibar campaigns", mode: "reference" }, people(STRANGER), ctx);
      const hits = await projects.search(space, "target CPA", 5, people(LUIS), ctx);
      check(hits.some((hit) => hit.kind === "document" && hit.ref.startsWith("document:") && hit.snippet.includes("[")), "a typed hit with a marked snippet");
      expect(await projects.search(space, "zanzibar", 5, people(LUIS), ctx), [], "another project's words never found");
      for (const query of ['ana@example.com "quoted', "https://x.example.com/a?b=c", "co-op AND OR NOT (", '"', "*"]) await projects.search(space, query, 5, people(LUIS), ctx);
    }),
    one("credentials are refused and never echoed", async (subject) => {
      const { projects, ctx } = subject;
      const space = await shared(subject);
      const attempts: [string, () => Promise<unknown>][] = [
        ["instructions", () => projects.setInstructions(space, { text: `Use ${SECRET} to log in.`, ifVersion: 0 }, people(ANA), ctx)],
        ["a document", () => projects.putDocument(space, { title: "Keys", text: `key: ${SECRET}`, mode: "reference" }, people(ANA), ctx)],
        ["a link", () => projects.addLink(space, { url: `https://example.com/?key=${SECRET}`, title: "Link" }, people(ANA), ctx)],
        ["a name", () => projects.update(space, { name: SECRET }, people(ANA), ctx)],
      ];
      for (const [what, attempt] of attempts) {
        const result = await outcome(attempt);
        expect(result.code, "refused", `${what} holding a credential`);
        check(!result.message.includes(SECRET), `the refusal of ${what} never echoes it`);
      }
    }),
    one("a malformed caller is invalid", async (subject) => {
      const { projects, ctx } = subject;
      const space = await shared(subject);
      expect((await outcome(() => projects.get(space, { kind: "people", principals: [] }, ctx))).code, "invalid", "people with no principal");
      expect((await outcome(() => projects.get(space, { kind: "robot" } as unknown as Caller, ctx))).code, "invalid", "an unknown kind");
    }),
    one("context is whole, then unchanged for the version held, whole again after a change", async (subject) => {
      const { projects, ctx } = subject;
      const space = await shared(subject);
      const component: Caller = { kind: "component", name: "projects-context" };
      const first = await projects.context(space, undefined, component, ctx);
      if (first === undefined || first === "unchanged") throw new Error(`${GROUP}: expected the whole context`);
      expect(await projects.context(space, first.project.version, component, ctx), "unchanged", "unchanged for the version held");
      await projects.addLink(space, { url: "https://example.com/new", title: "New" }, people(LUIS), ctx);
      const again = await projects.context(space, first.project.version, component, ctx);
      check(again !== "unchanged" && again !== undefined && again.links.length === 1, "whole again after a change");
      expect(await projects.context("project:none", undefined, component, ctx), undefined, "a space with no project");
    }),
    one("a removed project is gone for everyone but operators, who recover it", async (subject) => {
      const { projects, ctx } = subject;
      const space = await shared(subject);
      await projects.remove(space, people(ANA), ctx);
      expect(await projects.get(space, people(ANA), ctx), undefined, "gone for its owner");
      check((await projects.get(space, OPERATOR, ctx))?.removedAt !== undefined, "an operator sees it removed");
      await projects.recover(space, OPERATOR, ctx);
      expect((await projects.get(space, people(ANA), ctx))?.role, "owner", "recovered");
    }),
    one("everything is kept across a restart", async (subject) => {
      if (subject.restart === undefined) return;
      const { ctx } = subject;
      const space = await shared(subject);
      await subject.projects.putDocument(space, { title: "Plan", text: "The target CPA is 18 EUR.", mode: "reference" }, people(ANA), ctx);
      const before = await contents(subject.projects, space, ctx);
      const projects = await subject.restart();
      expect(await contents(projects, space, ctx), before, "the same project after a restart");
      check((await projects.search(space, "CPA", 5, people(ANA), ctx)).length > 0, "search after a restart");
    }),
  ];

  // The change log's own cases, over documents written by three members.
  const documentsLog = async (): Promise<ChangeLogSubject> => {
    const subject = await fixture();
    const { projects, ctx } = subject;
    const space = await shared(subject);
    await projects.addMember(space, EVA, people(ANA), ctx);
    const callerOf = (by: Author): Caller => {
      if (by.kind !== "person") throw new Error(`${GROUP}: documents are written by people`);
      return people(by.principal);
    };
    let count = 0;
    const offset = (await allChanges(projects, space, people(ANA), ctx)).length;
    return {
      async add(by) {
        return (await projects.putDocument(space, { title: `Doc ${++count}`, text: `Text ${count}.`, mode: "reference" }, callerOf(by), ctx)).id;
      },
      async change(id, by) {
        const current = (await projects.documents(space, people(ANA), ctx)).find((document) => document.id === id) as ProjectDocument;
        await projects.putDocument(space, { id, title: `${current.title}*`, text: `Text ${++count}.`, mode: current.mode === "core" ? "reference" : "core", ifVersion: current.version }, callerOf(by), ctx);
      },
      async remove(id, by) {
        await projects.removeDocument(space, id, callerOf(by), ctx);
      },
      async restore(n, by) {
        return projects.restore(space, n + offset, callerOf(by), ctx).then((change) => ({ ...change, n: change.n - offset, ...(change.restores !== undefined && { restores: change.restores - offset }) }));
      },
      async state(id) {
        const read = await projects.read(space, id, { part: 1 }, people(ANA), ctx);
        return read === undefined ? undefined : { title: read.document.title, mode: read.document.mode, text: read.text };
      },
      async changes() {
        return (await allChanges(projects, space, people(ANA), ctx)).slice(offset).map((change) => ({ ...change, n: change.n - offset, ...(change.restores !== undefined && { restores: change.restores - offset }) }));
      },
      close: () => subject.close(),
    };
  };
  const member = (principal: Principal): Author => ({ kind: "person", principal });
  cases.push(...changeLogCases(GROUP, documentsLog, { first: member(ANA), second: member(LUIS), third: member(EVA), operator: { kind: "operator", id: "admin" } }));
  return cases;
}

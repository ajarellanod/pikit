/**
 * `conversations.directory` conformance (`../conversation-directory.ts`): what every provider guarantees
 * to its views (admin-api, channel-web), with the note's adversarial cases
 * (features/completed/conversation-directory.md, "Authorization"). Runner-independent:
 *
 *   for (const c of createConversationDirectoryConformance((options) => myFixture(options)))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The fixture opens a provider with an empty store in an App that includes `options.components` (the
 * suite's own stage of `conversation.audience`, which says who belongs to which space) and whose clock
 * (`ctx.clock`) the case moves. The suite drives the conversations through the subject as the runtime
 * would (a message admitted, a run started and ended, a reset), and the subject records them through
 * the provider's real recorder (its listeners of `agent.dispatched`, `agent.started`, `agent.settled`,
 * `agent.failed` and `conversation.reset`, with `conversations.registry` holding the place), resolving
 * once the directory holds them (a flush). Also here: `createMemoryDirectory`, an in-memory double that
 * passes the suite, for the views' own tests.
 */

import { type AppContext, type ComponentDefinition, defineComponent } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { Sender } from "../agent.ts";
import { type Author, type Principal, principalKey } from "../change.ts";
import { type AudienceGrant, audienceGrants, audienceStage } from "../conversation-audience.ts";
import {
  AUDIENCE_MAX,
  afterCursor,
  compareDirectoryOrder,
  type ConversationDirectory,
  DIRECTORY_COUNT_MAX,
  DIRECTORY_PAGE_MAX,
  DIRECTORY_SEARCH_MAX,
  type DirectoryEntry,
  DirectoryError,
  type DirectoryListState,
  type DirectoryQuery,
  type DirectoryRole,
  directoryCursor,
  type EntryRef,
  type EntryState,
  isEntryState,
  listStateOf,
  matchesSearch,
  parseDirectoryCursor,
  parseDirectoryQuery,
  parseViewer,
  permissionsOf,
  stillHidden,
  TITLE_MAX,
  type TitleSource,
  titleApplies,
  UNREAD_MAX,
  type Viewer,
  type ViewerChange,
  viewerAuthor,
  viewerKey,
  viewerOwns,
  viewerPrincipals,
  cleanTitle,
} from "../conversation-directory.ts";
import { answersOnlyTheDashboard, isDashboardRequest } from "../delivery.ts";
import type { Page } from "../page.ts";
import { checker, expecter } from "./assert.ts";

/** Where a conversation belongs, as its channel gives it with the key's first message (`conversations.registry`'s record). */
export type DirectoryPlace = {
  agent: string;
  channel: string;
  space?: string;
  owner?: Principal;
  /** A delegated task's conversation (`ConversationRef.origin` set). */
  delegated?: boolean;
};

/** A message admitted to a key, as `agent.dispatched` gives it. */
export type DirectoryMessage = {
  requestId: string;
  /** `agent.dispatched`'s `sender`; absent: unknown. */
  sender?: Sender;
  /** Recorded with the key's first message only (the registry keeps it for good). */
  place: DirectoryPlace;
  /** Admitted as a duplicate (`admission.kind` `duplicate`): no activity. */
  duplicate?: boolean;
};

/** A provider under test, with an empty store, for one case. */
export interface ConversationDirectorySubject {
  directory: ConversationDirectory;
  /** The App's context (what the views call with), the suite's audience stage installed. */
  ctx: AppContext;
  /** Moves the App's clock (`ctx.clock`) forward by `ms`. */
  advance(ms: number): Promise<void>;
  /** A message admitted to `key` (its first: the key resolved with `message.place`), recorded; answers the conversation it went to. */
  message(key: string, message: DirectoryMessage): Promise<EntryRef>;
  /** `agent.started` of `requestId`'s run, recorded. */
  started(ref: EntryRef, requestId: string): Promise<void>;
  /** The end of the run that took `requestIds` (the first started it): `agent.settled`, or `agent.failed`, recorded. */
  settled(ref: EntryRef, requestIds: readonly string[], kind?: "completed" | "aborted" | "failed"): Promise<void>;
  /** `conversations.registry.reset(key)` (and its `conversation.reset`), recorded; answers the new conversation. */
  reset(key: string): Promise<EntryRef>;
  /** Delivers every update the directory already took again, late, newest first: `seen`'s idempotence (a stale `started` after its run's end). */
  replay?(): Promise<void>;
  /** Stops the provider and starts it again over the same storage: the new directory. */
  restart?(): Promise<ConversationDirectory>;
  close(): Promise<void>;
}

export type ConversationDirectoryFixture = (options: { components: readonly ComponentDefinition[] }) => Promise<ConversationDirectorySubject>;

const GROUP = "conversations.directory";
const expect = expecter(GROUP);
const check = checker(GROUP);

const ANA: Principal = { channel: "web", id: "u-ana" };
const ANA_CHAT: Principal = { channel: "googlechat", id: "users/7" };
const LUIS: Principal = { channel: "web", id: "u-luis" };
const EVA: Principal = { channel: "web", id: "u-eva" };
const STRANGER: Principal = { channel: "web", id: "u-mallory" };
const people = (...principals: Principal[]): Viewer => ({ kind: "people", principals });
const OPERATOR: Viewer = { kind: "operator", id: "op-1" };
const OTHER_OPERATOR: Viewer = { kind: "operator", id: "op-2" };
const COMPONENT: Viewer = { kind: "component", name: "conformance" };
const PROJECT = "project:p1";
const OTHER_PROJECT = "project:p2";
const AGENT = "assistant";

const sender = (principal: Principal): Sender => ({ channel: principal.channel, id: principal.id });
const webPlace = (owner: Principal, space?: string): DirectoryPlace => ({ agent: AGENT, channel: "web", owner, ...(space !== undefined && { space }) });

/** What the suite's stage of `conversation.audience` answers, which the case sets. */
type AudienceControl = {
  /** principalKey -> grants, as a list sees them (the list bound). */
  list: Map<string, { space: string; role: "member" | "owner" }[]>;
  /** principalKey -> grants, as checked now (the fresh bound). */
  fresh: Map<string, { space: string; role: "member" | "owner" }[]>;
  throws: boolean;
  foreign: boolean;
  flood: boolean;
};

const codeOf = (error: unknown) => (typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined);

/** The code `work` rejects with, or `"resolved"`. */
async function outcome(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
    return "resolved";
  } catch (error) {
    return codeOf(error);
  }
}

/** Every entry of a bucket, page by page (`limit` a page), checking that no entry comes twice. */
async function listAll(directory: ConversationDirectory, viewer: Viewer, query: DirectoryQuery, ctx: AppContext, limit = DIRECTORY_PAGE_MAX): Promise<DirectoryEntry[]> {
  const all: DirectoryEntry[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 1000; pages++) {
    const page: Page<DirectoryEntry> = await directory.list(viewer, { ...query, limit, ...(cursor !== undefined && { cursor }) }, ctx);
    check(page.items.length <= limit, `a page of at most ${limit} entries (got ${page.items.length})`);
    all.push(...page.items);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  const ids = all.map((entry) => `${entry.key} ${entry.conversationId}`);
  check(new Set(ids).size === ids.length, `no entry listed twice (got ${JSON.stringify(ids)})`);
  return all;
}

const keysOf = (entries: readonly DirectoryEntry[]): string[] => entries.map((entry) => entry.key);
const has = (entries: readonly DirectoryEntry[], ref: EntryRef): boolean => entries.some((entry) => entry.key === ref.key && entry.conversationId === ref.conversationId);

export function createConversationDirectoryConformance(fixture: ConversationDirectoryFixture): readonly ConformanceCase[] {
  type Case = { subject: ConversationDirectorySubject; directory: ConversationDirectory; ctx: AppContext; audience: AudienceControl; grant(principal: Principal, space: string, role?: "member" | "owner"): void };
  const one = (name: string, run: (c: Case) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    async run() {
      const audience: AudienceControl = { list: new Map(), fresh: new Map(), throws: false, foreign: false, flood: false };
      const stage = defineComponent({
        name: "conversation-directory-conformance",
        setup(pikit) {
          pikit.pipeline(
            "conversation.audience",
            audienceStage("conformance", {
              async grants(principals, space) {
                if (audience.throws) throw new Error("the membership provider is down");
                if (audience.flood) return Array.from({ length: AUDIENCE_MAX + 1 }, (_, n) => ({ space: `flood:${n}`, role: "member" as const }));
                const from = space === undefined ? audience.list : audience.fresh;
                const grants = principals.flatMap((principal) => from.get(principalKey(principal)) ?? []).filter((grant) => space === undefined || grant.space === space);
                return audience.foreign ? grants.map((grant) => ({ ...grant, source: "someone-else" })) : grants;
              },
            }),
            { id: "conformance" },
          );
        },
      });
      const subject = await fixture({ components: [stage] });
      const grant = (principal: Principal, space: string, role: "member" | "owner" = "member") => {
        for (const map of [audience.list, audience.fresh]) map.set(principalKey(principal), [...(map.get(principalKey(principal)) ?? []), { space, role }]);
      };
      try {
        await run({ subject, directory: subject.directory, ctx: subject.ctx, audience, grant });
      } finally {
        await subject.close();
      }
    },
  });

  let requests = 0;
  /** A message by `who` to `key` (a person's chat: owner `owner`, in `space`), then its run, answered. */
  const talk = async (subject: ConversationDirectorySubject, key: string, who: Principal, place: DirectoryPlace): Promise<EntryRef> => {
    const requestId = `r-${++requests}`;
    const ref = await subject.message(key, { requestId, sender: sender(who), place });
    await subject.started(ref, requestId);
    await subject.settled(ref, [requestId]);
    await subject.advance(10);
    return ref;
  };
  /** An operator's follow-up from the dashboard in `key`, and its run. */
  const operatorTalk = async (subject: ConversationDirectorySubject, key: string, place: DirectoryPlace): Promise<EntryRef> => {
    const requestId = `dashboard:op-1:${++requests}`;
    const ref = await subject.message(key, { requestId, sender: { channel: "dashboard", id: "op-1" }, place });
    await subject.started(ref, requestId);
    await subject.settled(ref, [requestId]);
    await subject.advance(10);
    return ref;
  };
  /** A project (`PROJECT`) owned by Eva, Luis a member, with a chat of Luis's in it. */
  const project = async ({ subject, grant }: Case): Promise<EntryRef> => {
    grant(EVA, PROJECT, "owner");
    grant(LUIS, PROJECT, "member");
    return talk(subject, "web:u-luis:p1", LUIS, webPlace(LUIS, PROJECT));
  };
  const entryOf = async (c: Case, viewer: Viewer, ref: { key: string; conversationId?: string }): Promise<DirectoryEntry> => {
    const entry = await c.directory.access(viewer, ref, c.ctx);
    if (entry === undefined) throw new Error(`${GROUP}: ${JSON.stringify(ref)} to be seen by ${JSON.stringify(viewer)}`);
    return entry;
  };

  const cases: ConformanceCase[] = [
    one("lists newest activity first, ties by key then conversation id, every entry once across pages", async (c) => {
      const refs: EntryRef[] = [];
      for (const [n, tie] of [[1, false], [2, true], [3, true], [4, false], [5, true], [6, false], [7, true]] as const) {
        const requestId = `order-${n}`;
        refs.push(await c.subject.message(`web:u-ana:order-${n}`, { requestId, sender: sender(ANA), place: webPlace(ANA) }));
        if (!tie) await c.subject.advance(5);
      }
      const all = await listAll(c.directory, OPERATOR, {}, c.ctx);
      expect(all.length, 7, "the operator's list");
      for (let i = 1; i < all.length; i++) check(compareDirectoryOrder(all[i - 1] as DirectoryEntry, all[i] as DirectoryEntry) < 0, `the list in compareDirectoryOrder's order (got ${JSON.stringify(keysOf(all))})`);
      for (const limit of [1, 2, 3]) expect(keysOf(await listAll(c.directory, OPERATOR, {}, c.ctx, limit)), keysOf(all), `the list paged by ${limit}`);
      // New activity brings a conversation first, also between two pages.
      const first = await c.directory.list(OPERATOR, { limit: 3 }, c.ctx);
      await c.subject.advance(5);
      await c.subject.message("web:u-ana:order-1", { requestId: "order-again", sender: sender(ANA), place: webPlace(ANA) });
      const rest = await listAll(c.directory, OPERATOR, { ...(first.next !== undefined && { cursor: first.next }) }, c.ctx);
      expect(keysOf(rest), ["web:u-ana:order-4", "web:u-ana:order-3", "web:u-ana:order-2"], "the entries after the first page: the one that moved is not among them, none repeated nor skipped");
      expect(keysOf((await c.directory.list(OPERATOR, { limit: 1 }, c.ctx)).items), ["web:u-ana:order-1"], "the conversation with the newest activity");
      expect(keysOf(await listAll(c.directory, people(ANA), {}, c.ctx, 2)), keysOf(await listAll(c.directory, OPERATOR, {}, c.ctx)), "Ana's own list, in the same order");
    }),

    one("refuses a cursor not of this order, a page or search out of bounds, and a malformed viewer", async (c) => {
      await talk(c.subject, "web:u-ana:a", ANA, webPlace(ANA));
      for (const cursor of ["nonsense", "1:a", "x:a:b", `1:a:b:c`]) expect(await outcome(() => c.directory.list(OPERATOR, { cursor }, c.ctx)), "invalid_cursor", `a list after the cursor ${JSON.stringify(cursor)}`);
      for (const query of [{ limit: 0 }, { limit: DIRECTORY_PAGE_MAX + 1 }, { q: "x".repeat(DIRECTORY_SEARCH_MAX + 1) }, { state: "gone" as DirectoryListState }])
        expect(await outcome(() => c.directory.list(OPERATOR, query, c.ctx)), "invalid", `a list with ${JSON.stringify(query).slice(0, 60)}`);
      const malformed: unknown[] = [
        { kind: "people", principals: [] },
        { kind: "people", principals: Array.from({ length: 21 }, (_, n) => ({ channel: "web", id: `u${n}` })) },
        { kind: "people", principals: [{ channel: "dashboard", id: "op-1" }] },
        { kind: "people", principals: [ANA, { channel: "delegate", id: "x" }] },
        { kind: "people", principals: [{ channel: "web", id: "" }] },
        { kind: "operator", id: "" },
        { kind: "agent", agent: AGENT },
        null,
      ];
      for (const viewer of malformed) {
        expect(await outcome(() => c.directory.list(viewer as Viewer, {}, c.ctx)), "invalid", `a list for the viewer ${JSON.stringify(viewer)?.slice(0, 60)}`);
        expect(await outcome(() => c.directory.access(viewer as Viewer, { key: "web:u-ana:a" }, c.ctx)), "invalid", `access for the viewer ${JSON.stringify(viewer)?.slice(0, 60)}`);
      }
      expect(await outcome(() => c.directory.count(OPERATOR, Array.from({ length: DIRECTORY_COUNT_MAX + 1 }, (_, n) => `s${n}`), c.ctx)), "invalid", "a count of too many spaces");
      expect(await outcome(() => c.directory.list(COMPONENT, { owned: true }, c.ctx)), "invalid", "a component asking for what it owns");
    }),

    one("people see what they own and the spaces their grants name; operators and components see everything", async (c) => {
      const mine = await talk(c.subject, "web:u-ana:1", ANA, webPlace(ANA));
      const chat = await talk(c.subject, "googlechat:spaces/A:t1", ANA_CHAT, { agent: AGENT, channel: "googlechat", owner: ANA_CHAT, space: "googlechat:spaces/A" });
      const shared = await project(c);
      const other = await talk(c.subject, "web:u-eva:2", EVA, webPlace(EVA, OTHER_PROJECT));
      expect(keysOf(await listAll(c.directory, people(ANA), {}, c.ctx)).sort(), [mine.key], "Ana's list (her web identity only)");
      expect(keysOf(await listAll(c.directory, people(ANA, ANA_CHAT), {}, c.ctx)).sort(), [chat.key, mine.key].sort(), "Ana's list with both her identities");
      expect(keysOf(await listAll(c.directory, people(LUIS), {}, c.ctx)), [shared.key], "Luis's list (his chat in the project)");
      expect(keysOf(await listAll(c.directory, people(EVA), {}, c.ctx)).sort(), [other.key, shared.key].sort(), "Eva's list (her own, and her project's)");
      expect(keysOf(await listAll(c.directory, people(STRANGER), {}, c.ctx)), [], "a stranger's list");
      for (const viewer of [OPERATOR, COMPONENT]) expect((await listAll(c.directory, viewer, {}, c.ctx)).length, 4, `${viewer.kind}'s list`);
      expect([(await entryOf(c, people(EVA), shared)).role, (await entryOf(c, people(LUIS), shared)).role, (await entryOf(c, OPERATOR, shared)).role, (await entryOf(c, COMPONENT, shared)).role], ["space-owner", "owner", "operator", "component"], "the roles on Luis's project chat");
      const seen = await entryOf(c, people(LUIS), shared);
      expect([seen.channel, seen.agent, seen.space, seen.owner?.id, seen.current, seen.state], ["web", AGENT, PROJECT, "u-luis", true, "listed"], "the entry's place and state");
      check(seen.createdAt > 0 && seen.lastActivity >= seen.createdAt, "createdAt and lastActivity set");
    }),

    one("another's conversation is not found by key nor by id, and a key with another's conversation id is nobody's", async (c) => {
      const ana = await talk(c.subject, "web:u-ana:1", ANA, webPlace(ANA));
      const luis = await talk(c.subject, "web:u-luis:1", LUIS, webPlace(LUIS));
      expect(await c.directory.access(people(STRANGER), { key: ana.key }, c.ctx), undefined, "a stranger's access to Ana's chat by key");
      expect(await c.directory.access(people(LUIS), ana, c.ctx), undefined, "Luis's access to Ana's chat by its ref");
      // An id this key does not have (on Cloudflare each object numbers its own conversations, "1", "2"…, so another
      // key's id may well be this key's own): never Luis's own, never anyone's on a key with no conversation at all.
      const notLuis = `${ana.conversationId}-not-${luis.conversationId}`;
      expect(await c.directory.access(people(LUIS), { key: luis.key, conversationId: notLuis }, c.ctx), undefined, "Luis's key with an id it does not have");
      expect(await c.directory.access(OPERATOR, { key: "googlechat:spaces/A:t1", conversationId: ana.conversationId }, c.ctx), undefined, "a key with no conversation, with Ana's conversation id");
      for (const act of [
        () => c.directory.rename(people(LUIS), ana, "Mine now", c.ctx),
        () => c.directory.setState(people(LUIS), ana, "deleted", c.ctx),
        () => c.directory.mine(people(LUIS), ana, { hidden: true }, c.ctx),
        () => c.directory.rename(OPERATOR, { key: "web:u-nobody:1", conversationId: "none" }, "Nothing", c.ctx),
      ])
        expect(await outcome(act), "not_found", "an act on a conversation not seen");
      expect((await entryOf(c, people(ANA), ana)).title, undefined, "Ana's chat, untouched");
    }),

    one("a delegated conversation, one with only an operator's activity, and a reset's previous one are never listed to people", async (c) => {
      c.grant(LUIS, PROJECT);
      const delegated = await talk(c.subject, "delegate:task-1", LUIS, { agent: AGENT, channel: "delegate", owner: LUIS, space: PROJECT, delegated: true });
      const quiet = await operatorTalk(c.subject, "web:u-luis:quiet", webPlace(LUIS, PROJECT));
      const before = await talk(c.subject, "web:u-luis:new", LUIS, webPlace(LUIS));
      const after = await c.subject.reset(before.key);
      check(after.conversationId !== before.conversationId, "a reset to give a new conversation");
      expect(keysOf(await listAll(c.directory, people(LUIS), {}, c.ctx)), [], "Luis's list: none of them");
      expect(await c.directory.access(people(LUIS), delegated, c.ctx), undefined, "Luis's access to the delegated task");
      expect(await c.directory.access(people(LUIS), quiet, c.ctx), undefined, "Luis's access to a chat only an operator wrote in");
      expect(await c.directory.access(people(LUIS), before, c.ctx), undefined, "Luis's access to the reset's previous conversation");
      expect(await c.directory.access(people(LUIS), { key: before.key }, c.ctx), undefined, "Luis's access to the key, its new conversation still empty");
      const operators = await listAll(c.directory, OPERATOR, {}, c.ctx);
      check(has(operators, delegated) && has(operators, quiet) && has(operators, before), "the operator's list to hold all three");
      check(!has(operators, after), "no list to hold a conversation with no activity yet");
      expect((await entryOf(c, OPERATOR, before)).current, false, "the previous conversation's current");
      const again = await talk(c.subject, before.key, LUIS, webPlace(LUIS));
      expect(again, after, "the key's next message, in the new conversation");
      expect(keysOf(await listAll(c.directory, people(LUIS), {}, c.ctx)), [before.key], "Luis's list once the new conversation has a message");
      expect((await entryOf(c, people(LUIS), { key: before.key })).conversationId, after.conversationId, "the key's current conversation");
    }),

    one("a member removed from a space is refused at once, by access and by every act", async (c) => {
      const shared = await project(c);
      const talker = await talk(c.subject, "web:u-eva:p1", EVA, webPlace(EVA, PROJECT));
      check((await c.directory.access(people(LUIS), talker, c.ctx)) !== undefined, "Luis to see Eva's chat while a member");
      c.audience.fresh.delete(principalKey(LUIS)); // removed now; a list may still show it within its bound
      expect(await c.directory.access(people(LUIS), talker, c.ctx), undefined, "a removed member's access");
      for (const act of [() => c.directory.mine(people(LUIS), talker, { readUpTo: 1 }, c.ctx), () => c.directory.setState(people(LUIS), talker, "archived", c.ctx)])
        expect(await outcome(act), "not_found", "a removed member's act");
      check((await c.directory.access(people(LUIS), shared, c.ctx)) !== undefined, "Luis to keep his own chat");
    }),

    one("rename, archive and delete for everyone: a member none, a space's owner renames and archives, never deletes; the owner and operators all", async (c) => {
      const shared = await project(c);
      const eva = await talk(c.subject, "web:u-eva:p1", EVA, webPlace(EVA, PROJECT));
      const member = await entryOf(c, people(LUIS), eva);
      expect([member.role, member.may], ["member", { rename: false, archive: false, delete: false }], "Luis on Eva's chat");
      for (const act of [() => c.directory.rename(people(LUIS), eva, "Luis's name", c.ctx), () => c.directory.setState(people(LUIS), eva, "archived", c.ctx), () => c.directory.setState(people(LUIS), eva, "deleted", c.ctx)])
        expect(await outcome(act), "forbidden", "a member's act for everyone on another's chat");
      const spaceOwner = await entryOf(c, people(EVA), shared);
      expect([spaceOwner.role, spaceOwner.may], ["space-owner", { rename: true, archive: true, delete: false }], "Eva on Luis's chat");
      expect(await outcome(() => c.directory.setState(people(EVA), shared, "deleted", c.ctx)), "forbidden", "the space's owner deleting a member's chat");
      expect((await c.directory.rename(people(EVA), shared, "Budget review", c.ctx)).title, "Budget review", "the space's owner's rename");
      expect((await c.directory.setState(people(EVA), shared, "archived", c.ctx)).state, "archived", "the space's owner's archive");
      expect((await c.directory.setState(people(EVA), shared, "listed", c.ctx)).state, "listed", "the space's owner's unarchive");
      const owner = await entryOf(c, people(LUIS), shared);
      expect([owner.role, owner.may], ["owner", { rename: true, archive: true, delete: true }], "Luis on his own chat");
      expect((await c.directory.setState(people(LUIS), shared, "deleted", c.ctx)).state, "deleted", "the owner's delete");
      expect([(await entryOf(c, OPERATOR, eva)).may, (await entryOf(c, COMPONENT, eva)).may], [permissionsOf("operator"), permissionsOf("component")], "operators and components on any chat");
      expect((await c.directory.setState(OPERATOR, eva, "deleted", c.ctx)).state, "deleted", "an operator's delete");
      expect((await c.directory.setState(OPERATOR, eva, "listed", c.ctx)).state, "listed", "an operator setting a deleted conversation back");
    }),

    one("one title: first < model < rename; a title before the conversation's first message applies; a text that cleans to nothing writes nothing", async (c) => {
      const ana = await talk(c.subject, "web:u-ana:1", ANA, webPlace(ANA));
      const title = async () => {
        const entry = await entryOf(c, OPERATOR, ana);
        return [entry.title, entry.titleSource];
      };
      await c.directory.title(ana, { text: "  plan the trip to Lisbon.\nmore", source: "first" }, c.ctx);
      expect(await title(), ["Plan the trip to Lisbon", "first"], "the first message's title, cleaned");
      await c.directory.title(ana, { text: "Title: \"Lisbon trip\"", source: "model" }, c.ctx);
      expect(await title(), ["Lisbon trip", "model"], "the model's title over the first");
      await c.directory.title(ana, { text: "a later first", source: "first" }, c.ctx);
      expect(await title(), ["Lisbon trip", "model"], "a first title never over the model's");
      await c.directory.title(ana, { text: "Lisbon, again", source: "model" }, c.ctx);
      expect(await title(), ["Lisbon, again", "model"], "a model's title over the model's");
      expect((await c.directory.rename(people(ANA), ana, "My trip", c.ctx)).title, "My trip", "the owner's rename");
      await c.directory.title(ana, { text: "Model again", source: "model" }, c.ctx);
      expect(await title(), ["My trip", "rename"], "a model's title never over a rename");
      expect((await c.directory.rename(OPERATOR, ana, "x".repeat(200), c.ctx)).title?.length, TITLE_MAX, "a long rename, cut to TITLE_MAX");
      expect(await outcome(() => c.directory.rename(OPERATOR, ana, "  \n ", c.ctx)), "invalid", "a rename that cleans to nothing");
      const kept = await title();
      await c.directory.title(ana, { text: " \"\" ", source: "model" }, c.ctx);
      expect(await title(), kept, "the title after a model's answer that cleans to nothing");
      // A reset's new conversation has its own title, and one given before its first message applies.
      const fresh = await c.subject.reset(ana.key);
      await c.directory.title(fresh, { text: "Before its message", source: "first" }, c.ctx);
      await talk(c.subject, ana.key, ANA, webPlace(ANA));
      expect((await entryOf(c, people(ANA), { key: ana.key })).title, "Before its message", "the title given before the new conversation's first message");
      expect((await entryOf(c, OPERATOR, ana)).title, kept[0], "the reset's previous conversation, its own title");
    }),

    one("hide, a name and a read mark are each viewer's own", async (c) => {
      const shared = await project(c);
      const hidden = await c.directory.mine(people(EVA), shared, { hidden: true, name: "Eva's budget" }, c.ctx);
      expect([hidden.mine?.hidden, hidden.mine?.name, hidden.title], [true, "Eva's budget", undefined], "Eva's own state, the title untouched");
      expect(keysOf(await listAll(c.directory, people(EVA), { state: "hidden" }, c.ctx)), [shared.key], "Eva's hidden list");
      expect(keysOf(await listAll(c.directory, people(EVA), {}, c.ctx)), [], "Eva's list");
      expect(keysOf(await listAll(c.directory, people(LUIS), {}, c.ctx)), [shared.key], "Luis's list, as it was");
      const luis = await entryOf(c, people(LUIS), shared);
      expect([luis.mine?.hidden, luis.mine?.name], [false, undefined], "Luis's own state");
      expect(keysOf(await listAll(c.directory, people(EVA), { state: "hidden", q: "eva's budget" }, c.ctx)), [shared.key], "Eva searching by her own name");
      expect(keysOf(await listAll(c.directory, people(LUIS), { q: "budget" }, c.ctx)), [], "Luis searching by Eva's name");
      expect(keysOf(await listAll(c.directory, OPERATOR, { q: "budget" }, c.ctx)), [], "an operator searching by Eva's name");
      await c.directory.mine(OPERATOR, shared, { hidden: true }, c.ctx);
      expect(keysOf(await listAll(c.directory, OTHER_OPERATOR, {}, c.ctx)), [shared.key], "another operator's list");
      expect(keysOf(await listAll(c.directory, OPERATOR, { state: "hidden" }, c.ctx)), [shared.key], "the operator's hidden list");
      const shown = await c.directory.mine(people(EVA), shared, { hidden: false, name: null }, c.ctx);
      expect([shown.mine?.hidden, shown.mine?.name], [false, undefined], "Eva's state undone");
      expect(await outcome(() => c.directory.mine(COMPONENT, shared, { hidden: true }, c.ctx)), "invalid", "a component's own state");
      expect(await outcome(() => c.directory.mine(people(EVA), shared, { name: " \n " }, c.ctx)), "invalid", "a name that cleans to nothing");
      expect(await outcome(() => c.directory.mine(people(EVA), shared, { readUpTo: -1 }, c.ctx)), "invalid", "a read mark before the epoch");
    }),

    one("hide for me ends with activity the viewer sees, never with an operator's", async (c) => {
      const shared = await project(c);
      await c.directory.mine(people(EVA), shared, { hidden: true }, c.ctx);
      await c.subject.advance(10);
      await operatorTalk(c.subject, shared.key, webPlace(LUIS, PROJECT));
      expect((await entryOf(c, people(EVA), shared)).mine?.hidden, true, "Eva's hidden chat after an operator's follow-up");
      await talk(c.subject, shared.key, LUIS, webPlace(LUIS, PROJECT));
      const back = await entryOf(c, people(EVA), shared);
      expect(back.mine?.hidden, false, "Eva's chat after Luis wrote in it");
      expect(keysOf(await listAll(c.directory, people(EVA), {}, c.ctx)), [shared.key], "Eva's list");
      await c.directory.mine(OPERATOR, shared, { hidden: true }, c.ctx);
      await c.subject.advance(10);
      await operatorTalk(c.subject, shared.key, webPlace(LUIS, PROJECT));
      expect((await entryOf(c, OPERATOR, shared)).mine?.hidden, false, "the operator's hidden chat after activity operators see");
    }),

    one("archive and delete are for everyone; an archived one comes back with activity people see, a deleted one never; people never list deleted", async (c) => {
      const shared = await project(c);
      const archived = await c.directory.setState(people(EVA), shared, "archived", c.ctx);
      expect([archived.state, archived.stateBy], ["archived", { kind: "person", principal: EVA } satisfies Author], "the state and who set it");
      check(archived.stateAt !== undefined, "stateAt set");
      for (const viewer of [people(LUIS), people(EVA), OPERATOR]) {
        expect(keysOf(await listAll(c.directory, viewer, {}, c.ctx)), [], `${JSON.stringify(viewer).slice(0, 40)}'s list`);
        expect(keysOf(await listAll(c.directory, viewer, { state: "archived" }, c.ctx)), [shared.key], `${JSON.stringify(viewer).slice(0, 40)}'s archived list`);
      }
      await c.subject.advance(10);
      await operatorTalk(c.subject, shared.key, webPlace(LUIS, PROJECT));
      expect((await entryOf(c, people(LUIS), shared)).state, "archived", "the state after an operator's follow-up");
      await talk(c.subject, shared.key, LUIS, webPlace(LUIS, PROJECT));
      const back = await entryOf(c, people(LUIS), shared);
      expect([back.state, back.stateAt, back.stateBy], ["listed", undefined, undefined], "the state after Luis wrote in it");
      expect((await c.directory.setState(people(LUIS), shared, "deleted", c.ctx)).state, "deleted", "Luis's delete");
      for (const viewer of [people(LUIS), people(EVA)]) {
        for (const state of ["listed", "archived", "hidden"] as const) expect(keysOf(await listAll(c.directory, viewer, { state }, c.ctx)), [], `people's ${state} list after the delete`);
        expect(await c.directory.access(viewer, shared, c.ctx), undefined, "people's access to a deleted conversation");
        expect(await outcome(() => c.directory.list(viewer, { state: "deleted" }, c.ctx)), "forbidden", "people asking for the deleted");
      }
      expect(keysOf(await listAll(c.directory, OPERATOR, { state: "deleted" }, c.ctx)), [shared.key], "the operator's deleted list");
      expect(keysOf(await listAll(c.directory, COMPONENT, { state: "deleted" }, c.ctx)), [shared.key], "a component's deleted list");
      await c.subject.settled(shared, ["late-run"]);
      expect((await entryOf(c, OPERATOR, shared)).state, "deleted", "a deleted conversation after a late run ended there");
    }),

    one("deleting a key's current conversation resets the key: the platform's next message starts a new conversation", async (c) => {
      const chat = await talk(c.subject, "googlechat:spaces/A:t1", ANA_CHAT, { agent: AGENT, channel: "googlechat", owner: ANA_CHAT, space: "googlechat:spaces/A" });
      await c.directory.title(chat, { text: "The old thread", source: "model" }, c.ctx);
      await c.directory.setState(OPERATOR, chat, "deleted", c.ctx);
      const old = await entryOf(c, OPERATOR, chat);
      expect([old.state, old.current], ["deleted", false], "the deleted conversation");
      const next = await talk(c.subject, chat.key, ANA_CHAT, { agent: AGENT, channel: "googlechat", owner: ANA_CHAT, space: "googlechat:spaces/A" });
      check(next.conversationId !== chat.conversationId, "the key's next message to go to a new conversation");
      const fresh = await entryOf(c, people(ANA_CHAT), { key: chat.key });
      expect([fresh.conversationId, fresh.state, fresh.title, fresh.current], [next.conversationId, "listed", undefined, true], "the key's new conversation, Ana's");
      expect((await entryOf(c, OPERATOR, chat)).state, "deleted", "the deleted one, still deleted");
      // A conversation that is not its key's current one is deleted without another reset.
      await c.directory.setState(OPERATOR, chat, "listed", c.ctx);
      await c.directory.setState(OPERATOR, chat, "deleted", c.ctx);
      expect((await entryOf(c, people(ANA_CHAT), { key: chat.key })).conversationId, next.conversationId, "the key's current conversation, unchanged");
    }),

    one("unread: activity of others after the viewer's mark, never one's own nor an operator's; capped; marks only forward", async (c) => {
      const shared = await project(c);
      const unread = async (viewer: Viewer) => (await entryOf(c, viewer, shared)).mine?.unread;
      expect([await unread(people(LUIS)), await unread(people(EVA))], [1, 2], "unread before any mark (Luis: the answer; Eva: his message and the answer)");
      const marked = await c.directory.mine(people(EVA), shared, { readUpTo: Number.MAX_SAFE_INTEGER }, c.ctx);
      expect(marked.mine?.unread, 0, "Eva's unread once read");
      check((marked.mine?.readAt ?? Number.POSITIVE_INFINITY) <= c.ctx.clock.now(), "a read mark never past now");
      await c.subject.advance(10);
      await operatorTalk(c.subject, shared.key, webPlace(LUIS, PROJECT));
      expect(await unread(people(EVA)), 0, "Eva's unread after an operator's follow-up");
      await talk(c.subject, shared.key, LUIS, webPlace(LUIS, PROJECT));
      expect(await unread(people(EVA)), 2, "Eva's unread after Luis wrote and was answered");
      const readAt = (await entryOf(c, people(EVA), shared)).mine?.readAt;
      expect((await c.directory.mine(people(EVA), shared, { readUpTo: 1 }, c.ctx)).mine?.readAt, readAt, "a mark moved back");
      await c.directory.mine(people(LUIS), shared, { readUpTo: c.ctx.clock.now() }, c.ctx);
      await c.subject.advance(10);
      for (let n = 0; n < UNREAD_MAX + 5; n++) await c.subject.message(shared.key, { requestId: `flood-${n}`, sender: sender(EVA), place: webPlace(LUIS, PROJECT) });
      expect(await unread(people(LUIS)), UNREAD_MAX, "Luis's unread, capped");
      expect((await entryOf(c, OPERATOR, shared)).mine?.unread, UNREAD_MAX, "the operator's unread (every activity but its own), capped");
    }),

    one("an operator's activity moves operators' order only, never people's", async (c) => {
      const older = await talk(c.subject, "web:u-luis:older", LUIS, webPlace(LUIS));
      const newer = await talk(c.subject, "web:u-luis:newer", LUIS, webPlace(LUIS));
      const shown = (await entryOf(c, people(LUIS), older)).lastActivity;
      await operatorTalk(c.subject, older.key, webPlace(LUIS));
      expect(keysOf(await listAll(c.directory, people(LUIS), {}, c.ctx)), [newer.key, older.key], "Luis's order");
      expect(keysOf(await listAll(c.directory, OPERATOR, {}, c.ctx)), [older.key, newer.key], "the operator's order");
      expect((await entryOf(c, people(LUIS), older)).lastActivity, shown, "the activity Luis sees");
      check((await entryOf(c, OPERATOR, older)).lastActivity > shown, "the activity operators see to move");
      const ops = await operatorTalk(c.subject, "dashboard:op-1:new", { agent: AGENT, channel: "dashboard", owner: { channel: "dashboard", id: "op-1" } });
      expect(keysOf(await listAll(c.directory, OPERATOR, { owned: true }, c.ctx)), [ops.key], "the operator's own conversations");
    }),

    one("busy while a run goes; a duplicate admission is no activity", async (c) => {
      const ref = await c.subject.message("web:u-ana:1", { requestId: "b-1", sender: sender(ANA), place: webPlace(ANA) });
      await c.subject.started(ref, "b-1");
      expect((await entryOf(c, people(ANA), ref)).busy, true, "busy once a run started");
      await c.subject.settled(ref, ["b-1"], "failed");
      const settled = await entryOf(c, people(ANA), ref);
      expect(settled.busy, false, "busy once the run failed");
      await c.subject.advance(10);
      await c.subject.message(ref.key, { requestId: "b-1", sender: sender(ANA), place: webPlace(ANA), duplicate: true });
      const after = await entryOf(c, people(ANA), ref);
      expect([after.lastActivity, after.mine?.unread], [settled.lastActivity, settled.mine?.unread], "the entry after a duplicate");
    }),

    one("search: the title, the viewer's own name, operators also the key; % _ and \\ are literal", async (c) => {
      const titles = ["100% done", "a_b plan", "back\\slash", "Plain one"];
      const refs: EntryRef[] = [];
      for (const [n, title] of titles.entries()) {
        const ref = await talk(c.subject, `web:u-ana:s${n}`, ANA, webPlace(ANA));
        await c.directory.title(ref, { text: title, source: "first" }, c.ctx);
        refs.push(ref);
      }
      const found = async (viewer: Viewer, q: string) => keysOf(await listAll(c.directory, viewer, { q }, c.ctx)).sort();
      expect(await found(people(ANA), "%"), ["web:u-ana:s0"], "a search for %");
      expect(await found(people(ANA), "_"), ["web:u-ana:s1"], "a search for _");
      expect(await found(people(ANA), "\\"), ["web:u-ana:s2"], "a search for \\");
      expect(await found(people(ANA), "PLAIN"), ["web:u-ana:s3"], "a search in another case");
      expect(await found(people(ANA), "u-ana:s3"), [], "people searching by key");
      expect(await found(OPERATOR, "u-ana:s3"), ["web:u-ana:s3"], "an operator searching by key");
    }),

    one("filters (space, channels, owned) and count: what the list holds, per viewer", async (c) => {
      const shared = await project(c);
      const eva = await talk(c.subject, "web:u-eva:p1", EVA, webPlace(EVA, PROJECT));
      const own = await talk(c.subject, "web:u-luis:own", LUIS, webPlace(LUIS));
      c.grant(LUIS, "googlechat:spaces/A");
      const thread = await talk(c.subject, "googlechat:spaces/A:t1", EVA, { agent: AGENT, channel: "googlechat", space: "googlechat:spaces/A" });
      const sorted = async (viewer: Viewer, query: DirectoryQuery) => keysOf(await listAll(c.directory, viewer, query, c.ctx)).sort();
      expect(await sorted(people(LUIS), {}), [eva.key, thread.key, own.key, shared.key].sort(), "Luis's list");
      expect(await sorted(people(LUIS), { channels: ["web"] }), [eva.key, own.key, shared.key].sort(), "Luis's web chats");
      expect(await sorted(people(LUIS), { channels: ["web"], owned: true }), [own.key, shared.key].sort(), "Luis's own web chats");
      expect(await sorted(people(LUIS), { space: PROJECT }), [eva.key, shared.key].sort(), "Luis's chats of the project");
      expect(await c.directory.count(people(LUIS), [PROJECT, OTHER_PROJECT, "googlechat:spaces/A"], c.ctx), { [PROJECT]: 2, [OTHER_PROJECT]: 0, "googlechat:spaces/A": 1 }, "Luis's counts");
      await c.directory.mine(people(LUIS), eva, { hidden: true }, c.ctx);
      expect(await c.directory.count(people(LUIS), [PROJECT], c.ctx), { [PROJECT]: 1 }, "Luis's count once he hid one");
      expect(await c.directory.count(people(STRANGER), [PROJECT], c.ctx), { [PROJECT]: 0 }, "a stranger's count");
      expect(await c.directory.count(COMPONENT, [PROJECT], c.ctx), { [PROJECT]: 2 }, "a component's count");
    }),

    one("the audience fails closed: a stage that throws grants nothing, another source's grant is dropped, past AUDIENCE_MAX is limit", async (c) => {
      const shared = await project(c);
      const eva = await talk(c.subject, "web:u-eva:p1", EVA, webPlace(EVA, PROJECT));
      c.audience.throws = true;
      expect(keysOf(await listAll(c.directory, people(LUIS), {}, c.ctx)), [shared.key], "Luis's list while the provider is down: his own only");
      expect(await c.directory.access(people(LUIS), eva, c.ctx), undefined, "Luis's access to Eva's chat while the provider is down");
      c.audience.throws = false;
      c.audience.foreign = true;
      expect(await c.directory.access(people(LUIS), eva, c.ctx), undefined, "a grant a stage gave as another source's");
      c.audience.foreign = false;
      c.audience.flood = true;
      expect(await outcome(() => c.directory.list(people(LUIS), {}, c.ctx)), "limit", "a list past AUDIENCE_MAX grants");
      c.audience.flood = false;
      check((await c.directory.access(people(LUIS), eva, c.ctx)) !== undefined, "Luis's access once the provider answers again");
    }),
  ];

  const replay: ConformanceCase = one("a late or repeated update changes nothing", async (c) => {
    if (c.subject.replay === undefined) return;
    const shared = await project(c);
    await c.subject.reset(shared.key);
    const again = await talk(c.subject, shared.key, EVA, webPlace(LUIS, PROJECT));
    await c.subject.started(again, "late-start");
    await c.subject.settled(again, ["late-start"]);
    await c.directory.setState(people(EVA), again, "archived", c.ctx);
    const snapshot = async () => JSON.stringify(await Promise.all([OPERATOR, people(LUIS), people(EVA)].flatMap((viewer) => (["listed", "archived", "hidden"] as const).map((state) => listAll(c.directory, viewer, { state }, c.ctx)))));
    const before = await snapshot();
    await c.subject.replay();
    expect(await snapshot(), before, "every list after the updates came again");
  });

  const restart: ConformanceCase = one("a restart keeps every entry, title, state and viewer's own state", async (c) => {
    if (c.subject.restart === undefined) return;
    const shared = await project(c);
    await c.directory.rename(people(EVA), shared, "Kept", c.ctx);
    await c.directory.mine(people(EVA), shared, { hidden: true, name: "Mine", readUpTo: c.ctx.clock.now() }, c.ctx);
    await c.directory.setState(people(LUIS), shared, "archived", c.ctx);
    const before = [await c.directory.access(people(EVA), shared, c.ctx), await c.directory.access(people(LUIS), shared, c.ctx), await listAll(c.directory, OPERATOR, { state: "archived" }, c.ctx)];
    const directory = await c.subject.restart();
    const after = [await directory.access(people(EVA), shared, c.ctx), await directory.access(people(LUIS), shared, c.ctx), await listAll(directory, OPERATOR, { state: "archived" }, c.ctx)];
    expect(after, before, "what the directory answers after a restart");
  });

  return [...cases, replay, restart];
}

// The in-memory double: what a view's tests use, and what proves the suite.

/** One update the double takes, as conversations-directory's `seen` carries the runtime's events. */
export type MemoryDirectoryUpdate =
  | { kind: "dispatched"; ref: EntryRef & DirectoryPlace; requestId: string; sender?: Sender; duplicate: boolean; at: number; seq: number }
  | { kind: "started"; ref: EntryRef; requestId: string; at: number; seq: number }
  | { kind: "settled"; ref: EntryRef; requestId: string; requestIds: readonly string[]; at: number; seq: number }
  | { kind: "reset"; previous: EntryRef; ref: EntryRef & DirectoryPlace; at: number; seq: number };

export interface MemoryDirectoryOptions {
  /** Resets `key` in the registry (a delete for everyone of its current conversation), its `conversation.reset` given back through `seen` before it resolves. */
  reset(key: string, ctx: AppContext): Promise<void>;
}

export interface MemoryDirectory {
  directory: ConversationDirectory;
  /** Records one update (idempotent, in any order). */
  seen(update: MemoryDirectoryUpdate): void;
  /** A new double over a copy of this one's state, as a provider restarted over its storage. */
  restart(): MemoryDirectory;
}

/** Breaks of the double for the suite's own tests (contract rule 7): never in a provider. */
export type MemoryDirectoryFlaws = Partial<
  Record<"ownerIgnored" | "grantsIgnored" | "titleReversed" | "hideForEveryone" | "operatorShown" | "staleAccess" | "noReset" | "unreadOwn" | "hideForever" | "spaceOwnerDeletes" | "seqIgnored" | "deletedRevives", boolean>
>;

type Row = {
  key: string;
  conversationId: string;
  known: boolean;
  channel: string;
  agent: string;
  space?: string;
  owner?: Principal;
  delegated: boolean;
  current: boolean;
  createdAt: number;
  lastActivity: number;
  shownActivity: number;
  busy: boolean;
  seq: number;
  title?: string;
  titleSource?: TitleSource;
  state: EntryState;
  stateAt?: number;
  stateBy?: Author;
  activity: { id: string; at: number; by: string; shown: boolean }[];
};
type Mine = { hiddenAt?: number; readAt?: number; name?: string };
type State = { rows: Record<string, Row>; viewers: Record<string, Mine> };

const rowId = (ref: EntryRef): string => JSON.stringify([ref.key, ref.conversationId]);
const ACTIVITY_KEPT = 100;

/** An in-memory `conversations.directory` that passes `createConversationDirectoryConformance`. */
export function createMemoryDirectory(options: MemoryDirectoryOptions): MemoryDirectory {
  return flawedMemoryDirectory(options, {});
}

/** `createMemoryDirectory` with `flaws`: for the suite's own tests only. */
export function flawedMemoryDirectory(options: MemoryDirectoryOptions, flaws: MemoryDirectoryFlaws, from?: State): MemoryDirectory {
  const state: State = from ?? { rows: {}, viewers: {} };

  const blank = (ref: EntryRef): Row => ({
    key: ref.key,
    conversationId: ref.conversationId,
    known: false,
    channel: "",
    agent: "",
    delegated: false,
    current: true,
    createdAt: 0,
    lastActivity: 0,
    shownActivity: 0,
    busy: false,
    seq: 0,
    state: "listed",
    activity: [],
  });
  const rowOf = (ref: EntryRef): Row => {
    const id = rowId(ref);
    state.rows[id] ??= blank(ref);
    return state.rows[id];
  };
  const place = (row: Row, ref: EntryRef & DirectoryPlace, at: number) => {
    if (row.known) return;
    row.known = true;
    row.channel = ref.channel;
    row.agent = ref.agent;
    if (ref.space !== undefined) row.space = ref.space;
    if (ref.owner !== undefined) row.owner = { ...ref.owner };
    row.delegated = ref.delegated === true;
    row.createdAt = at;
  };
  const newer = (row: Row, seq: number): boolean => {
    if (flaws.seqIgnored === true) return true;
    if (seq <= row.seq) return false;
    row.seq = seq;
    return true;
  };
  const activity = (row: Row, entry: { id: string; at: number; by: string; shown: boolean }) => {
    if (row.activity.some((each) => each.id === entry.id)) return;
    row.activity.push(entry);
    row.activity.sort((a, b) => a.at - b.at);
    if (row.activity.length > ACTIVITY_KEPT) row.activity.splice(0, row.activity.length - ACTIVITY_KEPT);
    row.lastActivity = Math.max(row.lastActivity, entry.at);
    const shown = entry.shown || flaws.operatorShown === true;
    if (!shown) return;
    row.shownActivity = Math.max(row.shownActivity, entry.at);
    if (row.state === "archived" && entry.at > (row.stateAt ?? 0)) {
      row.state = "listed";
      delete row.stateAt;
      delete row.stateBy;
    }
    if (flaws.deletedRevives === true && row.state === "deleted") row.state = "listed";
  };

  const seen = (update: MemoryDirectoryUpdate): void => {
    switch (update.kind) {
      case "dispatched": {
        const row = rowOf(update.ref);
        place(row, update.ref, update.at);
        if (newer(row, update.seq)) row.agent = update.ref.agent;
        if (!update.duplicate) {
          const by = update.sender === undefined ? "unknown" : principalKey({ channel: update.sender.channel, id: update.sender.id });
          activity(row, { id: `m:${update.requestId}`, at: update.at, by, shown: !isDashboardRequest(update.requestId) });
        }
        return;
      }
      case "started": {
        const row = rowOf(update.ref);
        if (newer(row, update.seq)) row.busy = true;
        return;
      }
      case "settled": {
        const row = rowOf(update.ref);
        if (newer(row, update.seq)) row.busy = false;
        activity(row, { id: `r:${update.requestId}`, at: update.at, by: "agent", shown: !answersOnlyTheDashboard({ requestId: update.requestId, requestIds: [...update.requestIds] }) });
        return;
      }
      case "reset": {
        rowOf(update.previous).current = false;
        const row = rowOf(update.ref);
        place(row, update.ref, update.at);
        return;
      }
    }
  };

  const mineKey = (viewer: Viewer, ref: EntryRef): string | undefined => {
    const key = viewerKey(viewer);
    return key === undefined ? undefined : JSON.stringify([flaws.hideForEveryone === true ? "everyone" : key, ref.key, ref.conversationId]);
  };

  /** The role `viewer` has on `row`, given the grants of its space (`undefined`: not seen). */
  const roleOn = (viewer: Viewer, row: Row, grants: readonly AudienceGrant[]): DirectoryRole | undefined => {
    if (!row.known) return undefined;
    if (viewer.kind === "operator" || viewer.kind === "component") return viewer.kind;
    if (!row.current || row.delegated || row.shownActivity <= 0 || row.state === "deleted") return undefined;
    if (viewerOwns(viewer, row.owner) || (flaws.ownerIgnored === true && row.space === undefined)) return "owner";
    if (row.space === undefined) return undefined;
    if (flaws.grantsIgnored === true) return "member";
    const ofSpace = grants.filter((grant) => grant.space === row.space);
    if (ofSpace.some((grant) => grant.role === "owner")) return "space-owner";
    return ofSpace.length > 0 ? "member" : undefined;
  };

  const entryFor = (viewer: Viewer, row: Row, role: DirectoryRole): DirectoryEntry => {
    const seenActivity = viewer.kind === "people" ? row.shownActivity : row.lastActivity;
    const may = permissionsOf(role);
    if (flaws.spaceOwnerDeletes === true && role === "space-owner") may.delete = true;
    const entry: DirectoryEntry = {
      key: row.key,
      conversationId: row.conversationId,
      channel: row.channel,
      agent: row.agent,
      ...(row.space !== undefined && { space: row.space }),
      ...(row.owner !== undefined && { owner: { ...row.owner } }),
      current: row.current,
      createdAt: row.createdAt,
      lastActivity: seenActivity,
      busy: row.busy,
      ...(row.title !== undefined && { title: row.title }),
      ...(row.titleSource !== undefined && { titleSource: row.titleSource }),
      state: row.state,
      ...(row.stateAt !== undefined && { stateAt: row.stateAt }),
      ...(row.stateBy !== undefined && { stateBy: row.stateBy }),
      role,
      may,
    };
    const key = mineKey(viewer, row);
    if (key !== undefined) {
      const own = state.viewers[key] ?? {};
      const hidden = flaws.hideForever === true ? own.hiddenAt !== undefined : stillHidden(own.hiddenAt, seenActivity);
      const mineKeys = new Set(viewerPrincipals(viewer).map(principalKey));
      const unread = row.activity.filter((each) => each.at > (own.readAt ?? -1) && (viewer.kind !== "people" || each.shown || flaws.operatorShown === true) && (flaws.unreadOwn === true || !mineKeys.has(each.by))).length;
      entry.mine = {
        hidden,
        ...(hidden && own.hiddenAt !== undefined && { hiddenAt: own.hiddenAt }),
        ...(own.readAt !== undefined && { readAt: own.readAt }),
        ...(own.name !== undefined && { name: own.name }),
        unread: Math.min(unread, UNREAD_MAX),
      };
    }
    return entry;
  };

  const listGrants = async (viewer: Viewer, ctx: AppContext): Promise<AudienceGrant[]> => (viewer.kind === "people" ? audienceGrants(ctx, viewer.principals) : []);

  /** Every entry `viewer` sees now, with the grants of a list. */
  const visible = async (viewer: Viewer, ctx: AppContext): Promise<DirectoryEntry[]> => {
    const grants = await listGrants(viewer, ctx);
    return Object.values(state.rows).flatMap((row) => {
      const role = roleOn(viewer, row, grants);
      if (role === undefined) return [];
      const entry = entryFor(viewer, row, role);
      return entry.lastActivity > 0 ? [entry] : [];
    });
  };

  const matching = (viewer: Viewer, entry: DirectoryEntry, query: ReturnType<typeof parseDirectoryQuery>): boolean => {
    if (listStateOf(entry) !== query.state) return false;
    if (query.space !== undefined && entry.space !== query.space) return false;
    if (query.channels !== undefined && !query.channels.includes(entry.channel)) return false;
    if (query.owned === true && !viewerOwns(viewer, entry.owner)) return false;
    if (query.q !== undefined && !matchesSearch(query.q, [entry.title, entry.mine?.name, ...(viewer.kind === "people" ? [] : [entry.key])])) return false;
    return true;
  };

  const find = (ref: { key: string; conversationId?: string }): Row | undefined => {
    if (ref.conversationId !== undefined) {
      const row = state.rows[rowId({ key: ref.key, conversationId: ref.conversationId })];
      return row?.known === true ? row : undefined;
    }
    return Object.values(state.rows).find((row) => row.known && row.key === ref.key && row.current);
  };

  const access = async (viewer: Viewer, ref: { key: string; conversationId?: string }, ctx: AppContext): Promise<DirectoryEntry | undefined> => {
    const row = find(ref);
    if (row === undefined) return undefined;
    const grants = viewer.kind !== "people" || row.space === undefined ? [] : flaws.staleAccess === true ? await listGrants(viewer, ctx) : await audienceGrants(ctx, viewer.principals, row.space);
    const role = roleOn(viewer, row, grants);
    return role === undefined ? undefined : entryFor(viewer, row, role);
  };

  const seenOr404 = async (viewer: Viewer, ref: EntryRef, ctx: AppContext): Promise<{ row: Row; entry: DirectoryEntry }> => {
    const entry = await access(viewer, ref, ctx);
    const row = state.rows[rowId(ref)];
    if (entry === undefined || row === undefined) throw new DirectoryError("not_found", "no such conversation");
    return { row, entry };
  };

  const checkRef = (ref: unknown): EntryRef => {
    const { key, conversationId } = (ref ?? {}) as Record<string, unknown>;
    if (typeof key !== "string" || key === "" || typeof conversationId !== "string" || conversationId === "") throw new DirectoryError("invalid", "a ref is a key and a conversation id");
    return { key, conversationId };
  };

  const directory: ConversationDirectory = {
    async list(rawViewer, rawQuery, ctx) {
      const viewer = parseViewer(rawViewer);
      const query = parseDirectoryQuery(rawQuery);
      if (query.state === "deleted" && viewer.kind === "people") throw new DirectoryError("forbidden", "people never list deleted conversations");
      if (query.owned === true && viewer.kind === "component") throw new DirectoryError("invalid", "a component owns nothing");
      const cursor = query.cursor === undefined ? undefined : parseDirectoryCursor(query.cursor);
      const all = (await visible(viewer, ctx)).filter((entry) => matching(viewer, entry, query) && (cursor === undefined || afterCursor(entry, cursor))).sort(compareDirectoryOrder);
      const items = all.slice(0, query.limit);
      const last = items.at(-1);
      return { items, ...(all.length > items.length && last !== undefined && { next: directoryCursor(last) }) };
    },
    async count(rawViewer, spaces, ctx) {
      const viewer = parseViewer(rawViewer);
      if (!Array.isArray(spaces) || spaces.length === 0 || spaces.length > DIRECTORY_COUNT_MAX || spaces.some((space) => typeof space !== "string" || space === "")) {
        throw new DirectoryError("invalid", `count takes 1 to ${DIRECTORY_COUNT_MAX} spaces`);
      }
      const entries = await visible(viewer, ctx);
      const query = parseDirectoryQuery({});
      return Object.fromEntries(spaces.map((space) => [space, entries.filter((entry) => entry.space === space && matching(viewer, entry, query)).length]));
    },
    async access(rawViewer, ref, ctx) {
      const viewer = parseViewer(rawViewer);
      if (typeof ref?.key !== "string" || ref.key === "") throw new DirectoryError("invalid", "a ref has a key");
      return access(viewer, ref, ctx);
    },
    async rename(rawViewer, rawRef, title, ctx) {
      const viewer = parseViewer(rawViewer);
      const ref = checkRef(rawRef);
      const { row, entry } = await seenOr404(viewer, ref, ctx);
      if (!entry.may.rename) throw new DirectoryError("forbidden", "only the conversation's owner, its space's owner or an operator renames it");
      const cleaned = typeof title === "string" ? cleanTitle(title) : undefined;
      if (cleaned === undefined) throw new DirectoryError("invalid", "a title has words");
      row.title = cleaned;
      row.titleSource = "rename";
      return entryFor(viewer, row, entry.role);
    },
    async setState(rawViewer, rawRef, next, ctx) {
      const viewer = parseViewer(rawViewer);
      const ref = checkRef(rawRef);
      if (!isEntryState(next)) throw new DirectoryError("invalid", "a state is listed, archived or deleted");
      const { row, entry } = await seenOr404(viewer, ref, ctx);
      const allowed = next === "deleted" || row.state === "deleted" ? entry.may.delete : entry.may.archive;
      if (!allowed) throw new DirectoryError("forbidden", "not this viewer's to change for everyone");
      if (row.state === next) return entry;
      row.state = next;
      row.stateAt = ctx.clock.now();
      row.stateBy = viewerAuthor(viewer);
      if (next === "deleted" && row.current && flaws.noReset !== true) await options.reset(row.key, ctx);
      return entryFor(viewer, row, entry.role);
    },
    async mine(rawViewer, rawRef, change: ViewerChange, ctx) {
      const viewer = parseViewer(rawViewer);
      const ref = checkRef(rawRef);
      if (viewer.kind === "component") throw new DirectoryError("invalid", "a component has no state of its own");
      const { hidden, readUpTo, name } = (change ?? {}) as ViewerChange;
      if (hidden !== undefined && typeof hidden !== "boolean") throw new DirectoryError("invalid", "hidden is a boolean");
      if (readUpTo !== undefined && (typeof readUpTo !== "number" || !Number.isSafeInteger(readUpTo) || readUpTo < 0)) throw new DirectoryError("invalid", "readUpTo is a time");
      const cleaned = typeof name === "string" ? cleanTitle(name) : undefined;
      if (name !== undefined && name !== null && cleaned === undefined) throw new DirectoryError("invalid", "a name has words");
      const { row, entry } = await seenOr404(viewer, ref, ctx);
      const key = mineKey(viewer, ref) as string;
      const own = { ...(state.viewers[key] ?? {}) };
      const now = ctx.clock.now();
      if (hidden === true) own.hiddenAt = now;
      if (hidden === false) delete own.hiddenAt;
      if (readUpTo !== undefined) own.readAt = Math.max(own.readAt ?? 0, Math.min(readUpTo, now));
      if (cleaned !== undefined) own.name = cleaned;
      if (name === null) delete own.name;
      state.viewers[key] = own;
      return entryFor(viewer, row, entry.role);
    },
    async title(rawRef, title, _ctx) {
      const ref = checkRef(rawRef);
      if (title?.source !== "first" && title?.source !== "model") throw new DirectoryError("invalid", "a title's source is first or model");
      const cleaned = typeof title.text === "string" ? cleanTitle(title.text) : undefined;
      if (cleaned === undefined) return;
      const row = rowOf(ref);
      const applies = flaws.titleReversed === true ? row.titleSource === undefined || !titleApplies(row.titleSource, title.source) || row.titleSource === title.source : titleApplies(row.titleSource, title.source);
      if (!applies) return;
      row.title = cleaned;
      row.titleSource = title.source;
    },
  };

  return { directory, seen, restart: () => flawedMemoryDirectory(options, flaws, structuredClone(state)) };
}

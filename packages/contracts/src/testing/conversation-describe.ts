/**
 * `conversation.describe` conformance: what every channel's stage guarantees to whoever shows its
 * conversations (`../conversation-describe.ts`), read through `describeConversation`, as admin-api
 * reads it. Runner-independent:
 *
 *   for (const c of createConversationDescribeConformance(() => myDescribeFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite starts an App of the fixture's components, has the fixture make the channel know a party
 * (a message its platform sent, an account), and runs the pipeline for it, for a key of the channel it
 * knows nothing of, for keys it did not make, and for a key another stage (the suite's, first) already
 * described.
 */

import { type App, type AppContext, type ComponentDefinition, defineApp, defineComponent, Halt, silentLogger } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import { type ConversationParty, describeConversation, type DescribedConversation, PARTY_LIMITS } from "../conversation-describe.ts";
import { checker, expecter } from "./assert.ts";

/** A name as a hostile platform may send it: a bell, a right-to-left override, and 500 characters. */
export const HOSTILE_NAME = `Ana${String.fromCharCode(7)} L${String.fromCharCode(0x202e)}${"o".repeat(500)}`;

/** The channel under test, in an App built for one case. */
export interface ConversationDescribeFixture {
  /** The channel's components, and what they use (a runtime, a registry, storage). */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** The channel's kind (`telegram`): the first segment of every key it makes. */
  kind: string;
  /**
   * Once the App started, makes the channel know a party (a message received through its platform, an
   * account) and answers its conversation key, and what its description must hold: `check` throws when
   * it does not hold it.
   */
  known(app: App, ctx: AppContext): Promise<{ key: string; check(party: ConversationParty): void | Promise<void> }>;
  /** A key the channel makes, of a conversation it knows nothing of: described by its ids, without a throw. */
  unknown: string;
  /** Keys of the kind the channel did not make (another instance's, a malformed one): each left undescribed. */
  foreign?: string[];
  /** Makes the channel know a party named `HOSTILE_NAME` by its platform, and answers its key. */
  hostile?(app: App, ctx: AppContext): Promise<string>;
  dispose?(): Promise<void>;
}

const GROUP = "conversation.describe";
const expect = expecter(GROUP);
const check = checker(GROUP);

const HIDDEN = new RegExp(`[\\p{Cc}${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}]`, "u");

/** The key the suite's own stage describes first, whatever the channel: the channel's stage must leave it. */
const CLAIMED = "conformance-claimed";
const CLAIMED_PARTY: ConversationParty = { name: "Described before", ids: [{ label: "Probe", value: "1" }] };

/** What every description shown must be: within `PARTY_LIMITS`, with no hidden character. */
function checkBounded(party: ConversationParty, what: string): void {
  const texts = [party.name, party.detail, party.link?.label, ...party.ids.flatMap((id) => [id.label, id.value])].filter((each): each is string => each !== undefined);
  for (const text of texts) check(!HIDDEN.test(text) && text.trim() === text && text !== "", `${what}: "${text.slice(0, 40)}" to be one trimmed line with no hidden character`);
  check(party.name === undefined || [...party.name].length <= PARTY_LIMITS.name, `${what}: its name to be at most ${PARTY_LIMITS.name} characters`);
  check(party.detail === undefined || [...party.detail].length <= PARTY_LIMITS.detail, `${what}: its detail to be at most ${PARTY_LIMITS.detail} characters`);
  check(party.ids.length <= PARTY_LIMITS.ids, `${what}: at most ${PARTY_LIMITS.ids} ids`);
}

export function createConversationDescribeConformance(factory: () => ConversationDescribeFixture | Promise<ConversationDescribeFixture>): readonly ConformanceCase[] {
  const describeCase = (name: string, run: (fixture: ConversationDescribeFixture, app: App, ctx: AppContext, claim: (key: string) => void) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      let claimed: string | undefined;
      // The suite's stage, before every other: it describes `claimed` (a key the case names) itself.
      const probe = defineComponent({
        name: "conversation-describe-conformance",
        setup(pikit) {
          pikit.pipeline("conversation.describe", (value) => (value.key === claimed && value.party === undefined ? { ...value, party: CLAIMED_PARTY } : value), {
            id: CLAIMED,
            priority: 1_000_000,
          });
        },
      });
      const app = await defineApp({
        components: [...fixture.components, probe],
        ...(fixture.config !== undefined && { config: fixture.config }),
        logger: silentLogger,
      }).create();
      await app.start();
      try {
        await run(fixture, app, app.context(), (key) => void (claimed = key));
      } finally {
        await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  /** What the pipeline holds for `key` once run, uncleaned: what the channel's stage itself set. */
  const raw = async (ctx: AppContext, key: string): Promise<DescribedConversation> => {
    const described = await ctx.run("conversation.describe", { key });
    if (described instanceof Halt) throw new Error(`${GROUP}: a stage halted the description of ${JSON.stringify(key)}: ${described.reason}`);
    expect(described.key, key, `the key once described (a stage changed it)`);
    return described;
  };

  return [
    describeCase("a conversation it knows is described: what the channel knows of the party, its ids, within bounds", async (fixture, app, ctx) => {
      const known = await fixture.known(app, ctx);
      const described = await raw(ctx, known.key);
      check(described.party !== undefined && Array.isArray(described.party.ids), `"${known.key}" to be described, with ids (got ${JSON.stringify(described.party)})`);
      const party = await describeConversation(ctx, known.key);
      if (party === undefined) throw new Error(`${GROUP}: "${known.key}": describeConversation answered nothing`);
      checkBounded(party, `"${known.key}"`);
      await known.check(party);
    }),

    describeCase("a key it made but knows nothing of is described by its ids, without a throw", async (fixture, _app, ctx) => {
      const described = await raw(ctx, fixture.unknown);
      check(described.party !== undefined && Array.isArray(described.party.ids) && described.party.ids.length > 0, `"${fixture.unknown}" to be described by at least one id (got ${JSON.stringify(described.party)})`);
      const party = await describeConversation(ctx, fixture.unknown);
      check(party !== undefined && party.ids.length > 0, `"${fixture.unknown}" to keep its ids once cleaned`);
      checkBounded(party as ConversationParty, `"${fixture.unknown}"`);
    }),

    describeCase("another channel's key, or one it did not make, is left undescribed", async (fixture, _app, ctx) => {
      const rest = fixture.unknown.slice(fixture.kind.length + 1);
      const keys = ["", fixture.kind, `${fixture.kind}:`, `other-channel:${rest}`, `${fixture.kind}x:${rest}`, `x${fixture.unknown}`, `${fixture.unknown}\n`, ...(fixture.foreign ?? [])];
      for (const key of keys) expect((await raw(ctx, key)).party, undefined, `the description of ${JSON.stringify(key)}`);
    }),

    describeCase("a conversation another stage described first is left as that stage said", async (fixture, app, ctx, claim) => {
      const known = await fixture.known(app, ctx);
      claim(known.key);
      expect((await raw(ctx, known.key)).party, CLAIMED_PARTY, `the description of "${known.key}" another stage set first`);
    }),

    describeCase("what a hostile platform sent is shown cleaned: one line, within bounds", async (fixture, app, ctx) => {
      if (fixture.hostile === undefined) return;
      const key = await fixture.hostile(app, ctx);
      const party = await describeConversation(ctx, key);
      if (party === undefined) throw new Error(`${GROUP}: "${key}": the hostile party was not described`);
      checkBounded(party, `"${key}"`);
      check(party.name?.startsWith("Ana L") === true || party.detail?.startsWith("Ana L") === true, `the hostile name to be shown, cleaned (got ${JSON.stringify(party)})`);
    }),
  ];
}

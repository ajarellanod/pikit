/**
 * `conversation.audience` conformance: what every membership provider's stage guarantees to the
 * directory (`../conversation-audience.ts`), read through `audienceGrants`, as conversations-directory
 * reads it. Runner-independent:
 *
 *   for (const c of createConversationAudienceConformance(() => myAudienceFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite starts an App of the fixture's components with a stage of its own first (it grants every
 * principal a space of its own source, which the provider's stage must leave as it is), has the fixture
 * make a person a member or an owner of a space (a project made, a member added), and checks the grants
 * for a list and the fresh check of one space, for a stranger, after the membership is removed, and
 * while the provider fails.
 */

import { type App, type AppContext, type ComponentDefinition, defineApp, defineComponent, Halt, silentLogger } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { Principal } from "../change.ts";
import { type Audience, type AudienceGrant, audienceGrants } from "../conversation-audience.ts";
import { checker, expecter } from "./assert.ts";

/** A membership the fixture made: whose, and of which space. */
export type AudienceMember = { principals: Principal[]; space: string };

/** The membership provider under test, in an App built for one case. */
export interface ConversationAudienceFixture {
  /** The provider's components, and what they use (storage, a mailbox). */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** The `source` its stage gives its grants (`audienceStage(source, …)`). */
  source: string;
  /** Once the App started, makes one person a member (or the owner) of a space, now: answers their principals and the space. */
  member(app: App, ctx: AppContext, role: "member" | "owner"): Promise<AudienceMember>;
  /** Ends that membership now (a member removed, a project removed). */
  remove(app: App, ctx: AppContext, member: AudienceMember): Promise<void>;
  /** Makes the provider fail from now on (its store or its actor down), when the fixture can. */
  fail?(app: App, ctx: AppContext): Promise<void> | void;
  dispose?(): Promise<void>;
}

const GROUP = "conversation.audience";
const expect = expecter(GROUP);
const check = checker(GROUP);

/** The grant the suite's own stage gives every principal first: the provider's stage must leave it. */
const EARLIER: AudienceGrant = { space: "conformance:earlier", role: "member", source: "conformance-earlier" };
const STRANGER: Principal = { channel: "web", id: "u-conformance-stranger" };

export function createConversationAudienceConformance(factory: () => ConversationAudienceFixture | Promise<ConversationAudienceFixture>): readonly ConformanceCase[] {
  const audienceCase = (name: string, run: (fixture: ConversationAudienceFixture, app: App, ctx: AppContext) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      const probe = defineComponent({
        name: "conversation-audience-conformance",
        setup(pikit) {
          pikit.pipeline("conversation.audience", (value) => (value.space === undefined || value.space === EARLIER.space ? { ...value, grants: [...value.grants, { ...EARLIER }] } : value), {
            id: "conformance-earlier",
            priority: 1_000_000,
          });
        },
      });
      const app = await defineApp({ components: [...fixture.components, probe], ...(fixture.config !== undefined && { config: fixture.config }), logger: silentLogger }).create();
      await app.start();
      try {
        await run(fixture, app, app.context());
      } finally {
        await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  /** What the pipeline holds once run, unchecked: what the provider's stage itself did. */
  const raw = async (ctx: AppContext, principals: readonly Principal[], space?: string): Promise<AudienceGrant[]> => {
    const value = await ctx.run("conversation.audience", { principals, ...(space !== undefined && { space }), grants: [] } satisfies Audience);
    if (value instanceof Halt) throw new Error(`${GROUP}: a stage halted the pipeline: ${value.reason}`);
    return value.grants;
  };
  const own = (grants: readonly AudienceGrant[], source: string) => grants.filter((grant) => grant.source === source).map(({ space, role }) => ({ space, role }));

  return [
    audienceCase("a member's and an owner's space is granted with their role, by the stage's source, for a list and checked fresh", async (fixture, app, ctx) => {
      for (const role of ["member", "owner"] as const) {
        const member = await fixture.member(app, ctx, role);
        const listed = await audienceGrants(ctx, member.principals);
        check(own(listed, fixture.source).some((grant) => grant.space === member.space && grant.role === role), `the list's grants to name ${member.space} as ${role} (got ${JSON.stringify(listed)})`);
        expect(own(await audienceGrants(ctx, member.principals, member.space), fixture.source), [{ space: member.space, role }], `the fresh check of ${member.space} for its ${role}`);
      }
    }),

    audienceCase("a stranger is granted nothing", async (fixture, app, ctx) => {
      const member = await fixture.member(app, ctx, "member");
      expect(own(await audienceGrants(ctx, [STRANGER]), fixture.source), [], "a stranger's grants for a list");
      expect(own(await audienceGrants(ctx, [STRANGER], member.space), fixture.source), [], "a stranger's fresh check of a member's space");
    }),

    audienceCase("a removed membership is granted nothing at the fresh check, at once", async (fixture, app, ctx) => {
      const member = await fixture.member(app, ctx, "member");
      expect(own(await audienceGrants(ctx, member.principals, member.space), fixture.source), [{ space: member.space, role: "member" }], "the fresh check while a member");
      await audienceGrants(ctx, member.principals);
      await fixture.remove(app, ctx, member);
      expect(own(await audienceGrants(ctx, member.principals, member.space), fixture.source), [], "the fresh check after the membership ended");
    }),

    audienceCase("the stage appends only its own source's grants, and leaves an earlier stage's as they are", async (fixture, app, ctx) => {
      const member = await fixture.member(app, ctx, "owner");
      const grants = await raw(ctx, member.principals);
      expect(grants[0], EARLIER, "the earlier stage's grant, first and unchanged");
      expect(grants.filter((grant) => grant.source === EARLIER.source).length, 1, "the earlier stage's grants");
      const others = grants.filter((grant) => grant.source !== EARLIER.source);
      check(others.length > 0 && others.every((grant) => grant.source === fixture.source), `every other grant to be of source ${fixture.source} (got ${JSON.stringify(others)})`);
      expect(await raw(ctx, member.principals, EARLIER.space).then((fresh) => fresh.filter((grant) => grant.source === EARLIER.source)), [EARLIER], "the earlier stage's grant in a fresh check of its space");
    }),

    audienceCase("a fresh check of one space names only that space", async (fixture, app, ctx) => {
      const member = await fixture.member(app, ctx, "member");
      const grants = own(await raw(ctx, member.principals, `${member.space}:other`), fixture.source);
      expect(grants, [], `the stage's grants for a fresh check of another space`);
    }),

    audienceCase("a provider that fails grants nothing, and the pipeline goes on", async (fixture, app, ctx) => {
      if (fixture.fail === undefined) return;
      const member = await fixture.member(app, ctx, "member");
      await fixture.fail(app, ctx);
      let grants: AudienceGrant[] = [];
      try {
        grants = await raw(ctx, member.principals);
      } catch (error) {
        throw new Error(`${GROUP}: the pipeline threw while the provider failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      expect(own(grants, fixture.source), [], "the failing provider's grants");
      expect(grants, [EARLIER], "the earlier stage's grant, kept");
      expect(own(await audienceGrants(ctx, member.principals, member.space), fixture.source), [], "the fresh check while the provider fails");
    }),
  ];
}

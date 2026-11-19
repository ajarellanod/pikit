// The conversation.audience suite catches membership stages that break the contract (projects-sql and
// downstream's rooms run it on theirs), and its helpers fail closed.

import { expect, test } from "bun:test";
import { type AppContext, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { principalKey } from "../change.ts";
import { type Audience, type AudienceProvider, audienceGrants, audienceStage } from "../conversation-audience.ts";
import { AUDIENCE_MAX, DirectoryError } from "../conversation-directory.ts";
import { createConversationAudienceConformance } from "./conversation-audience.ts";

type Flaws = { replaces?: boolean; grantsStrangers?: boolean; cachesRemoval?: boolean; foreignByHand?: boolean; throwsByHand?: boolean; ignoresSpace?: boolean };

/** A membership provider `demo`: principalKey -> spaces, with a list cache when it caches removals. */
function demo(members: Map<string, Map<string, "member" | "owner">>, flaws: Flaws, failing: { now: boolean }) {
  const cache = new Map<string, { space: string; role: "member" | "owner" }[]>();
  const provider: AudienceProvider = {
    async grants(principals, space) {
      if (failing.now) throw new Error("down");
      return principals.flatMap((principal) => {
        const key = principalKey(principal);
        const known = members.get(key);
        if (known === undefined) return flaws.grantsStrangers === true ? [{ space: "demo:any", role: "member" as const }] : [];
        const now = [...known].map(([s, role]) => ({ space: s, role }));
        if (flaws.cachesRemoval === true) {
          if (!cache.has(key) || now.length > (cache.get(key)?.length ?? 0)) cache.set(key, now);
          return (cache.get(key) ?? []).filter((grant) => space === undefined || grant.space === space);
        }
        return now.filter((grant) => space === undefined || flaws.ignoresSpace === true || grant.space === space);
      });
    },
  };
  return defineComponent({
    name: "audience-test",
    setup(pikit) {
      const stage = audienceStage("demo", provider);
      const byHand = async (value: Audience, ctx: AppContext): Promise<Audience> => {
        if (flaws.throwsByHand === true && failing.now) throw new Error("down, by hand");
        const staged = await stage({ ...value, grants: [] }, ctx);
        if (flaws.replaces === true) return staged;
        if (flaws.foreignByHand === true) return { ...value, grants: [...value.grants, ...staged.grants, { space: "demo:foreign", role: "owner", source: "someone-else" }] };
        return { ...value, grants: [...value.grants, ...staged.grants] };
      };
      pikit.pipeline("conversation.audience", flaws.replaces === true || flaws.foreignByHand === true || flaws.throwsByHand === true ? byHand : stage, { id: "demo" });
    },
  });
}

async function failing(flaws: Flaws): Promise<string[]> {
  const failed: string[] = [];
  for (const c of createConversationAudienceConformance(() => {
    const members = new Map<string, Map<string, "member" | "owner">>();
    const down = { now: false };
    let n = 0;
    return {
      components: [demo(members, flaws, down)],
      source: "demo",
      member: async (_app, _ctx, role) => {
        const principal = { channel: "web", id: `u-${++n}` };
        const space = `demo:space-${n}`;
        members.set(principalKey(principal), new Map([[space, role]]));
        return { principals: [principal], space };
      },
      remove: async (_app, _ctx, member) => {
        for (const principal of member.principals) members.get(principalKey(principal))?.delete(member.space);
      },
      fail: () => void (down.now = true),
    };
  })) {
    await c.run().catch(() => failed.push(c.name));
  }
  return failed;
}

test("a correct stage passes every case", async () => {
  expect(await failing({})).toEqual([]);
});

test("a stage that replaces an earlier stage's grants, or appends another source's by hand, is caught", async () => {
  expect(await failing({ replaces: true })).toEqual(["the stage appends only its own source's grants, and leaves an earlier stage's as they are", "a provider that fails grants nothing, and the pipeline goes on"]);
  expect(await failing({ foreignByHand: true })).toEqual(["the stage appends only its own source's grants, and leaves an earlier stage's as they are", "a provider that fails grants nothing, and the pipeline goes on"]);
});

test("a stage that grants strangers, keeps a removed member, or throws by hand is caught; audienceStage drops another space's grant", async () => {
  expect(await failing({ grantsStrangers: true })).toEqual(["a stranger is granted nothing"]);
  expect(await failing({ cachesRemoval: true })).toEqual(["a removed membership is granted nothing at the fresh check, at once"]);
  expect(await failing({ throwsByHand: true })).toEqual(["a provider that fails grants nothing, and the pipeline goes on"]);
  // A provider that answers other spaces to a fresh check is cut by audienceStage: nothing to catch.
  expect(await failing({ ignoresSpace: true })).toEqual([]);
});

test("audienceGrants: deduplicated, fail closed on a throw or a halt, malformed and foreign grants dropped, past AUDIENCE_MAX a limit", async () => {
  const warnings: string[] = [];
  const mode = { value: "ok" as "ok" | "flood" | "halt" | "throw" | "odd" };
  const component = defineComponent({
    name: "audience-helpers-test",
    setup(pikit) {
      pikit.pipeline(
        "conversation.audience",
        audienceStage("a", {
          async grants(_principals, space) {
            if (mode.value === "flood") return Array.from({ length: AUDIENCE_MAX + 1 }, (_, n) => ({ space: `s${n}`, role: "member" as const }));
            if (mode.value === "odd") return [{ space: "", role: "member" }, { space: "s1", role: "admin" as never }, { space: "s1", role: "member", source: "b" } as never, "x" as never];
            const all = [{ space: "s1", role: "member" as const }, { space: "s1", role: "member" as const }, { space: "s2", role: "owner" as const }];
            return all.filter((grant) => space === undefined || grant.space === space);
          },
        }),
        { id: "a" },
      );
      pikit.pipeline("conversation.audience", (value) => (mode.value === "halt" ? pikit.halt("no") : mode.value === "throw" ? Promise.reject(new Error("broken")) : value), { id: "after" });
    },
  });
  const app = await defineApp({ components: [component], logger: { ...silentLogger, warn: (message: string) => void warnings.push(message) } }).create();
  await app.start();
  const ctx = app.context();
  const ana = [{ channel: "web", id: "u-ana" }];
  expect(await audienceGrants(ctx, ana)).toEqual([
    { space: "s1", role: "member", source: "a" },
    { space: "s2", role: "owner", source: "a" },
  ]);
  expect(await audienceGrants(ctx, ana, "s2")).toEqual([{ space: "s2", role: "owner", source: "a" }]);
  mode.value = "odd";
  expect(await audienceGrants(ctx, ana)).toEqual([]);
  expect(warnings.some((each) => each.includes("may not give"))).toBe(true);
  mode.value = "halt";
  expect(await audienceGrants(ctx, ana)).toEqual([]);
  mode.value = "throw";
  expect(await audienceGrants(ctx, ana)).toEqual([]);
  mode.value = "flood";
  const error = await audienceGrants(ctx, ana).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DirectoryError);
  expect((error as DirectoryError).code).toBe("limit");
  await app.stop();
});

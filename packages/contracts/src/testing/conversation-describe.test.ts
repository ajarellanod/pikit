// The conversation.describe suite catches channel stages that break the contract (each channel's
// tests run it on theirs), and the helpers enforce what the contract says of what is shown.

import { expect, test } from "bun:test";
import { type AppContext, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { channelKindOf, cleanParty, type ConversationDescriber, describeConversation, describeStage, PARTY_LIMITS } from "../conversation-describe.ts";
import { createConversationDescribeConformance, HOSTILE_NAME } from "./conversation-describe.ts";

type Flaws = { claimsForeign?: boolean; throwsUnknown?: boolean; noIds?: boolean; overwrites?: boolean };

/** A channel `demo` whose keys are `demo:<digits>`, with the names it received in `names`. */
function demo(names: Map<string, string>, flaws: Flaws = {}) {
  return defineComponent({
    name: "describe-test",
    setup(pikit) {
      const describer: ConversationDescriber = {
        async describe(key) {
          const chat = /^demo:(\d+)$/.exec(key)?.[1];
          if (chat === undefined && flaws.claimsForeign !== true) return undefined;
          const name = names.get(key);
          if (name === undefined && flaws.throwsUnknown === true) throw new Error("no record");
          return { ...(name !== undefined && { name }), detail: "Direct message", ids: flaws.noIds === true && name === undefined ? [] : [{ label: "Chat id", value: chat ?? key }] };
        },
      };
      const stage = describeStage(describer);
      // A stage written by hand, which describes whatever came before it.
      const overwriting = async (value: { key: string }, ctx: AppContext) => stage({ key: value.key }, ctx);
      pikit.pipeline("conversation.describe", flaws.overwrites === true ? overwriting : stage, { id: "demo" });
    },
  });
}

async function failing(flaws: Flaws): Promise<string[]> {
  const failed: string[] = [];
  for (const c of createConversationDescribeConformance(() => {
    const names = new Map<string, string>();
    return {
      components: [demo(names, flaws)],
      kind: "demo",
      known: async () => {
        names.set("demo:7", "Ana López");
        return {
          key: "demo:7",
          check: (party) => {
            if (party.name !== "Ana López" || party.ids[0]?.value !== "7") throw new Error(`not Ana: ${JSON.stringify(party)}`);
          },
        };
      },
      unknown: "demo:8",
      foreign: ["demo:ops:7"],
      hostile: async () => {
        names.set("demo:9", HOSTILE_NAME);
        return "demo:9";
      },
    };
  })) {
    await c.run().catch(() => failed.push(c.name));
  }
  return failed;
}

test("a correct channel passes every case", async () => {
  expect(await failing({})).toEqual([]);
});

test("a channel that describes keys it did not make, cannot describe one it made with no record, or loses its ids is caught", async () => {
  expect(await failing({ claimsForeign: true })).toEqual(["another channel's key, or one it did not make, is left undescribed"]);
  // describeStage keeps the throw from stopping the pipeline: the key is just not described.
  expect(await failing({ throwsUnknown: true })).toEqual(["a key it made but knows nothing of is described by its ids, without a throw"]);
  expect(await failing({ noIds: true })).toEqual(["a key it made but knows nothing of is described by its ids, without a throw"]);
});

test("a stage that overwrites what an earlier stage described is caught", async () => {
  expect(await failing({ overwrites: true })).toEqual(["a conversation another stage described first is left as that stage said"]);
});

test("channelKindOf: the key's first segment, when it is a kind", () => {
  expect(channelKindOf("telegram:ops:12")).toBe("telegram");
  expect(channelKindOf("web:u1:c1")).toBe("web");
  expect(channelKindOf("googlechat:spaces/AAA")).toBe("googlechat");
  expect(channelKindOf("telegram")).toBeUndefined();
  expect(channelKindOf(":1")).toBeUndefined();
  expect(channelKindOf("Telegram:1")).toBeUndefined();
  expect(channelKindOf("tele gram:1")).toBeUndefined();
});

test("cleanParty: hidden characters, lengths, ids, a link that is not a dashboard path, an instance's name", () => {
  const bell = String.fromCharCode(7);
  const override = String.fromCharCode(0x202e);
  const cleaned = cleanParty({
    name: `  Ana${bell}\n  López${override} `,
    detail: "d".repeat(500),
    ids: [
      { label: "Chat id", value: "1" },
      { label: "", value: "2" },
      { label: "Too long", value: "x".repeat(PARTY_LIMITS.value + 1) },
      "not an id",
      { label: "Two", value: "2" },
      { label: "Three", value: "3" },
      { label: "Four", value: "4" },
      { label: "Five", value: "5" },
    ],
    link: { label: "Web users", path: "/channel-web?user=u1" },
    instance: "ops",
    secret: "never copied",
  });
  expect(cleaned).toEqual({
    name: "Ana López",
    detail: `${"d".repeat(PARTY_LIMITS.detail - 1)}${String.fromCharCode(0x2026)}`,
    ids: [
      { label: "Chat id", value: "1" },
      { label: "Two", value: "2" },
      { label: "Three", value: "3" },
      { label: "Four", value: "4" },
    ],
    link: { label: "Web users", path: "/channel-web?user=u1" },
    instance: "ops",
  });
  for (const path of ["//evil.example/x", "https://evil.example/", "channel-web", "/a b", `/a${bell}`, "/\\evil"]) {
    expect(cleanParty({ ids: [], link: { label: "Go", path } })).toEqual({ ids: [] });
  }
  expect(cleanParty({ ids: "no", instance: "Ops!" })).toEqual({ ids: [] });
  expect(cleanParty({ name: "   ", ids: [] })).toEqual({ ids: [] });
  expect(cleanParty("Ana")).toBeUndefined();
  expect(cleanParty(null)).toBeUndefined();
  expect(cleanParty([])).toBeUndefined();
});

test("describeConversation: the first stage that knows the key, cleaned; nothing when none does, a describer throws (logged, the others still run) or a stage halts", async () => {
  const warnings: string[] = [];
  const channels = defineComponent({
    name: "channels-test",
    setup(pikit) {
      const of = (prefix: string, describe: ConversationDescriber["describe"]) => pikit.pipeline("conversation.describe", describeStage({ describe }), { id: prefix });
      of("broken", async (key) => (key.startsWith("broken:") || key.startsWith("demo:") ? Promise.reject(new Error("down")) : undefined));
      of("demo", async (key) => (key === "demo:1" ? { name: `A${String.fromCharCode(0)}na`, ids: [{ label: "Chat id", value: "1" }] } : undefined));
      of("odd", async (key) => (key.startsWith("odd:") ? ("Ana" as never) : undefined));
      pikit.pipeline("conversation.describe", (value) => (value.key === "halt:1" ? pikit.halt("no") : value), { id: "halting" });
    },
  });
  const app = await defineApp({ components: [channels], logger: { ...silentLogger, warn: (message: string) => void warnings.push(message) } }).create();
  await app.start();
  const ctx = app.context();
  expect(await describeConversation(ctx, "demo:1")).toEqual({ name: "A na", ids: [{ label: "Chat id", value: "1" }] });
  expect(warnings).toHaveLength(1);
  expect(await describeConversation(ctx, "demo:2")).toBeUndefined();
  expect(await describeConversation(ctx, "nobody:1")).toBeUndefined();
  expect(await describeConversation(ctx, "odd:1")).toBeUndefined();
  expect(await describeConversation(ctx, "halt:1")).toBeUndefined();
  await app.stop();
});

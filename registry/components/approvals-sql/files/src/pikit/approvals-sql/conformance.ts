/**
 * The `approvals` conformance suite (`contract.ts`): the public behaviour every provider shows, for any
 * test runner. A fixture gives the components of one App that provides `approvals` (the provider and
 * what it needs); `app()` is called again for a restart, and must reach the same storage.
 *
 *   for (const c of createApprovalsConformance(() => fixture())) test(`${c.group}: ${c.name}`, () => c.run());
 */

import { defineApp, defineComponent, type App, type ComponentDefinition, silentLogger } from "@pikit/core";
import type { Sender } from "@pikit/contracts";
import { type ConformanceCase, createManualClock, type ManualClock } from "@pikit/core/testing";
import { type ApprovalRequest, type ApprovalStore, actionHash } from "./contract.ts";

export type ApprovalsFixture = { app: () => ComponentDefinition[] };

const GROUP = "approvals";
const HOUR = 3_600_000;
const owner: Sender = { channel: "telegram", id: "1001" };
const stranger: Sender = { channel: "telegram", id: "2002" };
const operator: Sender = { channel: "dashboard", id: "ops" };

const request = (key: string, payload: Record<string, string> = { command: "ls" }, extra: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  idempotencyKey: key,
  action: { type: "tool:bash", payload },
  title: "Run a command",
  summary: "To list the files",
  approvers: ["telegram:1001", "dashboard:*"],
  requestedBy: { conversation: { key: "telegram:1001", agent: "assistant", conversationId: "c1" }, sender: owner },
  ...extra,
});

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`approvals conformance: ${message}`);
}
const same = (actual: unknown, expected: unknown, what: string) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

export function createApprovalsConformance(fixture: () => ApprovalsFixture): ConformanceCase[] {
  /** A started App of the fixture on `clock`, its store, and a restart over the same storage. */
  const open = async (f: ApprovalsFixture, clock: ManualClock) => {
    let store: ApprovalStore | undefined;
    const reader = defineComponent({
      name: "approvals-reader",
      setup(pikit) {
        const approvals = pikit.use("approvals");
        return { start: () => void (store = approvals.get()) };
      },
    });
    const app: App = await defineApp({ components: [...f.app(), reader], clock, logger: silentLogger }).create();
    await app.start();
    if (store === undefined) throw new Error("approvals conformance: the fixture's App provides no approvals");
    return { app, store, ctx: app.context() };
  };
  const scenario = (name: string, run: (s: Awaited<ReturnType<typeof open>> & { clock: ManualClock; restart: () => Promise<Awaited<ReturnType<typeof open>>> }) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    async run() {
      const f = fixture();
      const clock = createManualClock();
      let current = await open(f, clock);
      try {
        await run({
          ...current,
          clock,
          restart: async () => {
            await current.app.stop();
            current = await open(f, clock);
            return current;
          },
        });
      } finally {
        await current.app.stop();
      }
    },
  });

  return [
    scenario("a proposal is pending, with its action's hash; the same key and action again is the same approval", async ({ store, ctx }) => {
      const first = await store.propose(request("k1"), ctx);
      const again = await store.propose(request("k1"), ctx);
      same(first.status, "pending", "status");
      same(first.actionHash, await actionHash({ type: "tool:bash", payload: { command: "ls" } }), "actionHash");
      same(again, first, "the second proposal");
      same((await store.list({}, ctx)).items.length, 1, "approvals stored");
    }),

    scenario("the same key with another action is refused as a conflict; a malformed request or no approvers as invalid", async ({ store, ctx }) => {
      await store.propose(request("k1"), ctx);
      const code = (error: unknown) => (error as { code?: string }).code;
      const refused = async (work: Promise<unknown>) => work.then(() => "accepted", code);
      same(await refused(store.propose(request("k1", { command: "rm -rf /" }), ctx)), "conflict", "another action under a key");
      same(await refused(store.propose(request("k2", { command: "ls" }, { approvers: [] }), ctx)), "invalid", "no approvers");
      same(await refused(store.propose(request("k3", { command: "ls" }, { approvers: ["anyone"] }), ctx)), "invalid", "an approver without a channel");
      same(await refused(store.propose({ ...request("k4"), title: "" }, ctx)), "invalid", "no title");
      same((await store.list({}, ctx)).items.length, 1, "approvals stored");
    }),

    scenario("an approver decides; the same verdict again changes nothing, the other is not_pending", async ({ store, ctx, clock }) => {
      const { id } = await store.propose(request("k1"), ctx);
      const decided = await store.decide(id, { verdict: "approve", by: owner }, ctx);
      check(decided.ok, "an approver's decision is recorded");
      same([decided.approval.status, decided.approval.decidedBy], ["approved", owner], "the decision");
      await clock.advance(1_000);
      const again = await store.decide(id, { verdict: "approve", by: owner }, ctx);
      check(again.ok, "the same verdict again is ok");
      same(again.approval.decidedAt, decided.approval.decidedAt, "decidedAt after a repeat");
      same(await store.decide(id, { verdict: "reject", by: owner }, ctx), { ok: false, code: "not_pending" }, "the other verdict");
    }),

    scenario("someone the approvers do not name is forbidden and nothing is recorded; <channel>:* names anyone on that channel only", async ({ store, ctx }) => {
      const { id } = await store.propose(request("k1"), ctx);
      same(await store.decide(id, { verdict: "approve", by: stranger }, ctx), { ok: false, code: "forbidden" }, "a stranger");
      same(await store.decide(id, { verdict: "approve", by: { channel: "telegram", id: "*" } }, ctx), { ok: false, code: "forbidden" }, "an id that is a star");
      same(await store.decide(id, { verdict: "approve", by: { channel: "web", id: "ops" } }, ctx), { ok: false, code: "forbidden" }, "the right id on another channel");
      same((await store.list({ status: "pending" }, ctx)).items.map((a) => a.id), [id], "still pending");
      const operatorDecided = await store.decide(id, { verdict: "reject", by: operator }, ctx);
      check(operatorDecided.ok && operatorDecided.approval.status === "rejected", "dashboard:* lets any operator decide");
    }),

    scenario("a channel instance (a channel with a `:`) is a channel of its own: its exact sender and its `:*` decide, `<channel>:*` does not cover it", async ({ store, ctx }) => {
      const ops = { channel: "telegram:ops", id: "12345" };
      const exact = await store.propose(request("k1", { command: "ls" }, { approvers: ["telegram:ops:12345"] }), ctx);
      const wildcard = await store.propose(request("k2", { command: "pwd" }, { approvers: ["googlechat:ops:*"] }), ctx);
      const plain = await store.propose(request("k3", { command: "id" }, { approvers: ["telegram:*"] }), ctx);
      const exactDecided = await store.decide(exact.id, { verdict: "approve", by: ops }, ctx);
      check(exactDecided.ok && exactDecided.approval.status === "approved", "the instance's exact sender decides");
      same(exactDecided.approval.decidedBy, ops, "decidedBy keeps the instance");
      same(await store.decide(exact.id, { verdict: "approve", by: { channel: "telegram", id: "12345" } }, ctx), { ok: false, code: "forbidden" }, "the same id on the plain channel");
      same(await store.decide(wildcard.id, { verdict: "approve", by: { channel: "googlechat", id: "users/1" } }, ctx), { ok: false, code: "forbidden" }, "the plain channel under an instance's star");
      check((await store.decide(wildcard.id, { verdict: "approve", by: { channel: "googlechat:ops", id: "users/1" } }, ctx)).ok, "anyone on the instance under its star");
      same(await store.decide(plain.id, { verdict: "approve", by: ops }, ctx), { ok: false, code: "forbidden" }, "an instance under the plain channel's star");
      check((await store.decide(plain.id, { verdict: "approve", by: { channel: "telegram", id: "9" } }, ctx)).ok, "the plain channel under its star");
    }),

    scenario("an unknown approval is not_found", async ({ store, ctx }) => {
      same(await store.decide("nope", { verdict: "approve", by: owner }, ctx), { ok: false, code: "not_found" }, "an unknown id");
    }),

    scenario("past its expiry an approval can be neither decided nor claimed, and reads expired", async ({ store, ctx, clock }) => {
      const pending = await store.propose(request("k1", { command: "ls" }, { expiresAt: clock.now() + HOUR }), ctx);
      const approved = await store.propose(request("k2", { command: "pwd" }, { expiresAt: clock.now() + HOUR }), ctx);
      check((await store.decide(approved.id, { verdict: "approve", by: owner }, ctx)).ok, "decided in time");
      await clock.advance(HOUR);
      same(await store.decide(pending.id, { verdict: "approve", by: owner }, ctx), { ok: false, code: "expired" }, "a late decision");
      same(await store.claim({ actionHash: approved.actionHash, conversationId: "c1", claimant: "t1" }, ctx), undefined, "a late claim");
      same((await store.list({ status: "expired" }, ctx)).items.map((a) => a.id).sort(), [pending.id, approved.id].sort(), "the expired ones");
    }),

    scenario("a claim takes an approved action once: the same claimant again gets it, any other claimant gets none", async ({ store, ctx }) => {
      const { id, actionHash: hash } = await store.propose(request("k1"), ctx);
      same(await store.claim({ actionHash: hash, conversationId: "c1", claimant: "t1" }, ctx), undefined, "a pending one");
      check((await store.decide(id, { verdict: "approve", by: owner }, ctx)).ok, "approved");
      const claimed = await store.claim({ actionHash: hash, conversationId: "c1", claimant: "t1" }, ctx);
      same([claimed?.id, claimed?.status, claimed?.claimedBy], [id, "claimed", "t1"], "the claim");
      same((await store.claim({ actionHash: hash, conversationId: "c1", claimant: "t1" }, ctx))?.id, id, "the same claimant again");
      same(await store.claim({ actionHash: hash, conversationId: "c1", claimant: "t2" }, ctx), undefined, "another claimant");
    }),

    scenario("a claim needs the exact action, from the conversation that asked, approved and not rejected", async ({ store, ctx }) => {
      const approved = await store.propose(request("k1"), ctx);
      const rejected = await store.propose(request("k2", { command: "pwd" }), ctx);
      check((await store.decide(approved.id, { verdict: "approve", by: owner }, ctx)).ok, "approved");
      check((await store.decide(rejected.id, { verdict: "reject", by: owner }, ctx)).ok, "rejected");
      const other = await actionHash({ type: "tool:bash", payload: { command: "ls -a" } });
      same(await store.claim({ actionHash: other, conversationId: "c1", claimant: "t1" }, ctx), undefined, "other arguments");
      same(await store.claim({ actionHash: approved.actionHash, conversationId: "c2", claimant: "t2" }, ctx), undefined, "another conversation");
      same(await store.claim({ actionHash: rejected.actionHash, conversationId: "c1", claimant: "t3" }, ctx), undefined, "a rejected one");
    }),

    scenario("two claimants at once of one approval: exactly one gets it", async ({ store, ctx }) => {
      const { id, actionHash: hash } = await store.propose(request("k1"), ctx);
      check((await store.decide(id, { verdict: "approve", by: owner }, ctx)).ok, "approved");
      const claims = await Promise.all(["t1", "t2", "t3", "t4"].map((claimant) => store.claim({ actionHash: hash, conversationId: "c1", claimant }, ctx)));
      same(claims.filter((claim) => claim !== undefined).length, 1, "claims granted");
    }),

    scenario("settle records the outcome once, by its claimant", async ({ store, ctx }) => {
      const { id, actionHash: hash } = await store.propose(request("k1"), ctx);
      check((await store.decide(id, { verdict: "approve", by: owner }, ctx)).ok, "approved");
      await store.claim({ actionHash: hash, conversationId: "c1", claimant: "t1" }, ctx);
      same(await store.settle("t2", { kind: "executed" }, ctx), undefined, "another claimant");
      same((await store.settle("t1", { kind: "failed", detail: "exit 1" }, ctx))?.status, "failed", "the claimant");
      const again = await store.settle("t1", { kind: "executed" }, ctx);
      same([again?.status, again?.detail], ["failed", "exit 1"], "settled again");
    }),

    scenario("approvals and claims survive a restart", async ({ store, ctx, restart }) => {
      const { id, actionHash: hash } = await store.propose(request("k1"), ctx);
      check((await store.decide(id, { verdict: "approve", by: owner }, ctx)).ok, "approved");
      const after = await restart();
      same((await after.store.claim({ actionHash: hash, conversationId: "c1", claimant: "t1" }, after.ctx))?.id, id, "claimed after a restart");
      const again = await restart();
      same(await again.store.claim({ actionHash: hash, conversationId: "c1", claimant: "t2" }, again.ctx), undefined, "another claimant after a second restart");
    }),

    scenario("list is newest first, by pages, and by status", async ({ store, ctx, clock }) => {
      const ids: string[] = [];
      for (const n of [1, 2, 3]) {
        ids.push((await store.propose(request(`k${n}`, { command: `echo ${n}` }), ctx)).id);
        await clock.advance(1);
      }
      check((await store.decide(ids[0] as string, { verdict: "approve", by: owner }, ctx)).ok, "approved");
      const first = await store.list({ limit: 2 }, ctx);
      same(first.items.map((a) => a.id), [ids[2], ids[1]], "the first page");
      check(first.next !== undefined, "a next page");
      const second = await store.list({ limit: 2, cursor: first.next }, ctx);
      same([second.items.map((a) => a.id), second.next], [[ids[0]], undefined], "the last page");
      same((await store.list({ status: "approved" }, ctx)).items.map((a) => a.id), [ids[0]], "the approved ones");
    }),
  ];
}

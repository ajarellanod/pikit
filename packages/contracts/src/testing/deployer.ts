/**
 * The deployer protocol (`../deployer.ts`): an app's `proposals` provider that writes decisions for a
 * deployer, and the deployer that reads them and writes back what happened, run against each other on
 * the shared directory's files. Runner-independent:
 *
 *   for (const c of createDeployerProtocolConformance(() => myFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The fixture pairs the two real sides (proposals-local and deployment-docker's deployer, with a fake
 * Docker whose checks pass): proposing and pushing again are the agent's, a pass is the deployer's.
 * The suite checks what crosses the files: the approval's exact fields, the head the deployer
 * deploys, and its outcome and checks keyed by that head, as the provider reads them.
 */

import { type AppContext, type ComponentDefinition, defineApp, defineComponent, type Handle, silentLogger } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { Operator } from "../admin.ts";
import { DECISIONS_FILE, type Decision, DEPLOYER_STATE_FILE, type DeployerState } from "../deployer.ts";
import type { Proposals } from "../proposals.ts";
import { checker, expecter } from "./assert.ts";

export interface DeployerProtocolFixture {
  /** The components of an App that provides `proposals` and writes decisions for the deployer, on the shared directory. */
  components(): ComponentDefinition[];
  config?: Record<string, unknown>;
  /** The agent proposing: a branch `<prefix><topic>` from main with one commit; resolves with its id and head. */
  propose(topic: string): Promise<{ id: string; head: string }>;
  /** The agent pushing again on proposal `id`; resolves with the new head. */
  pushAgain(id: string): Promise<string>;
  /** One pass of the deployer over the shared directory. */
  pass(): Promise<void>;
  /** The commits the deployer built an image of, in order. */
  built(): Promise<string[]>;
  /** A file of the shared directory as written (`DECISIONS_FILE`, `DEPLOYER_STATE_FILE`); `undefined` when missing. */
  read(name: string): Promise<string | undefined>;
  dispose?(): Promise<void>;
}

const GROUP = "deployer protocol";
const expect = expecter(GROUP);
const check = checker(GROUP);
const OPERATOR: Operator = { id: "operator-1" };
const CHECK_STATES = ["passing", "failing", "pending", "skipped"];

interface Running {
  proposals: Proposals;
  ctx: AppContext;
  fixture: DeployerProtocolFixture;
}

export function createDeployerProtocolConformance(factory: () => DeployerProtocolFixture | Promise<DeployerProtocolFixture>): readonly ConformanceCase[] {
  const protocolCase = (name: string, run: (running: Running) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      let handle: Handle<Proposals> | undefined;
      const consumer = defineComponent({ name: "deployer-protocol", setup: (pikit) => void (handle = pikit.use("proposals")) });
      const app = await defineApp({ components: [...fixture.components(), consumer], logger: silentLogger, ...(fixture.config !== undefined && { config: fixture.config }) }).create();
      try {
        await app.start();
        if (handle === undefined) throw new Error(`${GROUP}: the consumer did not set up`);
        await run({ proposals: handle.get(), ctx: app.context(), fixture });
      } finally {
        await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });
  const json = async <T>(fixture: DeployerProtocolFixture, name: string): Promise<T | undefined> => {
    const text = await fixture.read(name);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  };
  const decisionsOf = async (fixture: DeployerProtocolFixture) => (await json<{ decisions?: Decision[] }>(fixture, DECISIONS_FILE))?.decisions ?? [];
  const stateOf = async (fixture: DeployerProtocolFixture) => (await json<DeployerState>(fixture, DEPLOYER_STATE_FILE)) ?? {};

  return [
    protocolCase("an approval writes exactly the id, the branch, the head read, approved, the operator, when and the title", async ({ proposals, ctx, fixture }) => {
      const made = await fixture.propose("greeting");
      const detail = await proposals.get(made.id, ctx);
      const outcome = await proposals.approve(made.id, { head: detail.head, operator: OPERATOR }, ctx);
      check(outcome.ok, `the approval to be accepted (${JSON.stringify(outcome)})`);
      const written = (await decisionsOf(fixture)).filter((decision) => decision.id === made.id);
      expect(written.length, 1, `the decisions in ${DECISIONS_FILE} for ${made.id}`);
      const decision = written[0] as Decision;
      expect(Object.keys(decision).sort(), ["at", "branch", "decision", "head", "id", "operator", "title"], "the decision's fields");
      expect({ ...decision, at: undefined }, { id: made.id, branch: detail.branch, head: made.head, decision: "approved", operator: OPERATOR.id, title: detail.title }, "the decision");
      check(!Number.isNaN(Date.parse(decision.at)), `its time to be ISO 8601 (${decision.at})`);
    }),

    protocolCase("a rejection carries its comment, and the deployer never deploys it", async ({ proposals, ctx, fixture }) => {
      const made = await fixture.propose("risky");
      const outcome = await proposals.reject(made.id, { comment: "Not now.", operator: OPERATOR }, ctx);
      check(outcome.ok, "the rejection to be accepted");
      const decision = (await decisionsOf(fixture)).find((each) => each.id === made.id);
      expect({ decision: decision?.decision, head: decision?.head, comment: decision?.comment }, { decision: "rejected", head: made.head, comment: "Not now." }, "the rejection");
      await fixture.pass();
      expect(await fixture.built(), [], "what the deployer built");
      expect((await stateOf(fixture)).outcomes?.[made.head], undefined, "an outcome for the rejected head");
    }),

    protocolCase("the deployer deploys the approved head; its outcome and checks, keyed by it, are the proposal's as the provider reads them", async ({ proposals, ctx, fixture }) => {
      const made = await fixture.propose("notes");
      await proposals.approve(made.id, { head: made.head, operator: OPERATOR }, ctx);
      await fixture.pass();
      expect(await fixture.built(), [made.head], "what the deployer built");
      const state = await stateOf(fixture);
      const outcome = state.outcomes?.[made.head];
      expect({ id: outcome?.id, outcome: outcome?.outcome }, { id: made.id, outcome: "deployed" }, `the outcome in ${DEPLOYER_STATE_FILE}`);
      const steps = outcome?.checks ?? [];
      check(steps.length > 0, "the deployer to record its checks");
      for (const step of steps) check(typeof step.name === "string" && CHECK_STATES.includes(step.state) && typeof step.detail === "string", `a check with a name, a state and a detail (${JSON.stringify(step)})`);
      const detail = await proposals.get(made.id, ctx);
      expect({ state: detail.state, outcome: detail.deploy?.outcome }, { state: "merged", outcome: "deployed" }, "the proposal's state and deploy");
      expect(
        detail.checks.items.map((item) => [item.name, item.state]),
        steps.map((step) => [step.name, step.state]),
        "the proposal's checks",
      );
      expect((await proposals.status(ctx)).deploys?.lastDeploy?.head, made.head, "the status's last deploy");
    }),

    protocolCase("a head pushed after the approval is never deployed; the refusal is keyed by the approved head, and the provider reads it", async ({ proposals, ctx, fixture }) => {
      const made = await fixture.propose("moving");
      await proposals.approve(made.id, { head: made.head, operator: OPERATOR }, ctx);
      const pushed = await fixture.pushAgain(made.id);
      await fixture.pass();
      expect(await fixture.built(), [], "what the deployer built");
      const state = await stateOf(fixture);
      expect(state.outcomes?.[made.head]?.outcome, "failed", "the approved head's outcome");
      expect(state.outcomes?.[pushed], undefined, "an outcome for the head nobody approved");
      expect((await proposals.status(ctx)).deploys?.lastFailure?.head, made.head, "the status's last failure");
      expect((await proposals.get(made.id, ctx)).state, "open", "the new head's state");
    }),
  ];
}

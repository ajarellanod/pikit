/**
 * `agent.state` conformance (SPEC §6.2a, §14): what every `AgentState` must do, wherever the
 * conversation's state is stored. Runner-independent, like the lifecycle suite:
 *
 *   for (const c of createAgentStateConformance(() => myFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The fixture opens one conversation per case, then gives the suite that same conversation in a new
 * worker (the state must survive) and after a reset (it must start fresh).
 */

import { BACKGROUND_CONTEXT } from "../context.ts";
import type { AgentState } from "../contracts/agent-state.ts";
import { checker, expecter } from "./assert.ts";
import type { ConformanceCase } from "./lifecycle.ts";

/** One conversation's state, built for one case. */
export interface AgentStateFixture {
  /** The state of a new conversation whose agent declares `initial`. Called once per case. */
  open(initial: Record<string, unknown>): Promise<AgentState>;
  /**
   * The same conversation in a new worker: what the previous worker's handle committed is read back
   * from storage, not from its memory. The previous handle is not used again.
   */
  reopen(): Promise<AgentState>;
  /** The same conversation after a reset: a new session, so the state starts from `initial`. */
  reset(): Promise<AgentState>;
  /** Release what the fixture holds. */
  dispose?(): Promise<void>;
}

const GROUP = "agent.state";
const expect = expecter(GROUP);
const check = checker(GROUP);
const ctx = BACKGROUND_CONTEXT;

const INITIAL = { phase: "testing", testsPassed: false, notes: ["start"], limits: { retries: 2 } };

export function createAgentStateConformance(
  factory: () => AgentStateFixture | Promise<AgentStateFixture>,
): readonly ConformanceCase[] {
  const stateCase = (name: string, run: (fixture: AgentStateFixture, state: AgentState) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      try {
        await run(fixture, await fixture.open(structuredClone(INITIAL)));
      } finally {
        await fixture.dispose?.();
      }
    },
  });

  return [
    stateCase("a new conversation's state is the agent's initial state", async (_, state) => {
      expect(await state.get(ctx), INITIAL, "get() before any update");
    }),

    stateCase("update merges the patch key by key and resolves with the new state", async (_, state) => {
      const next = await state.update({ phase: "deploying", reviewer: null }, ctx);

      const expected = { ...INITIAL, phase: "deploying", reviewer: null };
      expect(next, expected, "what update() resolved with");
      expect(await state.get(ctx), expected, "get() after update()");
    }),

    stateCase("a nested value is replaced, not merged", async (_, state) => {
      await state.update({ limits: { timeoutMs: 10 } }, ctx);

      expect((await state.get(ctx)).limits, { timeoutMs: 10 }, "limits after the update");
    }),

    stateCase("get() returns a copy: changing it changes nothing", async (_, state) => {
      const read = (await state.get(ctx)) as typeof INITIAL;
      read.phase = "changed";
      read.notes.push("changed");
      read.limits.retries = 99;

      expect(await state.get(ctx), INITIAL, "get() after mutating a previous result");
    }),

    stateCase("a patch changed after update() does not change the state", async (_, state) => {
      const patch = { notes: ["one"] };
      await state.update(patch, ctx);
      patch.notes.push("two");

      expect((await state.get(ctx)).notes, ["one"], "notes after mutating the patch");
    }),

    stateCase("concurrent updates of different keys all land", async (_, state) => {
      await Promise.all(Array.from({ length: 10 }, (_, i) => state.update({ [`key${i}`]: i }, ctx)));

      const current = await state.get(ctx);
      for (let i = 0; i < 10; i++) expect(current[`key${i}`], i, `key${i} after ten concurrent updates`);
    }),

    stateCase("a patch that is not JSON is rejected and changes nothing", async (_, state) => {
      const invalid: Record<string, unknown>[] = [
        { phase: () => "deploying" },
        { phase: undefined },
        { count: Number.NaN },
        { at: new Date(0) },
        { nested: { deep: [1, () => 2] } },
      ];
      for (const patch of invalid) {
        const rejected = await state.update(patch, ctx).then(
          () => false,
          () => true,
        );
        check(rejected, `update(${Object.keys(patch).join(", ")}) with a value that is not JSON to reject`);
      }
      expect(await state.get(ctx), INITIAL, "get() after the rejected updates");
    }),

    stateCase("a committed update survives a new worker", async (fixture, state) => {
      await state.update({ phase: "deploying", testsPassed: true }, ctx);

      const reopened = await fixture.reopen();

      expect(await reopened.get(ctx), { ...INITIAL, phase: "deploying", testsPassed: true }, "get() in the new worker");
    }),

    stateCase("a reset starts from the initial state", async (fixture, state) => {
      await state.update({ phase: "deploying" }, ctx);

      const fresh = await fixture.reset();

      expect(await fresh.get(ctx), INITIAL, "get() after the reset");
      await fresh.update({ testsPassed: true }, ctx);
      expect(await fresh.get(ctx), { ...INITIAL, testsPassed: true }, "get() after an update on the new session");
    }),
  ];
}

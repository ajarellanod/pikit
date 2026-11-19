/**
 * `actor.kind`'s equivalence suite (SPEC C9): an object of a kind's key answers as it would running
 * the whole App. Runner-independent:
 *
 *   for (const c of createActorKindConformance(() => myFixture())) test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The fixture opens a fresh object of one of the kind's keys (empty storage) twice, once running the
 * whole App and once running the kind's App, as its host composes them; the suite makes the same
 * calls and messages to each, in order, and checks:
 * - every step has the same outcome (a call's answer or code, a message taken or refused);
 * - the object stores the same rows afterwards;
 * - the kind's start called or sent to no other actor (a kind's object starts no cascade of objects).
 *
 * The whole App of the same project is `withoutActorKinds(components)`: its components with their
 * `actor.kind` declarations dropped, what a project gets by deleting a declaration's line. A component
 * that answers on the kind's keys without declaring them is what the suite catches: its step is
 * answered in the whole App and `no_handler` in the kind's.
 */

import type { ComponentDefinition, Pikit } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { ActorCallOutcome } from "../actor.ts";
import type { JsonValue } from "../json.ts";
import { equal } from "./assert.ts";

/** One step: a message (`actor.mailbox.send`) or a call (`actor.mailbox.call`) to the object. */
export type ActorKindStep = { readonly send: string; readonly message: JsonValue } | { readonly call: string; readonly message: JsonValue };

/** An object of the fixture's key, started with one of the two Apps. */
export interface ActorKindObject {
  /** Delivers a message, as `actor.mailbox.send` reaches the object; rejects as it does. */
  send(type: string, message: JsonValue): Promise<void>;
  /** Calls the object, as `actor.mailbox.call` reaches it: the outcome, a refusal included. */
  call(type: string, message: JsonValue): Promise<ActorCallOutcome>;
  /** What the object keeps, as JSON two objects can be compared by (its tables' rows, without times the steps did not set). */
  rows(): Promise<JsonValue>;
  /** The keys of the other actors its start called or sent to, in order. */
  startCalls(): readonly string[];
  close?(): Promise<void>;
}

export interface ActorKindFixture {
  /** One of the kind's keys. */
  readonly key: string;
  /** What the suite asks, in order: the kind's own types, as its callers send them. */
  readonly steps: readonly ActorKindStep[];
  /** A fresh object of `key` (nothing stored), started with the whole App or its kind's. */
  open(app: "whole" | "kind"): Promise<ActorKindObject>;
  /** A call's answer as it is compared (default: as it is), for answers that hold ids or times. */
  comparable?(answer: JsonValue): JsonValue;
}

const GROUP = "actor.kind";

/** `components` with their `actor.kind` declarations dropped: the same project, every object running the whole App. */
export function withoutActorKinds(components: readonly ComponentDefinition[]): ComponentDefinition[] {
  return components.map((component) => ({
    ...component,
    setup(pikit: Pikit, config: unknown) {
      const provideKeyed: Pikit["provideKeyed"] = (name, key, impl) => {
        if (name !== "actor.kind") pikit.provideKeyed(name, key, impl);
      };
      return component.setup({ ...pikit, provideKeyed }, config as never);
    },
  }));
}

type StepOutcome = { sent: "taken" | "refused" } | { called: { ok: true; answer: JsonValue } | { ok: false; code: string } };

async function run(fixture: ActorKindFixture, object: ActorKindObject): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (const step of fixture.steps) {
    if ("send" in step) {
      const sent = await object.send(step.send, step.message).then(
        () => "taken" as const,
        () => "refused" as const,
      );
      outcomes.push({ sent });
    } else {
      const outcome = await object.call(step.call, step.message);
      // The answer as compared; a refusal by its code (its message may say which App answered).
      outcomes.push({ called: outcome.ok ? { ok: true, answer: fixture.comparable?.(outcome.answer) ?? outcome.answer } : { ok: false, code: outcome.code } });
    }
  }
  return outcomes;
}

/** Opens both objects, runs the steps on each, and hands both results to `check`. */
async function both(fixture: ActorKindFixture, check: (whole: { outcomes: StepOutcome[]; rows: JsonValue }, kind: { outcomes: StepOutcome[]; rows: JsonValue }) => void) {
  const results: { outcomes: StepOutcome[]; rows: JsonValue }[] = [];
  for (const app of ["whole", "kind"] as const) {
    const object = await fixture.open(app);
    try {
      const outcomes = await run(fixture, object);
      results.push({ outcomes, rows: await object.rows() });
    } finally {
      await object.close?.();
    }
  }
  check(results[0] as (typeof results)[number], results[1] as (typeof results)[number]);
}

export function createActorKindConformance(makeFixture: () => ActorKindFixture | Promise<ActorKindFixture>): ConformanceCase[] {
  return [
    {
      group: GROUP,
      name: "every step has the outcome it has in the whole App",
      run: async () => {
        const fixture = await makeFixture();
        await both(fixture, (whole, kind) => {
          fixture.steps.forEach((step, i) => {
            if (!equal(kind.outcomes[i], whole.outcomes[i])) {
              const what = "send" in step ? `the message "${step.send}"` : `the call "${step.call}"`;
              throw new Error(`${GROUP}: ${what} (step ${i + 1}) on "${fixture.key}": the whole App gave ${JSON.stringify(whole.outcomes[i])}, the kind's ${JSON.stringify(kind.outcomes[i])}`);
            }
          });
        });
      },
    },
    {
      group: GROUP,
      name: "the object stores what it stores in the whole App",
      run: async () => {
        const fixture = await makeFixture();
        await both(fixture, (whole, kind) => {
          if (!equal(kind.rows, whole.rows)) throw new Error(`${GROUP}: after the steps on "${fixture.key}" the whole App stored ${JSON.stringify(whole.rows)}, the kind's ${JSON.stringify(kind.rows)}`);
        });
      },
    },
    {
      group: GROUP,
      name: "the kind's start calls no other actor",
      run: async () => {
        const fixture = await makeFixture();
        const object = await fixture.open("kind");
        try {
          const calls = object.startCalls();
          if (calls.length > 0) throw new Error(`${GROUP}: the kind's start of "${fixture.key}" reached ${calls.length} other actor(s); a kind's object starts no other object`);
        } finally {
          await object.close?.();
        }
      },
    },
  ];
}

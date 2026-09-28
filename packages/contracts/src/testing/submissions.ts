/**
 * `agent.submissions` conformance (SPEC §6.1, §14): what every record of submissions must do, wherever
 * it keeps them. Runner-independent, like the lifecycle suite:
 *
 *   for (const c of createSubmissionsConformance(() => myFixture(), { prunes: true, restarts: true }))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite calls the contract as the runtime (`admitted`, `settled`, `abandoned`) and the channels (`pending`,
 * `get`, `answers`) do. `answers` also runs the feed suite (§4.8), each fact committed by a `settled`.
 * Pruning and restarting are the provider's to do; the cases that need them run only when the options
 * say the fixture can.
 *
 * `createMemorySubmissions` is the in-memory double: it passes this suite, and it stands in for a
 * provider in the tests of a runtime or a channel.
 */

import { type AppContext, defineApp, silentLogger } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { ConversationRef } from "../agent.ts";
import type { AgentSubmissions, PendingConversation, RunSettlement, SubmissionStatus } from "../submissions.ts";
import { expecter } from "./assert.ts";
import { createFeedConformance, createMemoryFeed } from "./feed.ts";

/** A provider over fresh, empty records, built for one case. */
export interface SubmissionsFixture {
  /** The contract as the provider exposes it now; asked again after `restart()`. */
  submissions(): AgentSubmissions;
  /** Prunes every settlement committed so far, as the provider's retention would. Required by `prunes`. */
  prune?(): Promise<void>;
  /** A new process over the same records. Required by `restarts`. */
  restart?(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface SubmissionsConformanceOptions {
  /** The fixture can prune settlements: check what pruning keeps, and `answers`' gap. */
  prunes?: boolean;
  /** The fixture can restart its provider: check that records and cursors survive it. */
  restarts?: boolean;
}

const GROUP = "agent.submissions";
const expect = expecter(GROUP);

const conversation = (n: number): ConversationRef => ({ key: `test:c${n}`, agent: "support", sessionId: `session-${n}` });

const completed = (on: ConversationRef, requestIds: string[], text = `answer to ${requestIds.join(", ")}`): RunSettlement => ({
  conversation: on,
  requestId: requestIds[0] ?? "",
  requestIds,
  kind: "completed",
  text,
});

export function createSubmissionsConformance(
  factory: () => SubmissionsFixture | Promise<SubmissionsFixture>,
  options: SubmissionsConformanceOptions = {},
): readonly ConformanceCase[] {
  let context: Promise<AppContext> | undefined;
  /** An app context for the calls: the contract bounds them with it, and the suite needs no components. */
  const ctx = (): Promise<AppContext> => (context ??= defineApp({ components: [], logger: silentLogger }).create().then((app) => app.context()));

  const submissionsCase = (name: string, run: (f: SubmissionsFixture, ctx: AppContext) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      try {
        await run(fixture, await ctx());
      } finally {
        await fixture.dispose?.();
      }
    },
  });
  const answers = async (f: SubmissionsFixture): Promise<RunSettlement[]> =>
    (await f.submissions().answers.read(undefined, 100)).items.map((item) => item.fact);
  const pending = (list: readonly PendingConversation[]) => list.map((p) => [p.conversation.sessionId, p.requestIds]);

  const cases: ConformanceCase[] = [
    submissionsCase("empty records: nothing pending, no answers, and an unknown request is undefined", async (f, c) => {
      const s = f.submissions();
      expect(await s.pending(c), [], "pending");
      expect(await answers(f), [], "answers");
      expect(await s.get(conversation(1), "r1", c), undefined, "an unknown request");
    }),

    submissionsCase("an admitted request is pending, grouped by conversation, the oldest first", async (f, c) => {
      const s = f.submissions();
      await s.admitted(conversation(1), "r1", c);
      await s.admitted(conversation(2), "r2", c);
      await s.admitted(conversation(1), "r3", c);

      const list = await s.pending(c);
      expect(pending(list), [["session-1", ["r1", "r3"]], ["session-2", ["r2"]]], "pending");
      const [first, second] = list.map((p) => p.oldestAdmittedAt);
      expect(Number.isFinite(first) && Number.isFinite(second) && (first as number) <= (second as number), true, "oldestAdmittedAt: a time, the oldest first");
      expect(list[0]?.conversation, conversation(1), "the conversation of the first");
      expect(await s.get(conversation(1), "r3", c), { kind: "pending", conversation: conversation(1), requestId: "r3" } satisfies SubmissionStatus, "get");
    }),

    submissionsCase("conversations are ordered by their oldest pending request, not their oldest request", async (f, c) => {
      const s = f.submissions();
      await s.admitted(conversation(1), "r1", c);
      await s.admitted(conversation(2), "r2", c);
      await s.admitted(conversation(1), "r3", c);

      await s.settled(completed(conversation(1), ["r1"]), c);

      expect(pending(await s.pending(c)), [["session-2", ["r2"]], ["session-1", ["r3"]]], "pending");
    }),

    submissionsCase("admitting a request again changes nothing", async (f, c) => {
      const s = f.submissions();
      await s.admitted(conversation(1), "r1", c);
      await s.admitted(conversation(1), "r2", c);
      await s.admitted(conversation(1), "r1", c);

      expect(pending(await s.pending(c)), [["session-1", ["r1", "r2"]]], "pending");
    }),

    submissionsCase("a run settles every request it took, and is appended to answers once", async (f, c) => {
      const s = f.submissions();
      await s.admitted(conversation(1), "r1", c);
      await s.admitted(conversation(1), "r2", c);
      await s.admitted(conversation(2), "r3", c);
      const run = completed(conversation(1), ["r1", "r2"]);

      await s.settled(run, c);

      expect(pending(await s.pending(c)), [["session-2", ["r3"]]], "pending after the run");
      expect(await s.get(conversation(1), "r2", c), { kind: "settled", conversation: conversation(1), requestId: "r2", run }, "a request the run took");
      expect(await answers(f), [run], "answers");
    }),

    submissionsCase("settling the same run again changes nothing", async (f, c) => {
      const s = f.submissions();
      await s.admitted(conversation(1), "r1", c);
      const run = completed(conversation(1), ["r1"]);

      await s.settled(run, c);
      await s.settled(run, c);
      await s.settled({ ...run, text: "a second reading of the same run" }, c);

      expect(await answers(f), [run], "answers");
      expect((await s.get(conversation(1), "r1", c))?.kind, "settled", "the request");
    }),

    submissionsCase("a request keeps the first run that settled it; admitting it again leaves it settled", async (f, c) => {
      const s = f.submissions();
      const first = completed(conversation(1), ["r1"]);
      const later = completed(conversation(1), ["r2", "r1"]);
      await s.admitted(conversation(1), "r1", c);
      await s.settled(first, c);

      await s.settled(later, c);
      await s.admitted(conversation(1), "r1", c);

      const status = await s.get(conversation(1), "r1", c);
      expect(status?.kind === "settled" ? status.run.requestId : status?.kind, "r1", "the run that settled r1");
      expect((await s.get(conversation(1), "r2", c))?.kind, "settled", "the later run's own request");
      expect((await answers(f)).map((a) => a.requestId), ["r1", "r2"], "answers: one per run");
      expect(await s.pending(c), [], "pending");
    }),

    submissionsCase("a request that was never admitted is settled all the same", async (f, c) => {
      const s = f.submissions();
      const run = completed(conversation(1), ["lost-admission"]);

      await s.settled(run, c);

      expect(await s.get(conversation(1), "lost-admission", c), { kind: "settled", conversation: conversation(1), requestId: "lost-admission", run }, "get");
      expect(await answers(f), [run], "answers");
      expect(await s.pending(c), [], "pending");
    }),

    submissionsCase("requests are per session: one id in two sessions is two requests", async (f, c) => {
      const s = f.submissions();
      await s.admitted(conversation(1), "m1", c);
      await s.admitted(conversation(2), "m1", c);

      await s.settled(completed(conversation(1), ["m1"]), c);

      expect((await s.get(conversation(1), "m1", c))?.kind, "settled", "m1 in session-1");
      expect((await s.get(conversation(2), "m1", c))?.kind, "pending", "m1 in session-2");
      await s.settled(completed(conversation(2), ["m1"]), c);
      expect((await answers(f)).map((a) => a.conversation.sessionId), ["session-1", "session-2"], "answers: one run per session");
    }),

    submissionsCase("a settlement keeps what the run said: its kind, text and error", async (f, c) => {
      const s = f.submissions();
      const failed: RunSettlement = {
        conversation: conversation(1),
        requestId: "r1",
        requestIds: ["r1"],
        kind: "failed",
        error: { code: "provider_error", message: "the model failed" },
      };
      const aborted: RunSettlement = { conversation: conversation(2), requestId: "r2", requestIds: ["r2"], kind: "aborted" };
      const empty: RunSettlement = { conversation: conversation(3), requestId: "r3", requestIds: ["r3"], kind: "completed", text: "" };

      for (const run of [failed, aborted, empty]) await s.settled(run, c);

      expect(await answers(f), [failed, aborted, empty], "answers");
    }),
  ];

  const abandon = (on: ConversationRef, requestIds: string[], reason: string): RunSettlement => ({
    conversation: on,
    requestId: requestIds[0] ?? "",
    requestIds,
    kind: "failed",
    error: { code: "abandoned", message: reason },
  });
  cases.push(
    submissionsCase("abandoning settles the pending requests unanswered, and appends one settlement for them", async (f, c) => {
      const s = f.submissions();
      await s.admitted(conversation(1), "r1", c);
      await s.admitted(conversation(1), "r2", c);
      await s.admitted(conversation(2), "r3", c);

      const appended = await s.abandoned(conversation(1), ["r1", "r2"], "agent_removed", c);

      const expected = abandon(conversation(1), ["r1", "r2"], "agent_removed");
      expect(appended, expected, "the settlement appended");
      expect(await answers(f), [expected], "answers");
      expect(pending(await s.pending(c)), [["session-2", ["r3"]]], "pending");
      expect(await s.get(conversation(1), "r2", c), { kind: "settled", conversation: conversation(1), requestId: "r2", run: expected }, "get");
    }),

    submissionsCase("abandoning leaves a settled or unknown request as it is", async (f, c) => {
      const s = f.submissions();
      const run = completed(conversation(1), ["r1"]);
      await s.admitted(conversation(1), "r1", c);
      await s.admitted(conversation(1), "r2", c);
      await s.settled(run, c);

      const appended = await s.abandoned(conversation(1), ["r1", "unknown", "r2"], "too_old", c);

      expect(appended, abandon(conversation(1), ["r2"], "too_old"), "the settlement: only the pending one");
      expect(await s.get(conversation(1), "r1", c), { kind: "settled", conversation: conversation(1), requestId: "r1", run }, "the settled one");
      expect(await s.get(conversation(1), "unknown", c), undefined, "the unknown one");
      expect(await s.pending(c), [], "pending");
    }),

    submissionsCase("abandoning again, or nothing pending, changes nothing", async (f, c) => {
      const s = f.submissions();
      await s.admitted(conversation(1), "r1", c);

      await s.abandoned(conversation(1), ["r1"], "session_missing", c);
      const again = await s.abandoned(conversation(1), ["r1"], "session_missing", c);
      const none = await s.abandoned(conversation(2), ["r9"], "session_missing", c);

      expect([again, none], [undefined, undefined], "what abandoning again appended");
      expect(await answers(f), [abandon(conversation(1), ["r1"], "session_missing")], "answers");
      await s.settled(completed(conversation(1), ["r1"]), c);
      expect((await answers(f)).length, 1, "answers after a late run of the abandoned request");
      const status = await s.get(conversation(1), "r1", c);
      expect(status?.kind === "settled" ? status.run.error?.code : status?.kind, "abandoned", "the request keeps its first settlement");
    }),
  );

  if (options.restarts) {
    cases.push(
      submissionsCase("pending requests and settlements survive a restart", async (f, c) => {
        if (f.restart === undefined) throw new Error(`${GROUP}: the fixture has no restart(), but the options say it restarts`);
        const run = completed(conversation(1), ["r1"]);
        await f.submissions().admitted(conversation(1), "r1", c);
        await f.submissions().admitted(conversation(2), "r2", c);
        await f.submissions().settled(run, c);

        await f.restart();

        const s = f.submissions();
        expect(pending(await s.pending(c)), [["session-2", ["r2"]]], "pending");
        expect(await s.get(conversation(1), "r1", c), { kind: "settled", conversation: conversation(1), requestId: "r1", run }, "get");
        expect(await answers(f), [run], "answers");
      }),

      submissionsCase("settling the same run again after a restart changes nothing", async (f, c) => {
        if (f.restart === undefined) throw new Error(`${GROUP}: the fixture has no restart(), but the options say it restarts`);
        const run = completed(conversation(1), ["r1"]);
        await f.submissions().admitted(conversation(1), "r1", c);
        await f.submissions().settled(run, c);

        await f.restart();
        await f.submissions().settled(run, c);
        await f.submissions().settled({ ...run, text: "a second reading of the same run" }, c);

        const s = f.submissions();
        expect(await answers(f), [run], "answers");
        expect(await s.get(conversation(1), "r1", c), { kind: "settled", conversation: conversation(1), requestId: "r1", run }, "get");
        expect(await s.pending(c), [], "pending");
      }),
    );
  }

  if (options.prunes) {
    cases.push(
      submissionsCase("pruning settlements keeps the pending requests", async (f, c) => {
        if (f.prune === undefined) throw new Error(`${GROUP}: the fixture has no prune(), but the options say it prunes`);
        const s = f.submissions();
        await s.admitted(conversation(1), "r1", c);
        await s.admitted(conversation(2), "r2", c);
        await s.settled(completed(conversation(1), ["r1"]), c);

        await f.prune();

        const after = f.submissions();
        expect(pending(await after.pending(c)), [["session-2", ["r2"]]], "pending");
        expect(await after.get(conversation(1), "r1", c), undefined, "a pruned settlement");
        expect(await answers(f), [], "answers");
        await after.settled(completed(conversation(2), ["r2"]), c);
        expect(await after.pending(c), [], "pending once the last one settled");
      }),
    );
  }

  // `answers` is a feed like any other (SPEC §4.8).
  const feedCases = createFeedConformance<RunSettlement>(
    async () => {
      const fixture = await factory();
      const c = await ctx();
      let n = 0;
      return {
        feed: () => fixture.submissions().answers,
        async commit() {
          const id = `run-${++n}`;
          await fixture.submissions().settled(completed(conversation(1), [id]), c);
          return id;
        },
        identify: (fact) => fact.requestId,
        ...(fixture.prune !== undefined && { prune: () => (fixture.prune as () => Promise<void>)() }),
        ...(fixture.restart !== undefined && { restart: () => (fixture.restart as () => Promise<void>)() }),
        ...(fixture.dispose !== undefined && { dispose: () => (fixture.dispose as () => Promise<void>)() }),
      };
    },
    { ...(options.prunes !== undefined && { prunes: options.prunes }), ...(options.restarts !== undefined && { restarts: options.restarts }) },
  );
  return [...cases, ...feedCases.map((c) => ({ ...c, group: `${GROUP} answers ${c.group}` }))];
}

// ---------------------------------------------------------------------------------------------

/** An in-memory record of submissions, for tests: the contract, and `prune` as a provider's retention. */
export interface MemorySubmissions {
  readonly submissions: AgentSubmissions;
  /** Prunes every settlement committed so far, and the requests they settled. */
  prune(): void;
}

/**
 * The in-memory double of `agent.submissions`. Its records live as long as the object: it survives no
 * process, so it is only for tests (S9). Built outside a component's setup, it outlives the apps of a
 * test, as a database would.
 */
export function createMemorySubmissions(): MemorySubmissions {
  const answers = createMemoryFeed<RunSettlement>();
  /** By `${sessionId}\0${requestId}`, in admission order (a Map keeps insertion order). */
  const requests = new Map<string, { conversation: ConversationRef; requestId: string; admittedAt: number; run?: RunSettlement }>();
  /** Runs already settled, by `${sessionId}\0${requestId}` of their starter. */
  const runs = new Set<string>();
  const keyOf = (sessionId: string, requestId: string) => `${sessionId}\u0000${requestId}`;
  const copy = <T>(value: T): T => structuredClone(value);

  const submissions: AgentSubmissions = {
    async admitted(conversation, requestId, ctx) {
      const key = keyOf(conversation.sessionId, requestId);
      if (!requests.has(key)) requests.set(key, { conversation: copy(conversation), requestId, admittedAt: ctx.clock.now() });
    },
    async settled(run, ctx) {
      const runKey = keyOf(run.conversation.sessionId, run.requestId);
      if (runs.has(runKey)) return;
      runs.add(runKey);
      const stored = copy(run);
      for (const requestId of run.requestIds) {
        const key = keyOf(run.conversation.sessionId, requestId);
        const request = requests.get(key);
        if (request === undefined) requests.set(key, { conversation: copy(run.conversation), requestId, admittedAt: ctx.clock.now(), run: stored });
        else if (request.run === undefined) request.run = stored;
      }
      answers.append(stored);
    },
    async abandoned(conversation, requestIds, reason) {
      const still = [...new Set(requestIds)].filter((id) => {
        const request = requests.get(keyOf(conversation.sessionId, id));
        return request !== undefined && request.run === undefined;
      });
      const [first] = still;
      if (first === undefined) return undefined;
      const run: RunSettlement = { conversation: copy(conversation), requestId: first, requestIds: still, kind: "failed", error: { code: "abandoned", message: reason } };
      runs.add(keyOf(conversation.sessionId, first));
      for (const id of still) (requests.get(keyOf(conversation.sessionId, id)) as { run?: RunSettlement }).run = run;
      answers.append(run);
      return copy(run);
    },
    async pending() {
      const bySession = new Map<string, PendingConversation>();
      for (const request of requests.values()) {
        if (request.run !== undefined) continue;
        const entry = bySession.get(request.conversation.sessionId) ?? {
          conversation: copy(request.conversation),
          requestIds: [],
          oldestAdmittedAt: request.admittedAt,
        };
        entry.requestIds.push(request.requestId);
        entry.oldestAdmittedAt = Math.min(entry.oldestAdmittedAt, request.admittedAt);
        bySession.set(request.conversation.sessionId, entry);
      }
      return [...bySession.values()];
    },
    async get(conversation, requestId) {
      const request = requests.get(keyOf(conversation.sessionId, requestId));
      if (request === undefined) return undefined;
      const base = { conversation: copy(request.conversation), requestId };
      return request.run === undefined ? { kind: "pending", ...base } : { kind: "settled", ...base, run: copy(request.run) };
    },
    answers: answers.feed,
  };
  return {
    submissions,
    prune() {
      for (const [key, request] of requests) if (request.run !== undefined) requests.delete(key);
      runs.clear();
      answers.prune();
    },
  };
}

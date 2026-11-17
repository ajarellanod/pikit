/**
 * The change log's conformance cases (`../change.ts`): what every store that keeps one guarantees,
 * whatever its items are. Each store's suite runs them with a fixture that makes, changes, removes and
 * restores one kind of its items (projects-sql: a document; memory-sql: a rule; tool-space-files: a
 * file):
 *
 *   for (const c of changeLogCases("memory", () => ruleLogSubject())) test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The cases compare an item's state as the store shows it (`state`), so a restore that drops a field
 * (a title, a mode, the item's original author) fails. Optional fixture methods enable the cases that
 * need them: `expire` (retention), `redact` (an operator's redaction), `failNextCommit` (a crash between
 * the item and its entry), `repeat` (a write that changes nothing).
 */

import type { ConformanceCase } from "@pikit/core/testing";
import type { Author, Change } from "../change.ts";
import type { JsonValue } from "../json.ts";
import { checker, expecter } from "./assert.ts";

/** One store with an empty log, for one case. Every method writes as the store's public API does. */
export interface ChangeLogSubject {
  /** Makes one new item by `by`; its id. */
  add(by: Author): Promise<string>;
  /** Gives item `id` a new state by `by` (new words, a new version). */
  change(id: string, by: Author): Promise<void>;
  /** Removes item `id` by `by`. */
  remove(id: string, by: Author): Promise<void>;
  /** The store's `restore(n)` by `by`. Rejects with an error whose `code` is the store's (`gone`...). */
  restore(n: number, by: Author): Promise<Change>;
  /**
   * Item `id` as the store shows it: every field a restore must bring back (text, title, mode, the
   * item's own author...), never the log's; `undefined` when absent (removed, trashed).
   */
  state(id: string): Promise<JsonValue | undefined>;
  /** The whole log, oldest first (every page read). */
  changes(): Promise<Change[]>;
  /** Writes item `id`'s current state again by `by`: a repeat that changes nothing. */
  repeat?(id: string, by: Author): Promise<void>;
  /** Moves the store's clock past retention of everything logged so far. */
  expire?(): Promise<void>;
  /** The store's `redact(n)` by `by`. */
  redact?(n: number, by: Author): Promise<void>;
  /** Makes the next write fail inside its transaction, after the item is written and before it commits. */
  failNextCommit?(): void;
  close?(): Promise<void>;
}

export const LOG_PERSON: Author = { kind: "person", principal: { channel: "web", id: "u-ana", name: "Ana Garcia" }, conversation: "web:u-ana:c-1" };
export const LOG_AGENT: Author = { kind: "agent", agent: "trader", conversation: "googlechat:spaces/AAA:threads/t1", for: { channel: "googlechat", id: "users/42" } };
export const LOG_OTHER: Author = { kind: "person", principal: { channel: "googlechat", id: "users/7" } };
export const LOG_OPERATOR: Author = { kind: "operator", id: "admin" };

/**
 * Three authors the store accepts for every write of the subject, and an operator: by default a web
 * person, an agent answering a Google Chat person, and a Google Chat person. A store whose items only
 * people write (a project's documents) gives three people it knows as members.
 */
export type ChangeLogAuthors = { first: Author; second: Author; third: Author; operator: Author };

export const LOG_AUTHORS: ChangeLogAuthors = { first: LOG_PERSON, second: LOG_AGENT, third: LOG_OTHER, operator: LOG_OPERATOR };

/** The log's cases, under `group` (the store's capability). */
export function changeLogCases(group: string, open: () => Promise<ChangeLogSubject>, authors: ChangeLogAuthors = LOG_AUTHORS): readonly ConformanceCase[] {
  const { first: PERSON, second: AGENT, third: OTHER, operator: OPERATOR } = authors;
  const name = `${group}: change log`;
  const expect = expecter(name);
  const check = checker(name);
  const one = (title: string, run: (log: ChangeLogSubject) => Promise<void>): ConformanceCase => ({
    group: name,
    name: title,
    async run() {
      const log = await open();
      try {
        await run(log);
      } finally {
        await log.close?.();
      }
    },
  });
  const last = async (log: ChangeLogSubject): Promise<Change> => {
    const all = await log.changes();
    const entry = all.at(-1);
    if (entry === undefined) throw new Error(`${name}: expected an entry, the log is empty`);
    return entry;
  };
  /** The earlier entries, as JSON, to compare byte for byte after more operations. */
  const snapshot = async (log: ChangeLogSubject) => (await log.changes()).map((entry) => JSON.stringify(entry));
  const prefixKept = async (log: ChangeLogSubject, before: string[], what: string) => {
    const now = (await log.changes()).map((entry) => JSON.stringify(entry));
    expect(now.slice(0, before.length), before, `the earlier entries are unchanged after ${what}`);
  };
  const codeOf = (error: unknown) => (typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined);

  const cases: ConformanceCase[] = [
    one("each change appends exactly one entry with its author, numbered 1, 2, 3", async (log) => {
      const id = await log.add(PERSON);
      await log.change(id, AGENT);
      await log.remove(id, OTHER);
      const all = await log.changes();
      expect(
        all.map((entry) => [entry.n, entry.action, entry.item.id]),
        [
          [1, "added", id],
          [2, "changed", id],
          [3, "removed", id],
        ],
        "one entry per change, in order",
      );
      expect(
        all.map((entry) => entry.by),
        [PERSON, AGENT, OTHER],
        "each entry's author, exactly as given (an agent's conversation and the person it answered included)",
      );
      check(all.every((entry, index) => index === 0 || entry.at >= (all[index - 1] as Change).at), "times that never go back");
      check(all.every((entry) => entry.item.title.length > 0 && entry.item.title.length <= 120 && !/\n/.test(entry.item.title)), "titles of one line, 1 to 120 characters");
      check(all.every((entry) => entry.restorable), "every fresh entry restorable");
    }),
    one("an item's version grows with each change, when the item is versioned", async (log) => {
      const id = await log.add(PERSON);
      await log.change(id, PERSON);
      const [added, changed] = await log.changes();
      if (added?.version === undefined) return;
      check(changed?.version !== undefined && changed.version > added.version, "a change's version above the one before");
    }),
    one("restore(n) brings back exactly the state before n, and appends a restored entry by the restorer", async (log) => {
      const id = await log.add(PERSON);
      const before = await log.state(id);
      await log.change(id, AGENT);
      const changed = await last(log);
      check(JSON.stringify(await log.state(id)) !== JSON.stringify(before), "a change that changes the state");
      const restored = await log.restore(changed.n, OTHER);
      expect(await log.state(id), before, "the state before the change, every field");
      expect([restored.action, restored.restores, restored.by], ["restored", changed.n, OTHER], "a restored entry naming the change, by the restorer");
      expect(await last(log), restored, "the entry restore answered is the log's last");
    }),
    one("restoring a removal brings the item back under its id; restoring an addition removes it", async (log) => {
      const id = await log.add(PERSON);
      const before = await log.state(id);
      await log.remove(id, AGENT);
      expect(await log.state(id), undefined, "removed");
      await log.restore((await last(log)).n, OTHER);
      expect(await log.state(id), before, "back under its id, as it was (its own author kept)");
      const other = await log.add(AGENT);
      const added = await last(log);
      await log.restore(added.n, PERSON);
      expect(await log.state(other), undefined, "an addition restored: the item gone");
    }),
    one("a restore can be restored", async (log) => {
      const id = await log.add(PERSON);
      await log.change(id, AGENT);
      const changedState = await log.state(id);
      const restored = await log.restore((await last(log)).n, PERSON);
      await log.restore(restored.n, OTHER);
      expect(await log.state(id), changedState, "the state the first restore replaced");
    }),
    one("the earlier entries are identical after every operation, restores included", async (log) => {
      const id = await log.add(PERSON);
      let before = await snapshot(log);
      await log.change(id, AGENT);
      await prefixKept(log, before, "a change");
      before = await snapshot(log);
      await log.restore(2, OTHER);
      await prefixKept(log, before, "a restore");
      before = await snapshot(log);
      await log.remove(id, PERSON);
      await prefixKept(log, before, "a removal");
      before = await snapshot(log);
      await log.restore((await last(log)).n, PERSON);
      await prefixKept(log, before, "a restore of a removal");
      const all = await log.changes();
      expect(
        all.map((entry) => entry.n),
        all.map((_entry, index) => index + 1),
        "numbers gapless from 1",
      );
    }),
  ];

  cases.push(
    one("a write that changes nothing appends nothing", async (log) => {
      if (log.repeat === undefined) return;
      const id = await log.add(PERSON);
      const before = await snapshot(log);
      await log.repeat(id, AGENT);
      expect(await snapshot(log), before, "the log as it was");
    }),
    one("past retention an entry is not restorable, and its restore is gone", async (log) => {
      if (log.expire === undefined) return;
      const id = await log.add(PERSON);
      await log.change(id, PERSON);
      await log.expire();
      const entries = await log.changes();
      const changed = entries.find((entry) => entry.action === "changed");
      if (changed !== undefined) {
        expect(changed.restorable, false, "an entry past retention says so (or is dropped)");
      }
      const target = changed?.n ?? 2;
      let code: unknown;
      try {
        await log.restore(target, PERSON);
      } catch (error) {
        code = codeOf(error);
      }
      expect(code, "gone", "restoring an entry past retention");
    }),
    one("a redaction keeps who and when, says so, and makes the entry not restorable", async (log) => {
      if (log.redact === undefined) return;
      const id = await log.add(PERSON);
      await log.change(id, AGENT);
      const [first, second] = await log.changes();
      await log.redact(2, OPERATOR);
      const [firstAfter, secondAfter] = await log.changes();
      expect(firstAfter, first, "the other entries unchanged");
      expect([secondAfter?.n, secondAfter?.at, secondAfter?.by, secondAfter?.action], [second?.n, second?.at, second?.by, second?.action], "who, when and what stay");
      expect([secondAfter?.restorable, secondAfter?.redacted?.by], [false, OPERATOR], "not restorable, redacted by the operator");
      let code: unknown;
      try {
        await log.restore(2, PERSON);
      } catch (error) {
        code = codeOf(error);
      }
      expect(code, "gone", "restoring a redacted entry");
    }),
    one("a write that fails before it commits leaves neither the item nor the entry", async (log) => {
      if (log.failNextCommit === undefined) return;
      const id = await log.add(PERSON);
      const state = await log.state(id);
      const before = await snapshot(log);
      log.failNextCommit();
      let failed = false;
      try {
        await log.change(id, AGENT);
      } catch {
        failed = true;
      }
      check(failed, "the failed write to reject");
      expect(await log.state(id), state, "the item as it was");
      expect(await snapshot(log), before, "the log as it was");
    }),
  );
  return cases;
}

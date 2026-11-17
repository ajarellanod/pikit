import { describe, expect, test } from "bun:test";
import type { Author, Change } from "../change.ts";
import type { JsonValue } from "../json.ts";
import { type ChangeLogSubject, changeLogCases } from "./change-log.ts";

type Item = { title: string; text: string; by: Author; version: number };
type Mutation = "none" | "restore-drops-title" | "entry-in-second-step" | "restore-rewrites-entry" | "repeat-appends" | "author-dropped";

/** A store of titled texts with a correct log, or one broken by `mutation`: what the suite must catch. */
function store(mutation: Mutation = "none"): ChangeLogSubject {
  const items = new Map<string, Item>();
  const log: (Change & { before: Item | null })[] = [];
  let clock = 1_000;
  let next = 0;
  let failNext = false;
  const append = (by: Author, action: Change["action"], id: string, before: Item | null, after: Item | null, restores?: number): Change => {
    const entry: Change & { before: Item | null } = {
      n: log.length + 1,
      at: clock++,
      by: mutation === "author-dropped" ? { kind: "component", name: "store" } : by,
      action,
      item: { kind: "note", id, title: (after ?? before)?.title ?? id },
      ...(after !== null && { version: after.version }),
      ...(restores !== undefined && { restores }),
      restorable: true,
      before,
    };
    log.push(entry);
    return strip(entry);
  };
  const strip = ({ before: _before, ...entry }: Change & { before: Item | null }): Change => structuredClone(entry);
  /** One write: the item, then its entry, "in one transaction" (or not, for the broken store). */
  const write = (id: string, after: Item | null, by: Author, action: Change["action"], restores?: number): Change => {
    const before = items.get(id) ?? null;
    if (after === null) items.delete(id);
    else items.set(id, after);
    if (failNext) {
      failNext = false;
      if (mutation !== "entry-in-second-step") {
        if (before === null) items.delete(id);
        else items.set(id, before);
      }
      throw new Error("commit failed");
    }
    return append(by, action, id, before, after, restores);
  };
  return {
    async add(by) {
      const id = `m-${++next}`;
      write(id, { title: `Note ${next}`, text: `first words ${next}`, by, version: 1 }, by, "added");
      return id;
    },
    async change(id, by) {
      const item = items.get(id) as Item;
      write(id, { ...item, text: `${item.text} changed`, title: `${item.title}*`, by, version: item.version + 1 }, by, "changed");
    },
    async remove(id, by) {
      write(id, null, by, "removed");
    },
    async repeat(id, by) {
      if (mutation === "repeat-appends") append(by, "changed", id, items.get(id) ?? null, items.get(id) ?? null);
    },
    async restore(n, by) {
      const entry = log[n - 1];
      if (entry === undefined || !entry.restorable) throw Object.assign(new Error("gone"), { code: "gone" });
      const id = entry.item.id;
      const current = items.get(id) ?? null;
      let back = entry.before === null ? null : { ...entry.before, version: (current?.version ?? entry.before.version) + 1 };
      if (back !== null && mutation === "restore-drops-title") back = { ...back, title: "" };
      const restored = write(id, back, by, "restored", n);
      if (mutation === "restore-rewrites-entry") entry.restorable = false;
      return restored;
    },
    async state(id) {
      const item = items.get(id);
      return item === undefined ? undefined : ({ title: item.title, text: item.text, by: item.by } as JsonValue);
    },
    async changes() {
      return log.map(strip);
    },
    async expire() {
      for (const entry of log) entry.restorable = false;
    },
    async redact(n, by) {
      const entry = log[n - 1] as Change & { before: Item | null };
      entry.before = null;
      entry.restorable = false;
      entry.redacted = { at: clock++, by };
    },
    failNextCommit() {
      failNext = true;
    },
  };
}

describe("changeLogCases, on a correct store", () => {
  for (const c of changeLogCases("test", async () => store())) test(c.name, () => c.run());
});

/** Each mutation fails at least one case: the suite catches the broken store. */
describe("changeLogCases catch a broken store", () => {
  const broken: Mutation[] = ["restore-drops-title", "entry-in-second-step", "restore-rewrites-entry", "repeat-appends", "author-dropped"];
  for (const mutation of broken) {
    test(mutation, async () => {
      const failures: string[] = [];
      for (const c of changeLogCases("test", async () => store(mutation))) {
        try {
          await c.run();
        } catch (error) {
          failures.push(`${c.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      expect(failures.length).toBeGreaterThan(0);
    });
  }
});

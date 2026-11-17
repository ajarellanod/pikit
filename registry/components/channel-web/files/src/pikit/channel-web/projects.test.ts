/**
 * channel-web's projects on a server over doubles of the stores (`projects.test-support.ts`: the rules of
 * `projects`, `space.files` and memory-sql's `memory` the routes rely on, in memory, each counting its
 * calls): every case of `projectRouteCases` (`projects.cases.test-support.ts`). The same cases run over
 * the real providers in the repository's `registry/components/channel-web/projects-stores.test.ts`.
 * Also the History merge's pure rules.
 */

import { expect, test } from "bun:test";
import type { ChangePage } from "@pikit/contracts";
import { encodeHistoryCursor, mergeHistory, parseHistoryCursor } from "./project-routes.ts";
import { projectRouteCases, type StoreName } from "./projects.cases.test-support.ts";
import { MemoryMemory, MemoryProjects, MemorySpaceFiles, projectsComponent } from "./projects.test-support.ts";

type Doubles = { projects: MemoryProjects; files: MemorySpaceFiles; memory: MemoryMemory };

projectRouteCases({
  async open({ only, now, restartOf }) {
    const doubles = (restartOf?.state as Doubles | undefined) ?? { projects: new MemoryProjects(now), files: new MemorySpaceFiles(now), memory: new MemoryMemory(now) };
    const given = Object.fromEntries(Object.entries(doubles).filter(([name]) => only.includes(name as StoreName)));
    return {
      components: [projectsComponent(given)],
      state: doubles,
      calls: (store) => [...doubles[store].calls],
      resetCalls: () => {
        for (const each of Object.values(doubles)) each.calls.length = 0;
      },
      failNext: (method) => void (doubles.projects.failNext = { method, error: new Error("the store is down") }),
    };
  },
});

test("HISTORY's merge (pure): one log's entries in its order, ties by log, each log's place the last taken; a page past every log has no next; a cursor round-trips and a foreign one is refused", () => {
  const entry = (n: number, at: number) => ({ n, at, by: { kind: "component" as const, name: "t" }, action: "added" as const, item: { kind: "k", id: String(n), title: "t" }, restorable: true });
  const page = (items: ReturnType<typeof entry>[], next?: number): ChangePage => ({ items, ...(next !== undefined && { next }) });
  const merged = mergeHistory(
    new Map([
      ["project", { page: page([entry(9, 50), entry(8, 30)], 8), place: undefined }],
      ["memory", { page: page([entry(4, 50), entry(3, 40)]), place: undefined }],
      ["files", { page: page([]), place: 0 }],
    ]),
    3,
  );
  expect(merged.items.map((each) => `${each.log}#${each.n}`)).toEqual(["project#9", "memory#4", "memory#3"]);
  expect(merged.next).toEqual({ project: 9, memory: 0, files: 0 });
  // The last page: everything taken, nothing more.
  const last = mergeHistory(new Map([["project", { page: page([entry(1, 1)]), place: 2 }]]), 5);
  expect(last).toEqual({ items: [expect.objectContaining({ n: 1 })] });
  expect(parseHistoryCursor(encodeHistoryCursor({ project: 9, memory: 0 }))).toEqual({ project: 9, memory: 0 });
  for (const bad of ["", "e30x", encodeHistoryCursor({ other: 1 } as never), btoa('{"project":-1}')]) expect(() => parseHistoryCursor(bad)).toThrow();
});

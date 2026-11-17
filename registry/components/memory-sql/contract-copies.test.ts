/**
 * Every component that uses `memory` carries an identical copy of memory-sql's `contract.ts` (a
 * component never imports another's files, SPEC P4). `tsc` refuses copies whose types differ (TS2717),
 * but not copies whose words do: the guarantees in the header are the contract too. This test finds
 * every copy in the registry (a `contract.ts` declaring `memory: MemoryStore`) and compares it byte for
 * byte. A repository test, not copied with the component.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS = join(import.meta.dir, "..");
const original = readFileSync(join(import.meta.dir, "files/src/pikit/memory-sql/contract.ts"), "utf8");

/** Every `contract.ts` under a component's `files/src/pikit/<name>/` that declares `memory`. */
function copies(): string[] {
  const found: string[] = [];
  for (const component of readdirSync(COMPONENTS)) {
    const path = join(COMPONENTS, component, "files/src/pikit", component, "contract.ts");
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (/\bmemory: MemoryStore;/.test(text)) found.push(component);
  }
  return found.sort();
}

test("memory's contract.ts is the same, byte for byte, in every component that carries it", () => {
  const users = copies();
  expect(users).toContain("memory-sql");
  expect(users).toContain("memory-recall");
  expect(users).toContain("memory-summaries");
  for (const component of users) {
    expect({ component, same: readFileSync(join(COMPONENTS, component, "files/src/pikit", component, "contract.ts"), "utf8") === original }).toEqual({ component, same: true });
  }
});

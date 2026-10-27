/**
 * tool-notify reads a delegation's chain as tool-delegate does (`callersOf`), from the `delegate:` keys
 * only tool-delegate writes. Components never import each other (C6), so `callers.ts` is a copy in
 * both; this keeps them the same: change one, copy it to the other.
 *
 * A repository test, not copied with the component: it reads tool-delegate's files, beside `files/`.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

test("callers.ts is the same in tool-delegate and tool-notify", async () => {
  const delegate = join(import.meta.dir, "../tool-delegate/files/src/pikit/tool-delegate/callers.ts");
  const notify = join(import.meta.dir, "files/src/pikit/tool-notify/callers.ts");
  expect(await Bun.file(notify).text()).toBe(await Bun.file(delegate).text());
});

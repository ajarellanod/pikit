/**
 * channel-telegram-webhook is channel-telegram's webhook twin (C6). Components never import each
 * other, so the files both need are copies; those listed here are the same file in both, and this
 * keeps them so: change one, copy it to the other. The other copies (`api.ts`, `account.ts`, the fake
 * Bot API) were extended for the webhook and are not compared.
 *
 * A repository test, not copied with the component: a project has one twin, never both, so this one
 * lives beside `files/`.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

const POLLING = join(import.meta.dir, "../channel-telegram/files/src/pikit/channel-telegram");
const WEBHOOK = join(import.meta.dir, "files/src/pikit/channel-telegram-webhook");
const SHARED = ["format.ts", "format.test.ts", "transport.ts"];

for (const file of SHARED) {
  test(`${file} is the same in channel-telegram and channel-telegram-webhook`, async () => {
    expect(await Bun.file(join(WEBHOOK, file)).text()).toBe(await Bun.file(join(POLLING, file)).text());
  });
}

/**
 * `pikit add` and `pikit remove` edit `pikit.config.ts` as text. Removing what was added gives the
 * file back byte for byte (S3), and a shape the CLI does not recognise is an error, not a guess.
 */

import { expect, test } from "bun:test";
import { CLOUDFLARE_CONFIG } from "../commands/starter.ts";
import { addComponent, boundNames, identifierFor, removeComponent, removeConfigEntry, setConfigEntry } from "./config-file.ts";

const BASE = `import { defineApp } from "@pikit/core";
import agents from "./src/extensions/agents.ts";
import permissionGate from "./src/extensions/permission-gate.ts";

export const config = {};

export default defineApp({
  components: [
    agents,
  ],
  config,
});
`;

test("a component is imported under its camelCase name and listed at the end", () => {
  const next = addComponent(BASE, { name: "channel-http" });
  expect(next).toContain('import permissionGate from "./src/extensions/permission-gate.ts";\nimport channelHttp from "./src/pikit/channel-http/index.ts";\n');
  expect(next).toContain("    agents,\n    channelHttp,\n  ],");
  expect(identifierFor("tool-read")).toBe("toolRead");
});

test("add then remove gives the file back byte for byte, config included", () => {
  let text = addComponent(BASE, { name: "channel-http" });
  text = addComponent(text, { name: "runtime-pi", importClause: "{ createRuntimePi }", entry: "createRuntimePi({ extensions: [permissionGate] })" });
  text = addComponent(text, { name: "router-basic" });
  text = setConfigEntry(text, "router-basic", '{ defaultAgent: "assistant" }');
  text = setConfigEntry(text, "server-bun", "{\n    port: 3000,\n    hostname: \"127.0.0.1\",\n  }");
  expect(text).toContain('export const config = {\n  "router-basic": { defaultAgent: "assistant" },\n  "server-bun": {');
  expect(text).toContain("    createRuntimePi({ extensions: [permissionGate] }),\n");

  let back = removeConfigEntry(removeComponent(text, "router-basic"), "router-basic");
  back = removeConfigEntry(back, "server-bun");
  back = removeComponent(removeComponent(back, "runtime-pi"), "channel-http");
  expect(back).toBe(BASE);
});

test("a file without semicolons (prettier's semi: false) gets the import after its last one, in its style", () => {
  // A `;` later in the code once pulled the insertion point down to it, into the middle of the code.
  const noSemi = BASE.replaceAll(";\n", "\n")
    .replace('import { defineApp } from "@pikit/core"', 'import {\n  defineApp,\n} from "@pikit/core"')
    .replace("export const config = {}\n", 'export const config = {}\nexport const note = "one; two"\n');
  const next = addComponent(noSemi, { name: "channel-http" });
  expect(next).toContain('import permissionGate from "./src/extensions/permission-gate.ts"\nimport channelHttp from "./src/pikit/channel-http/index.ts"\n\nexport const config');
  expect(next).toContain('export const note = "one; two"\n\nexport default');
  expect(removeComponent(next, "channel-http")).toBe(noSemi);
});

test("a component that was never listed (a deployment-*) leaves the file unchanged", () => {
  expect(removeComponent(BASE, "deployment-docker")).toBe(BASE);
  expect(removeConfigEntry(BASE, "deployment-docker")).toBe(BASE);
});

test("unrecognised shapes are errors that say what to change", () => {
  expect(() => addComponent(BASE.replace("components: [\n    agents,\n  ],", "components: [agents],"), { name: "channel-http" })).toThrow(
    /one entry per line/,
  );
  expect(() => addComponent(BASE.replace("components: [", "list: ["), { name: "channel-http" })).toThrow(/exactly one `components: \[` list/);
  expect(() => addComponent(BASE, { name: "channel-http", importClause: "agents" })).toThrow(/already used/);
  expect(() => setConfigEntry(BASE.replace("export const config = {};\n", ""), "router-basic", "{}")).toThrow(/no `const config/);

  const shared = addComponent(BASE, { name: "channel-http" }).replace("    agents,\n    channelHttp,\n", "    agents, channelHttp,\n");
  expect(() => removeComponent(shared, "channel-http")).toThrow(/shares its line/);
});

test("with two Apps (a Cloudflare project, SPEC C1), a component without a Worker half goes in the default export's list and config only", () => {
  let text = addComponent(CLOUDFLARE_CONFIG, { name: "storage-do" });
  text = setConfigEntry(text, "storage-do", "{}");
  expect(text).toContain("export default defineApp({\n  components: [\n    agents,\n    storageDo,\n  ],");
  expect(text).toContain('export const config = {\n  "storage-do": {},\n};');
  expect(text).toContain("export const worker = defineApp({\n  components: [\n  ],\n  config: workerConfig,\n});");
  expect(removeConfigEntry(removeComponent(text, "storage-do"), "storage-do")).toBe(CLOUDFLARE_CONFIG);

  // Several lists and no default export: nothing to choose, said so.
  expect(() => addComponent(CLOUDFLARE_CONFIG.replace("export default defineApp", "export const object = defineApp"), { name: "storage-do" })).toThrow(
    /exactly one `components: \[` list in its default export, found 2/,
  );
});

test("a component with a Worker half goes in both lists; remove takes it out of both, and its keys out of both configs", () => {
  const text = addComponent(CLOUDFLARE_CONFIG, {
    name: "channel-telegram-webhook",
    importClause: "channelTelegramWebhook, { worker as channelTelegramWebhookWorker }",
    worker: "channelTelegramWebhookWorker",
  });
  expect(text).toContain(
    'import permissionGate from "./src/extensions/permission-gate.ts";\nimport channelTelegramWebhook, { worker as channelTelegramWebhookWorker } from "./src/pikit/channel-telegram-webhook/index.ts";\n',
  );
  expect(text).toContain("export default defineApp({\n  components: [\n    agents,\n    channelTelegramWebhook,\n  ],");
  expect(text).toContain("export const worker = defineApp({\n  components: [\n    channelTelegramWebhookWorker,\n  ],\n  config: workerConfig,\n});");

  // Configured by hand in each App, under each half's name.
  const configured = setConfigEntry(text, "channel-telegram-webhook", "{ accounts: [] }").replace(
    "export const workerConfig = {};",
    'export const workerConfig = {\n  "channel-telegram-webhook-worker": {\n    accounts: [],\n  },\n};',
  );
  let back = removeComponent(configured, "channel-telegram-webhook");
  back = removeConfigEntry(back, "channel-telegram-webhook");
  back = removeConfigEntry(back, "channel-telegram-webhook-worker", "workerConfig");
  expect(back).toBe(CLOUDFLARE_CONFIG);

  // A component that works in both Apps is the same entry in each.
  const both = addComponent(CLOUDFLARE_CONFIG, { name: "secrets-cloudflare", worker: "secretsCloudflare" });
  expect(both).toContain("    agents,\n    secretsCloudflare,\n  ],");
  expect(both).toContain("  components: [\n    secretsCloudflare,\n  ],\n  config: workerConfig,");
  expect(removeComponent(both, "secrets-cloudflare")).toBe(CLOUDFLARE_CONFIG);

  // Listed in the Worker by hand, it is taken out of it too: remove undoes both Apps.
  const byHand = addComponent(CLOUDFLARE_CONFIG, { name: "storage-do" }).replace("  components: [\n  ],\n  config: workerConfig", "  components: [\n    storageDo,\n  ],\n  config: workerConfig");
  expect(removeComponent(byHand, "storage-do")).toBe(CLOUDFLARE_CONFIG);
});

test("a Worker half needs the Worker's App: a file without one, or with two lists in it, is refused", () => {
  expect(() => addComponent(BASE, { name: "secrets-cloudflare", worker: "secretsCloudflare" })).toThrow(/no `export const worker = defineApp/);
  const twoLists = CLOUDFLARE_CONFIG.replace("  config: workerConfig,\n", "  config: workerConfig,\n  extra: { components: [\n  ] },\n");
  expect(() => addComponent(twoLists, { name: "secrets-cloudflare", worker: "secretsCloudflare" })).toThrow(/exactly one `components: \[` list in `export const worker`, found 2/);
  // No workerConfig (a server project): nothing to remove there.
  expect(removeConfigEntry(BASE, "channel-telegram-webhook-worker", "workerConfig")).toBe(BASE);
});

test("an entry written over several lines is removed whole", () => {
  const wrapped = addComponent(BASE, { name: "channel-http" }).replace("    channelHttp,\n", "    wrap(\n      channelHttp, // the channel\n    ),\n");
  expect(removeComponent(wrapped, "channel-http")).toBe(BASE);
});

test("a name still used outside the list stops the removal", () => {
  const text = `${addComponent(BASE, { name: "channel-http" })}\nconsole.log(channelHttp.name);\n`;
  expect(() => removeComponent(text, "channel-http")).toThrow(/still used/);
});

test("import clauses: default, named, renamed, namespace", () => {
  expect(boundNames("a")).toEqual(["a"]);
  expect(boundNames("{ b, c as d }")).toEqual(["b", "d"]);
  expect(boundNames("e, { f }")).toEqual(["f", "e"]);
  expect(boundNames("* as g")).toEqual(["g"]);
});

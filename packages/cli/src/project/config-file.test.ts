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

test("with two Apps (a Cloudflare project, SPEC C1), add and remove edit the default export's list and config, never the Worker's", () => {
  let text = addComponent(CLOUDFLARE_CONFIG, { name: "storage-do" });
  text = setConfigEntry(text, "storage-do", "{}");
  expect(text).toContain("export default defineApp({\n  components: [\n    agents,\n    storageDo,\n  ],");
  expect(text).toContain('export const config = {\n  "storage-do": {},\n};');
  expect(text).toContain("export const worker = defineApp({\n  components: [\n  ],\n  config: workerConfig,\n});");
  expect(removeConfigEntry(removeComponent(text, "storage-do"), "storage-do")).toBe(CLOUDFLARE_CONFIG);

  // A component listed in the Worker by hand is still used there: removing it is refused, not half done.
  const inWorker = text.replace("  components: [\n  ],\n  config: workerConfig", "  components: [\n    storageDo,\n  ],\n  config: workerConfig");
  expect(() => removeComponent(inWorker, "storage-do")).toThrow(/still used outside the components list/);
  // Several lists and no default export: nothing to choose, said so.
  expect(() => addComponent(CLOUDFLARE_CONFIG.replace("export default defineApp", "export const object = defineApp"), { name: "storage-do" })).toThrow(
    /exactly one `components: \[` list in its default export, found 2/,
  );
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

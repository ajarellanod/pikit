import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPiExtensions, inspectExtension } from "./pi-extensions.ts";

/** Written through a template, so the repository's import checks do not read these sources as imports. */
const ALIAS = "@earendil-works/pi-coding-agent";
const EXAMPLES = join(import.meta.dir, "..", "..", "..", "pi-adapter", "src", "extensions", "pi-examples");

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test("Pi's examples that pikit runs have nothing unsupported; hello registers a tool", () => {
  for (const example of ["permission-gate.ts", "protected-paths.ts", "hello.ts"]) {
    expect(inspectExtension(readFileSync(join(EXAMPLES, example), "utf8"))).toEqual({
      missing: [],
      subpaths: [],
      unsupported: [],
      registersTools: example === "hello.ts",
    });
  }
});

test("registering tools is noted, under whatever name the API has, and is not unsupported", () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-pi-extensions-"));
  dirs.push(dir);
  const files: Record<string, string> = {
    "src/extensions/weather.ts": [
      `import { defineTool, type ExtensionAPI } from "${ALIAS}";`,
      "export default function (api: ExtensionAPI) {",
      "  api.registerTool(defineTool({} as never));",
      "}",
    ].join("\n"),
    // Mentioned in a comment only: not a registration.
    "src/extensions/quiet.ts": `import type { ExtensionAPI } from "${ALIAS}";\n// pi.registerTool(x)\nexport default (pi: ExtensionAPI) => void pi;\n`,
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  expect(inspectExtension(files["src/extensions/weather.ts"] ?? "")).toMatchObject({ unsupported: [], registersTools: true });
  const { problems, notes } = checkPiExtensions(dir, Object.keys(files));
  expect(problems).toEqual([]);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toStartWith("src/extensions/weather.ts registers tools with pi.registerTool");
  expect(notes[0]).toContain('replay "never"');
  expect(notes[0]).toContain("toolComponent from @pikit/pi-adapter/tools");
  expect(notes[0]).toContain("Only tools registered while the extension loads (in its factory) reach the model");
});

test("a name or a subpath the shim does not export is missing, a type included; comments are not imports", () => {
  const source = [
    `import { createBashTool, defineTool, type ExtensionAPI, type Theme as T } from "${ALIAS}";`,
    `import type { SessionEntry } from "${ALIAS}";`,
    `import { thing } from "${ALIAS}/internal";`,
    `// import { VERSION } from "${ALIAS}";`,
    "export default function (pi: ExtensionAPI) {}",
  ].join("\n");
  const found = inspectExtension(source);
  expect(found.missing).toEqual(["createBashTool", "Theme", "SessionEntry"]);
  expect(found.subpaths).toEqual(["@earendil-works/pi-coding-agent/internal"]);
});

test("unsupported surface is listed as written, under whatever name the API has", () => {
  const source = [
    `import type { ExtensionAPI } from "${ALIAS}";`,
    "export default function (api: ExtensionAPI) {",
    '  api.on("tool_call", () => undefined);',
    '  api.on("input", () => undefined);',
    '  api.events.on("my:channel", () => undefined);',
    '  api.registerCommand("x", {});',
    '  api.registerProvider("proxy", {});',
    "  api.unregisterProvider('proxy');",
    '  api.registerMcpServer("jira", { url: "https://mcp.example.com" });',
    "  api.getMcpServers();",
    '  api.on("session_start", async (_event, ctx) => {',
    "    ctx.sessionManager.getEntries();",
    "    ctx.ui.custom(() => undefined);",
    '    ctx.ui.notify("hi");',
    "    if (ctx.hasUI) await ctx.ui.select('a', []);",
    "  });",
    "}",
  ].join("\n");
  expect(inspectExtension(source).unsupported).toEqual([
    'pi.on("input")',
    "pi.registerCommand",
    "pi.unregisterProvider",
    "pi.registerMcpServer",
    "pi.registerProvider(name, config)",
    "ctx.sessionManager",
    "ctx.ui.custom",
  ]);
});

test("checkPiExtensions: a missing name is a problem, unsupported surface a note, a supported extension nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-pi-extensions-"));
  dirs.push(dir);
  const files: Record<string, string> = {
    "src/extensions/header.ts": `import { VERSION, type ExtensionAPI } from "${ALIAS}";\nexport default (pi: ExtensionAPI) => void VERSION;\n`,
    "src/extensions/tui.ts": `import type { ExtensionAPI } from "${ALIAS}";\nexport default (pi: ExtensionAPI) => pi.on("user_bash", (_e, ctx) => ctx.ui.custom(() => undefined));\n`,
    "src/extensions/gate.ts": readFileSync(join(EXAMPLES, "permission-gate.ts"), "utf8"),
    "src/extensions/agents.ts": 'import { defineComponent } from "@pikit/core";\nexport default defineComponent({ name: "agents", setup() {} });\n',
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  const { problems, notes } = checkPiExtensions(dir, Object.keys(files));
  expect(problems).toEqual(["src/extensions/header.ts imports `VERSION` from @earendil-works/pi-coding-agent, which pikit does not provide (runtime-pi's README, \"Pi extensions\")"]);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toStartWith("src/extensions/tui.ts uses what pikit does not provide");
  expect(notes[0]).toEndWith(': pi.on("user_bash"), ctx.ui.custom');
});

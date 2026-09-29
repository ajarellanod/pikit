/**
 * `pikit doctor` checks Pi extensions against the CLI's copy of what the adapter provides
 * (tier A). The copy must be the adapter's, and the adapter's own lists must agree.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_COPY,
  drift,
  EXTENSIONS_DIR,
  eventNames,
  exportedNames,
  interfaceMembers,
  localSurface,
  moduleExports,
  render,
  toolMembers,
} from "./pi-extension-surface.ts";

test("the CLI's copy is the adapter's surface: run bun scripts/pi-extension-surface.ts when this fails", () => {
  expect(readFileSync(CLI_COPY, "utf8")).toBe(render(localSurface()));
});

test("the shim exports at run time exactly the values read from the adapter's sources", async () => {
  const parsed = moduleExports(join(EXTENSIONS_DIR, "index.ts")).values;
  expect(Object.keys(await import("../packages/pi-extension-shim/src/index.ts")).sort()).toEqual(parsed);
  // The name extensions import, aliased to the shim in this repository as in a project.
  expect(Object.keys(await import("@earendil-works/pi-coding-agent")).sort()).toEqual(parsed);
});

test("the events pikit fires are the events its ExtensionAPI types", () => {
  const api = readFileSync(join(EXTENSIONS_DIR, "api.ts"), "utf8");
  expect(localSurface().supportedEvents).toEqual(eventNames(api));
});

test("the parsers: an export they do not understand throws; members are read at the top level only", () => {
  expect(exportedNames('export { a, type B, c as d } from "./x.ts";\nexport type { E } from "./y.ts";\nexport function f() {}\nexport interface I {}\n')).toEqual({
    values: ["a", "d", "f"],
    types: ["B", "E", "I"],
    starFrom: [],
  });
  expect(() => exportedNames("export default function () {}\n")).toThrow("not understood");
  expect(exportedNames("export default function () {}\n", false).values).toEqual([]);
  const source = [
    "export interface Api {",
    "  /** on(event: string) */",
    '  on(event: "a", handler: () => void): void;',
    "  send(",
    "    message: { nested: string },",
    "    options?: {",
    "      deep?: boolean;",
    "    },",
    "  ): void;",
    "  readonly events: { emit(): void };",
    "  getModel: () => string;",
    "  [key: string]: unknown;",
    "}",
  ].join("\n");
  expect(interfaceMembers(source, "Api")).toEqual(["events", "getModel", "on", "send"]);
  expect(eventNames(source, "Api")).toEqual(["a"]);
});

test("the tool interfaces: ToolDefinition, and ExtensionToolContext's own members when there is one", () => {
  // Shaped as Pi 0.99 writes them: generic defaults, `extends`, members over several lines.
  const pi099 = [
    "export interface ExtensionContext { cwd: string; }",
    "/** interface ExtensionToolContext in a comment does not count */",
    "export interface ExtensionToolContext extends ExtensionContext {",
    "  readonly tools: readonly AgentTool[];",
    "  executeTool(name: string, args: unknown, options?: ExecuteToolOptions): Promise<AgentToolCallOutcome>;",
    "}",
    "export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {",
    "  name: string;",
    "  exposure?: ToolExposure;",
    "  prepareLoadout?: (loadout: ToolLoadout) => ToolLoadoutChanges | undefined;",
    "  execute(",
    "    toolCallId: string,",
    "    ctx: ExtensionToolContext,",
    "  ): Promise<AgentToolResult<TDetails>>;",
    "}",
  ].join("\n");
  expect(toolMembers(pi099)).toEqual({ toolDefinition: ["execute", "exposure", "name", "prepareLoadout"], toolContext: ["executeTool", "tools"] });
  // Pi before 0.99 has no ExtensionToolContext.
  const pi087 = "export interface ToolDefinition<TParams extends TSchema = TSchema> {\n  name: string;\n  execute(): void;\n}";
  expect(toolMembers(pi087)).toEqual({ toolDefinition: ["execute", "name"], toolContext: [] });
  expect(drift(["a", "b", "c"], ["b", "d"])).toEqual({ lacks: ["a", "c"], extra: ["d"] });
});

test("pikit's tool interfaces have what Pi 0.99 added to them", () => {
  const local = toolMembers(readFileSync(join(EXTENSIONS_DIR, "api.ts"), "utf8"));
  const added = ["annotations", "defaultActive", "executionMode", "exposure", "namespace", "outputSchema", "prepareLoadout"];
  expect(drift(added, local.toolDefinition).lacks).toEqual([]);
  // Left out on purpose: `constrainedSampling` waits for a codemode component (features/codemode.md),
  // `renderShell` is Pi's TUI. At run time they are ignored; in a typed object literal they fail typecheck.
  expect(local.toolDefinition).not.toContain("constrainedSampling");
  expect(local.toolContext).toEqual(["executeTool", "tools"]);
});

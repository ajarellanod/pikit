/**
 * The packages' import boundaries (`scripts/boundaries.ts`): the repository keeps them, and each
 * rule catches the change it exists for, on throwaway packages that break exactly that rule.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkBoundaries } from "./boundaries.ts";

const REPO = join(import.meta.dir, "..");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A `packages/` directory: package dir → its package.json fields and its files (path → source). */
function packages(spec: Record<string, { json: Record<string, unknown>; files: Record<string, string> }>): string {
  const root = join(mkdtempSync(join(tmpdir(), "pikit-boundaries-")), "packages");
  dirs.push(dirname(root));
  for (const [dir, { json, files }] of Object.entries(spec)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(json));
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, dir, path)), { recursive: true });
      writeFileSync(join(root, dir, path), source);
    }
  }
  return root;
}

/** A core like the real one: neutral, typebox only. `files` replace or add to its sources. */
const core = (files: Record<string, string> = {}) => ({
  json: { name: "@pikit/core", exports: { ".": "./src/index.ts" }, dependencies: { typebox: "1.3.27" } },
  files: { "src/index.ts": `export * from "./config.ts";\n`, "src/config.ts": `import Type from "typebox";\n`, ...files },
});

/** An adapter like the real one: Pi and core, Node only behind `./node`. */
const adapter = (files: Record<string, string> = {}) => ({
  json: {
    name: "@pikit/pi-adapter",
    exports: { ".": "./src/index.ts", "./node": "./src/node/index.ts" },
    dependencies: { "@earendil-works/pi-agent-core": "0.87.1", "@pikit/core": "workspace:*" },
  },
  files: {
    "src/index.ts": `export * from "./runtime.ts";\n`,
    "src/runtime.ts": `import { AgentHarness } from "@earendil-works/pi-agent-core";\n`,
    "src/node/index.ts": `import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";\nimport { readFile } from "node:fs/promises";\n`,
    ...files,
  },
});

test("the repository's packages keep every boundary", () => {
  expect(checkBoundaries(join(REPO, "packages"))).toEqual([]);
});

test("the fixtures keep them too, so each test below breaks only its own rule", () => {
  expect(checkBoundaries(packages({ core: core(), "pi-adapter": adapter() }))).toEqual([]);
});

test("core reading a file with node:fs is caught: core must run on every target (case A)", () => {
  const root = packages({ core: core({ "src/config.ts": `import { readFileSync } from "node:fs";\n` }) });
  expect(checkBoundaries(root)).toEqual([
    `packages/core/src/config.ts imports "node:fs", but @pikit/core reaches it and must run on every target (rule 5)`,
  ]);
});

test("core importing a Pi type is caught, even type-only (case B)", () => {
  const root = packages({ core: core({ "src/agent.ts": `import type { Usage } from "@earendil-works/pi-ai";\n` }) });
  expect(checkBoundaries(root)).toEqual([`packages/core/src/agent.ts imports "@earendil-works/pi-ai": only @pikit/pi-adapter imports Pi (rule 1)`]);
});

test("the adapter's main entry reaching Node is caught; the same import behind ./node is not (case C)", () => {
  const direct = packages({
    "pi-adapter": adapter({ "src/runtime.ts": `import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";\n` }),
  });
  expect(checkBoundaries(direct)).toEqual([
    `packages/pi-adapter/src/runtime.ts imports "@earendil-works/pi-agent-core/node", but @pikit/pi-adapter reaches it and must run on every target (rule 5)`,
  ]);
  // Through a relative import into node/: the file reached is reported, with the entry that reached it.
  const relative = packages({ "pi-adapter": adapter({ "src/runtime.ts": `import { x } from "./node/index.ts";\n` }) });
  expect(checkBoundaries(relative)).toEqual([
    `packages/pi-adapter/src/node/index.ts imports "@earendil-works/pi-agent-core/node", but @pikit/pi-adapter reaches it and must run on every target (rule 5)`,
    `packages/pi-adapter/src/node/index.ts imports "node:fs/promises", but @pikit/pi-adapter reaches it and must run on every target (rule 5)`,
  ]);
});

test("a new export is neutral until SERVER_ONLY says otherwise", () => {
  const json = { ...adapter().json, exports: { ...adapter().json.exports, "./files": "./src/files.ts" } };
  const root = packages({ "pi-adapter": { json, files: { ...adapter().files, "src/files.ts": `import { readFile } from "node:fs/promises";\n` } } });
  expect(checkBoundaries(root)).toEqual([
    `packages/pi-adapter/src/files.ts imports "node:fs/promises", but @pikit/pi-adapter/files reaches it and must run on every target (rule 5)`,
  ]);
});

test("an undeclared package is caught: the CLI importing the adapter", () => {
  const cli = {
    json: { name: "@pikit/cli", dependencies: { "@pikit/core": "workspace:*" } },
    files: {
      "src/credentials.ts": `import type { CredentialStore } from "@pikit/pi-adapter";\n`,
      // Templates of generated code are not imports.
      "src/starter.ts": "export const line = (pkg: string) => `import x from \"${pkg}\";`;\n",
    },
  };
  expect(checkBoundaries(packages({ cli }))).toEqual([`packages/cli/src/credentials.ts imports "@pikit/pi-adapter", which is not a dependency of @pikit/cli`]);
});

test("a Node builtin without its scheme, and a relative import out of the package, are caught; tests may do the latter", () => {
  const root = packages({
    core: core({
      "src/config.ts": `import { join } from "path";\nimport { x } from "../../registry/x.ts";\n`,
      "src/config.test.ts": `import { expect } from "bun:test";\nimport { fixture } from "../../../registry/fixture.ts";\n`,
    }),
  });
  expect(checkBoundaries(root)).toEqual([
    `packages/core/src/config.ts imports the Node builtin "path" without its scheme: write "node:path"`,
    `packages/core/src/config.ts imports "../../registry/x.ts", outside @pikit/core: reach another package through its exports`,
    `packages/core/src/config.ts imports "path", but @pikit/core reaches it and must run on every target (rule 5)`,
  ]);
});

test("Pi's unmodified example extensions may import the extension alias; nothing else in the adapter may", () => {
  const alias = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n`;
  const root = packages({ "pi-adapter": adapter({ "src/extensions/pi-examples/hello.ts": alias, "src/extensions/host.ts": alias }) });
  expect(checkBoundaries(root)).toEqual([
    `packages/pi-adapter/src/extensions/host.ts imports "@earendil-works/pi-coding-agent", which is not a dependency of @pikit/pi-adapter`,
  ]);
});

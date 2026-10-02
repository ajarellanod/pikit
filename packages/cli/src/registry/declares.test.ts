/**
 * A registry of someone's own extends the kit's vocabulary without a change to the CLI: a component
 * declares the kind of its name and the capability whose contract it defines (`declares` in its
 * component.json), `registry validate` accepts the registry, and `pikit add` installs from it.
 *
 * The scratch registry is generated like a real one, so its manifests satisfy the whole schema
 * (`optional.capabilities` included); its files import nothing at runtime (type-only imports are
 * erased), so they load without node_modules.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { runCli } from "../testing/cli.ts";
import { generate, validate } from "./commands.ts";
import type { Manifest } from "./manifest.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-declares-test-"));
  dirs.push(dir);
  return dir;
};

const MEMORY = { mode: "single", stability: "experimental", summary: "What the agent remembers of each person, across conversations." };

/** `memory-sql` provides `memory`; `tool-memory` uses it. `declares` is what memory-sql's component.json says by hand. */
async function memoryRegistry(declares: Manifest["declares"] | undefined): Promise<string> {
  const root = temp();
  const component = (name: string, setup: string) => {
    const own = join(root, "components", name, "files", "src", "pikit", name);
    mkdirSync(own, { recursive: true });
    writeFileSync(join(root, "components", name, "README.md"), `# ${name}\n\nPart of a memory feature.\n`);
    writeFileSync(
      join(own, "index.ts"),
      `import type { ComponentDefinition } from "@pikit/core";\n\nconst component: ComponentDefinition = {\n  name: "${name}",\n  setup(pikit) {\n    ${setup}\n  },\n};\nexport default component;\n`,
    );
    writeFileSync(join(own, `${name}.test.ts`), "// the component's own test\n");
  };
  // `as never`: the scratch registry has no declaration merging for `memory`, which a real one's contract file adds.
  component("memory-sql", 'pikit.provide("memory" as never, { remember: async () => {} } as never);');
  component("tool-memory", 'pikit.use("memory" as never);');
  expect((await generate(root)).problems).toEqual([]);
  // The hand-written fields: where they run, and the vocabulary memory-sql adds.
  for (const name of ["memory-sql", "tool-memory"]) {
    const path = join(root, "components", name, "component.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    writeFileSync(path, JSON.stringify({ ...manifest, targets: ["server"], ...(name === "memory-sql" && declares !== undefined && { declares }) }));
  }
  expect((await generate(root)).problems).toEqual([]);
  return root;
}

/** A project `add` runs to the end in: no kit dependency to install, `@pikit/core` linked. */
function project(): string {
  const dir = temp();
  writeProjectManifest(dir, emptyManifest());
  writeFileSync(join(dir, "package.json"), '{ "name": "remembering", "dependencies": {} }\n');
  writeFileSync(join(dir, ".env.example"), "# the project's own\n");
  writeFileSync(
    join(dir, "pikit.config.ts"),
    'import { defineApp } from "@pikit/core";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n  ],\n  config,\n});\n',
  );
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "..", "..", "core"), join(dir, "node_modules", "@pikit", "core"));
  return dir;
}

test("without declarations, a new kind and a new capability are refused, and the message says where to declare them", async () => {
  const problems = (await validate(await memoryRegistry(undefined))).problems.join("\n");

  expect(problems).toContain('memory-sql: name "memory-sql" has no known kind prefix');
  expect(problems).toContain('"declares": { "kinds": ["memory"] } in its component.json');
  expect(problems).toContain('tool-memory: capability "memory" is not in the catalogue');
  expect(problems).not.toContain("packages/cli");
});

test("a registry that declares kind memory and capability memory validates, and pikit add installs from it", async () => {
  const root = await memoryRegistry({ kinds: ["memory"], capabilities: { memory: MEMORY } });
  expect((await validate(root)).problems).toEqual([]);

  const dir = project();
  const sql = await runCli(["add", "memory-sql", "--registry", root, "--yes"], dir);
  expect(sql.out).toContain("memory-sql installed");
  expect(sql.code).toBe(0);
  const tool = await runCli(["add", "tool-memory", "--registry", root, "--yes"], dir);
  expect(tool.code).toBe(0);

  expect(Object.keys(JSON.parse(readFileSync(join(dir, "pikit.json"), "utf8")).components).sort()).toEqual(["memory-sql", "tool-memory"]);
  // Composed in the project: the capability resolves like any of the kit's.
  const doctor = await runCli(["doctor"], dir);
  expect(doctor.out).toContain("memory: memory-sql");
}, 60_000);

test("pikit registry capabilities shows a declared capability with who declares it", async () => {
  const root = await memoryRegistry({ kinds: ["memory"], capabilities: { memory: MEMORY } });

  const run = await runCli(["registry", "capabilities", root], root);

  expect(run.out).toContain(`memory  (single, declared by memory-sql, experimental)\n  ${MEMORY.summary}\n  provided by: memory-sql\n  used by:     tool-memory`);
});

test("redeclaring the kit's vocabulary is refused", async () => {
  const root = await memoryRegistry({ kinds: ["memory", "tool"], capabilities: { memory: MEMORY, "storage.sql": MEMORY } });

  expect((await validate(root)).problems).toEqual([
    'memory-sql: declares the kind "tool", which the kit has already: declare only new kinds',
    'memory-sql: declares the capability "storage.sql", which the kit defines (@pikit/contracts): use it, or declare a capability of another name',
  ]);
});

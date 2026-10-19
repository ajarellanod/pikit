/**
 * A component's UI project (its manifest's `ui`, `project/ui-project.ts`), run as a user runs `pikit
 * add`, `upgrade`, `remove` and `doctor`, against a local registry whose `channel-fake` ships `web/` to
 * `src/web/`. Its one package is a local folder, so its `bun install` needs no network.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest, hashOf, writeProjectManifest } from "../project/pikit-json.ts";
import { runCli } from "../testing/cli.ts";
import { BUNFIG, tsconfig } from "./starter.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-ui-project-test-"));
  dirs.push(dir);
  return dir;
};

const LINES = Array.from({ length: 10 }, (_, i) => `export const line${i + 1} = ${i + 1};`);
const lines = (edits: Record<number, string> = {}) => `${LINES.map((line, i) => edits[i + 1] ?? line).join("\n")}\n`;

/** The UI project `channel-fake` ships, by its path in `web/`. */
const WEB: Record<string, string> = {
  "package.json": `${JSON.stringify({ name: "web", private: true, scripts: { build: "bun build.ts" }, dependencies: { dep: "file:./dep" } }, null, 2)}\n`,
  "bun.lock": '{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "web",\n      "dependencies": {\n        "dep": "file:./dep",\n      },\n    },\n  },\n  "packages": {\n    "dep": ["dep@file:dep", {}],\n  }\n}\n',
  "dep/package.json": '{ "name": "dep", "version": "1.0.0" }\n',
  "build.ts": 'await Bun.write("../pikit/channel-fake/web-files.ts", "export const WEB_FILES = { built: true };\\n");\n',
  "src/app.tsx": lines(),
};
const APP = WEB["src/app.tsx"] as string;

/** A component of `name` whose UI project goes to `target`. */
function component(root: string, name: string, target: string, version = "0.1.0"): void {
  const dir = join(root, "components", name);
  mkdirSync(join(dir, "files", "src", "pikit", name), { recursive: true });
  writeFileSync(join(dir, "files", "src", "pikit", name, "index.ts"), `import { defineComponent } from "@pikit/core";\n\nexport default defineComponent({ name: "${name}", setup() {} });\n`);
  writeFileSync(join(dir, "files", "src", "pikit", name, "web-files.ts"), "export const WEB_FILES = {};\n");
  for (const [file, text] of Object.entries(WEB)) {
    mkdirSync(join(dir, "web", file, ".."), { recursive: true });
    writeFileSync(join(dir, "web", file), text);
  }
  // What its toolchain made in the registry's copy: never shipped.
  mkdirSync(join(dir, "web", "node_modules", "left"), { recursive: true });
  writeFileSync(join(dir, "web", "node_modules", "left", "index.js"), "");
  mkdirSync(join(dir, "web", "dist"), { recursive: true });
  writeFileSync(join(dir, "web", "dist", "index.html"), "<html>");
  writeFileSync(
    join(dir, "component.json"),
    JSON.stringify({
      name, version, description: name, targets: ["server"], requires: { pikit: "0.0.1", capabilities: [] }, optional: { capabilities: [] }, provides: [],
      generated: ["web-files.ts"], ui: { source: "web", target }, dependencies: {}, files: [{ source: "files/src", target: "src" }],
    }),
  );
  const indexPath = join(root, "registry.json");
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : { version: 1, components: {} };
  index.components[name] = { version, description: name, targets: ["server"], path: `components/${name}` };
  writeFileSync(indexPath, JSON.stringify(index));
}

function registry(): string {
  const root = temp();
  component(root, "channel-fake", "src/web");
  return root;
}

/** A project whose default registry is `root`, with the starter's tsconfig.json and bunfig.toml. */
function project(root: string): string {
  const dir = temp();
  writeProjectManifest(dir, emptyManifest(root, undefined, ["server"]));
  writeFileSync(join(dir, "package.json"), '{ "name": "with-web", "dependencies": {} }\n');
  writeFileSync(join(dir, ".env.example"), "# the project's own\n");
  writeFileSync(join(dir, "tsconfig.json"), tsconfig());
  writeFileSync(join(dir, "bunfig.toml"), BUNFIG);
  writeFileSync(join(dir, "pikit.config.ts"), 'import { defineApp } from "@pikit/core";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n  ],\n  config,\n});\n');
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "..", "..", "core"), join(dir, "node_modules", "@pikit", "core"));
  return dir;
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const manifest = (dir: string) => JSON.parse(read(dir, "pikit.json"));
const baseOf = (text: string) => hashOf(text).slice("sha256:".length);

/** Every file under `dir` (its node_modules aside) → its content. */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, prefix)).sort()) {
    const relative = `${prefix}${entry}`;
    if (relative === "node_modules") continue;
    if (statSync(join(dir, relative)).isDirectory()) Object.assign(files, snapshot(dir, `${relative}/`));
    else files[relative] = readFileSync(join(dir, relative), "latin1");
  }
  return files;
}

test("add writes the UI project as the component's files, with hashes and bases, installs its packages and lists it where tsc and bun test skip it", async () => {
  const dir = project(registry());

  const add = await runCli(["add", "channel-fake", "--yes"], dir);

  expect(add.code).toBe(0);
  expect(add.out).toContain(`its UI project: ${Object.keys(WEB).length} files in src/web/`);
  expect(add.out).not.toContain("It also writes");
  expect(add.out).not.toContain("! src/web");
  const installed = manifest(dir).components["channel-fake"];
  for (const [file, text] of Object.entries(WEB)) {
    expect(installed.files[`src/web/${file}`]).toEqual({ hash: hashOf(text) });
    expect(existsSync(join(dir, "pikit-bases", baseOf(text)))).toBe(true);
  }
  expect(read(dir, "src/web/src/app.tsx")).toBe(APP);
  // What the registry's toolchain made is never shipped.
  expect(Object.keys(installed.files).filter((file) => file.includes("node_modules") || file.includes("dist"))).toEqual([]);
  expect(installed.ui).toBe("src/web");
  expect(installed.generated).toEqual(["src/pikit/channel-fake/web-files.ts", "src/web/bun.lock"]);
  // Its own packages, installed in it.
  expect(existsSync(join(dir, "src/web/node_modules/dep/package.json"))).toBe(true);
  expect(JSON.parse(read(dir, "tsconfig.json")).exclude).toEqual(["node_modules", "vendor", ".pikit", "registry", "src/dashboard", "src/web"]);
  expect(read(dir, "bunfig.toml")).toContain('pathIgnorePatterns = ["registry/**", "src/dashboard/**", "src/web/**"]');
});

test("doctor names an edit of the UI project, never its lockfile nor what its build writes", async () => {
  const dir = project(registry());
  expect((await runCli(["add", "channel-fake", "--yes"], dir)).code).toBe(0);
  writeFileSync(join(dir, "src/web/src/app.tsx"), lines({ 2: "export const line2 = 'mine';" }));
  writeFileSync(join(dir, "src/web/bun.lock"), `${read(dir, "src/web/bun.lock")}\n`);
  const built = Bun.spawn([process.execPath, "run", "build"], { cwd: join(dir, "src/web"), stdout: "ignore", stderr: "ignore" });
  expect(await built.exited).toBe(0);
  expect(read(dir, "src/pikit/channel-fake/web-files.ts")).toContain("built: true");

  const doctor = await runCli(["doctor"], dir);
  expect(doctor.out).toContain("modified: src/web/src/app.tsx (channel-fake)");
  expect(doctor.out).not.toContain("src/web/bun.lock");
  expect(doctor.out).not.toContain("web-files.ts");
});

test("upgrade merges the registry's changes to the UI project with your edits", async () => {
  const root = registry();
  const dir = project(root);
  expect((await runCli(["add", "channel-fake", "--yes"], dir)).code).toBe(0);
  writeFileSync(join(dir, "src/web/src/app.tsx"), lines({ 2: "export const line2 = 'mine';" }));
  component(root, "channel-fake", "src/web", "0.2.0");
  writeFileSync(join(root, "components/channel-fake/web/src/app.tsx"), lines({ 9: "export const line9 = 'theirs';" }));
  writeFileSync(join(root, "components/channel-fake/web/src/new.tsx"), "export const added = 1;\n");

  const run = await runCli(["upgrade", "channel-fake", "--yes"], dir);

  expect(run.code).toBe(0);
  expect(run.out).toContain("merged with your edits: src/web/src/app.tsx");
  expect(run.out).toContain("added: src/web/src/new.tsx");
  expect(read(dir, "src/web/src/app.tsx")).toBe(lines({ 2: "export const line2 = 'mine';", 9: "export const line9 = 'theirs';" }));
  expect(manifest(dir).components["channel-fake"].files["src/web/src/new.tsx"]).toEqual({ hash: hashOf("export const added = 1;\n") });
});

test("remove deletes the UI project, what its toolchain made, and its listing: the project is as it was", async () => {
  const dir = project(registry());
  const before = snapshot(dir);
  expect((await runCli(["add", "channel-fake", "--yes"], dir)).code).toBe(0);
  mkdirSync(join(dir, "src/web/dist"));
  writeFileSync(join(dir, "src/web/dist/index.html"), "<html>");

  const remove = await runCli(["remove", "channel-fake"], dir);

  expect(remove.code).toBe(0);
  expect(existsSync(join(dir, "src/web"))).toBe(false);
  expect(snapshot(dir)).toEqual(before);
});

test("remove keeps a file of yours in the UI project's folder, and says so", async () => {
  const dir = project(registry());
  expect((await runCli(["add", "channel-fake", "--yes"], dir)).code).toBe(0);
  writeFileSync(join(dir, "src/web/notes.md"), "mine\n");

  const remove = await runCli(["remove", "channel-fake"], dir);

  expect(remove.code).toBe(0);
  expect(remove.err + remove.out).toContain("src/web/ is kept: it has files channel-fake did not install (src/web/notes.md)");
  expect(readdirSync(join(dir, "src/web"))).toEqual(["notes.md"]);
});

test("add refuses a UI project whose folder exists and is not the component's (unless --force), or is another component's", async () => {
  const root = registry();
  const dir = project(root);
  mkdirSync(join(dir, "src/web"), { recursive: true });
  writeFileSync(join(dir, "src/web/notes.md"), "mine\n");
  const before = snapshot(dir);

  const refused = await runCli(["add", "channel-fake", "--yes"], dir);
  expect(refused.err).toContain("channel-fake's UI project goes to src/web/, which exists and is not channel-fake's");
  expect(refused.code).toBe(1);
  expect(snapshot(dir)).toEqual(before);
  expect((await runCli(["add", "channel-fake", "--yes", "--force"], dir)).code).toBe(0);

  component(root, "channel-other", "src/web");
  const taken = await runCli(["add", "channel-other", "--yes"], dir);
  expect(taken.err).toContain("channel-other's UI project goes to src/web/, which is channel-fake's");
  expect(taken.code).toBe(1);
});

test("add refuses a UI project in a reserved folder of src/ from a registry that was not validated", async () => {
  const root = registry();
  component(root, "channel-dash", "src/dashboard");
  const dir = project(root);
  const before = snapshot(dir);

  const refused = await runCli(["add", "channel-dash", "--yes"], dir);

  expect(refused.err).toContain('ui.target "src/dashboard" is reserved');
  expect(refused.code).toBe(1);
  expect(snapshot(dir)).toEqual(before);
});

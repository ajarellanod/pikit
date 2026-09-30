/**
 * `pikit upgrade`, run as a user runs it: a component is installed from a local registry with `pikit
 * add`, the registry then gets another version, and the upgrade takes it. The project has no kit
 * tarballs and `@pikit/core` linked as `bun install` would, so everything but a failing install runs
 * without the network (a dependency here is a `file:` package).
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest, hashOf, writeProjectManifest } from "../project/pikit-json.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-upgrade-test-"));
  dirs.push(dir);
  return dir;
};

function pikit(args: string[], cwd: string) {
  const run = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

/** A project `add` and `upgrade` run to the end in: no kit dependency to install, `@pikit/core` linked. */
function project(): string {
  const dir = temp();
  writeProjectManifest(dir, emptyManifest());
  writeFileSync(join(dir, "package.json"), '{ "name": "upgraded", "dependencies": {} }\n');
  writeFileSync(join(dir, ".env.example"), "# the project's own\n");
  writeFileSync(
    join(dir, "pikit.config.ts"),
    'import { defineApp } from "@pikit/core";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n  ],\n  config,\n});\n',
  );
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "..", "..", "core"), join(dir, "node_modules", "@pikit", "core"));
  return dir;
}

const INDEX = (name: string, comment = "") =>
  `import { defineComponent } from "@pikit/core";\n${comment}\nexport default defineComponent({\n  name: "${name}",\n  setup() {},\n});\n`;
/** Ten lines, never imported: a merge's material. */
const LINES = Array.from({ length: 10 }, (_, i) => `export const line${i + 1} = ${i + 1};`);
const lines = (edits: Record<number, string> = {}) => `${LINES.map((line, i) => edits[i + 1] ?? line).join("\n")}\n`;

/**
 * Writes version `version` of `name` in the registry at `root` (made when absent), replacing the one
 * there: `files` are its own directory's (`src/pikit/<name>/…`), `fields` the rest of its manifest.
 */
function publish(root: string, name: string, version: string, files: Record<string, string>, fields: Record<string, unknown> = {}): void {
  const dir = join(root, "components", name);
  rmSync(dir, { recursive: true, force: true });
  for (const [file, text] of Object.entries({ "index.ts": INDEX(name), ...files })) {
    mkdirSync(join(dir, "files", "src", "pikit", name, file, ".."), { recursive: true });
    writeFileSync(join(dir, "files", "src", "pikit", name, file), text);
  }
  const manifest = {
    name, version, description: name, targets: ["server"], requires: { pikit: "0.0.0", capabilities: [] },
    optional: { capabilities: [] }, provides: [], dependencies: {}, files: [{ source: "files/src", target: "src" }], ...fields,
  };
  writeFileSync(join(dir, "component.json"), JSON.stringify(manifest));
  const index = existsSync(join(root, "registry.json")) ? JSON.parse(readFileSync(join(root, "registry.json"), "utf8")) : { version: 1, components: {} };
  index.components[name] = { version, description: name, targets: ["server"], path: `components/${name}` };
  writeFileSync(join(root, "registry.json"), JSON.stringify(index));
}

/** A project with `tool-fake` installed from a registry at 0.1.0 with `files`; its registry's root. */
function installed(files: Record<string, string>, fields: Record<string, unknown> = {}): { dir: string; registry: string } {
  const dir = project();
  const registry = temp();
  publish(registry, "tool-fake", "0.1.0", files, fields);
  const add = pikit(["add", "tool-fake", "--registry", registry, "--yes"], dir);
  expect(add.out).toContain("tool-fake installed");
  expect(add.code).toBe(0);
  return { dir, registry };
}

const own = (file: string) => `src/pikit/tool-fake/${file}`;
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const record = (dir: string, name = "tool-fake") => JSON.parse(read(dir, "pikit.json")).components[name];
const bases = (dir: string) => (existsSync(join(dir, "pikit-bases")) ? readdirSync(join(dir, "pikit-bases")).sort() : []);
const baseOf = (text: string) => hashOf(text).slice("sha256:".length);

/** Every file under `dir` (node_modules aside) → its content: equal snapshots are byte-identical trees. */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, prefix)).sort()) {
    const relative = `${prefix}${entry}`;
    if (relative === "node_modules") continue;
    if (statSync(join(dir, relative)).isDirectory()) {
      files[`${relative}/`] = "";
      Object.assign(files, snapshot(dir, `${relative}/`));
    } else files[relative] = readFileSync(join(dir, relative), "latin1");
  }
  return files;
}

test("an unmodified file is replaced, an edit merges with a change elsewhere, and then everything is up to date", () => {
  const { dir, registry } = installed({ "lines.ts": lines(), "same.ts": "export {};\n" });
  writeFileSync(join(dir, own("lines.ts")), lines({ 2: "export const line2 = 'mine';" }));
  const next = { "index.ts": INDEX("tool-fake", "// 0.2.0"), "lines.ts": lines({ 9: "export const line9 = 'theirs';" }), "same.ts": "export {};\n" };
  publish(registry, "tool-fake", "0.2.0", next);

  const run = pikit(["upgrade", "--yes"], dir);
  expect(run.out).toContain("tool-fake 0.1.0 → 0.2.0");
  expect(run.out).toContain(`updated: ${own("index.ts")}\n`);
  expect(run.out).toContain(`merged with your edits: ${own("lines.ts")}\n`);
  expect(run.out).toContain("`pikit doctor` is green");
  expect(run.code).toBe(0);
  expect(read(dir, own("index.ts"))).toBe(next["index.ts"]);
  expect(read(dir, own("lines.ts"))).toBe(lines({ 2: "export const line2 = 'mine';", 9: "export const line9 = 'theirs';" }));

  // Recorded as 0.2.0 ships it, each with its base; the bases only 0.1.0 had are gone.
  const after = record(dir);
  expect(after.version).toBe("0.2.0");
  for (const [file, text] of Object.entries(next)) expect(after.files[own(file)].hash).toBe(hashOf(text));
  expect(bases(dir)).toEqual(Object.values(next).map(baseOf).sort());
  // The merged file is yours on top of 0.2.0: modified.
  expect(pikit(["doctor"], dir).out).toContain(`modified: ${own("lines.ts")} (tool-fake)`);

  const again = pikit(["upgrade", "--yes"], dir);
  expect(again.out).toContain("every component is up to date with its registry");
  expect(again.code).toBe(0);
}, 60_000);

test("a conflict is written with markers, ends with code 1, and is yours: a second upgrade keeps the resolution, a third merges it", () => {
  const { dir, registry } = installed({ "lines.ts": lines() });
  writeFileSync(join(dir, own("lines.ts")), lines({ 5: "export const line5 = 'mine';" }));
  publish(registry, "tool-fake", "0.2.0", { "lines.ts": lines({ 5: "export const line5 = 'theirs';" }) });

  const run = pikit(["upgrade", "tool-fake", "--yes"], dir);
  expect(run.out).toContain(`conflicts with your edits: ${own("lines.ts")}`);
  expect(run.err).toContain(`these files have conflicts between your edits and the new version:\n  ${own("lines.ts")} (tool-fake@0.2.0)`);
  expect(run.code).toBe(1);
  const conflicted = read(dir, own("lines.ts"));
  expect(conflicted).toContain("<<<<<<< yours\nexport const line5 = 'mine';\n=======\nexport const line5 = 'theirs';\n>>>>>>> tool-fake@0.2.0\n");
  // Recorded as 0.2.0 ships it, so the conflicted file is a modification of 0.2.0.
  expect(record(dir).version).toBe("0.2.0");
  expect(record(dir).files[own("lines.ts")].hash).toBe(hashOf(lines({ 5: "export const line5 = 'theirs';" })));
  expect(bases(dir)).toContain(baseOf(lines({ 5: "export const line5 = 'theirs';" })));
  expect(pikit(["doctor"], dir).out).toContain(`modified: ${own("lines.ts")} (tool-fake)`);

  // Resolved; the registry has not moved: nothing to do, the resolution stays.
  const resolved = lines({ 5: "export const line5 = 'both';" });
  writeFileSync(join(dir, own("lines.ts")), resolved);
  const again = pikit(["upgrade", "--yes"], dir);
  expect(again.out).toContain("every component is up to date");
  expect(read(dir, own("lines.ts"))).toBe(resolved);

  // The next version changes another line: merged into the resolution.
  publish(registry, "tool-fake", "0.3.0", { "lines.ts": lines({ 5: "export const line5 = 'theirs';", 10: "export const line10 = 'later';" }) });
  const third = pikit(["upgrade", "--yes"], dir);
  expect(third.out).toContain(`merged with your edits: ${own("lines.ts")}`);
  expect(third.code).toBe(0);
  expect(read(dir, own("lines.ts"))).toBe(lines({ 5: "export const line5 = 'both';", 10: "export const line10 = 'later';" }));
}, 60_000);

test("files the new version adds are added; those it drops go when unmodified and stay when modified", () => {
  const { dir, registry } = installed({ "old.ts": "export const old = 1;\n", "edited.ts": "export const edited = 1;\n" });
  writeFileSync(join(dir, own("edited.ts")), "export const edited = 'mine';\n");
  publish(registry, "tool-fake", "0.2.0", { "sub/new.ts": "export const fresh = 1;\n" });

  const run = pikit(["upgrade", "--yes"], dir);
  expect(run.out).toContain(`added: ${own("sub/new.ts")}\n`);
  expect(run.out).toContain(`deleted, no longer shipped: ${own("old.ts")}\n`);
  expect(run.out).toContain(`kept, no longer shipped but modified by you: ${own("edited.ts")}\n`);
  expect(run.code).toBe(0);
  expect(existsSync(join(dir, own("old.ts")))).toBe(false);
  expect(read(dir, own("sub/new.ts"))).toBe("export const fresh = 1;\n");
  expect(read(dir, own("edited.ts"))).toBe("export const edited = 'mine';\n");
  // The kept file stays the component's, as installed: `pikit remove` asks before deleting it.
  const files = record(dir).files;
  expect(Object.keys(files).sort()).toEqual([own("edited.ts"), own("index.ts"), own("sub/new.ts")]);
  expect(files[own("edited.ts")].hash).toBe(hashOf("export const edited = 1;\n"));
}, 60_000);

test("a new file where the project has one of its own is refused before anything is written", () => {
  const { dir, registry } = installed({});
  writeFileSync(join(dir, own("new.ts")), "// the user's own\n");
  publish(registry, "tool-fake", "0.2.0", { "new.ts": "export const fresh = 1;\n" });
  const before = snapshot(dir);
  const run = pikit(["upgrade", "--yes"], dir);
  expect(run.code).toBe(1);
  expect(run.err).toContain(`these files exist and differ from tool-fake's (pass --force to overwrite them):\n  ${own("new.ts")}`);
  expect(snapshot(dir)).toEqual(before);
}, 60_000);

test("a file the user deleted is not restored: it is named, and recorded as the new version ships it", () => {
  const { dir, registry } = installed({ "lines.ts": lines() });
  unlinkSync(join(dir, own("lines.ts")));
  publish(registry, "tool-fake", "0.2.0", { "lines.ts": lines({ 1: "export const line1 = 'theirs';" }) });
  const run = pikit(["upgrade", "--yes"], dir);
  expect(run.out).toContain(`not restored, deleted by you (\`pikit add --force\` restores it): ${own("lines.ts")}`);
  expect(run.code).toBe(0);
  expect(existsSync(join(dir, own("lines.ts")))).toBe(false);
  expect(record(dir).files[own("lines.ts")].hash).toBe(hashOf(lines({ 1: "export const line1 = 'theirs';" })));
  expect(pikit(["doctor"], dir).out).toContain(`deleted: ${own("lines.ts")} (tool-fake)`);
}, 60_000);

test("the environment block follows the new version; a dependency it adds is added, one it drops is taken out", () => {
  const pkg = temp();
  writeFileSync(join(pkg, "package.json"), '{ "name": "left-pad", "version": "1.0.0", "main": "index.js" }\n');
  writeFileSync(join(pkg, "index.js"), "module.exports = 1;\n");
  const variable = (name: string) => ({ name, description: `${name}.`, required: false, secret: false });
  const { dir, registry } = installed({}, { environment: [variable("FAKE_OLD")] });
  expect(read(dir, ".env.example")).toContain("# tool-fake\n# FAKE_OLD. (optional)\nFAKE_OLD=\n");

  publish(registry, "tool-fake", "0.2.0", {}, { environment: [variable("FAKE_NEW")], dependencies: { "left-pad": `file:${pkg}` } });
  const run = pikit(["upgrade", "--yes"], dir);
  expect(run.out).toContain("new environment variables: FAKE_NEW");
  expect(run.out).toContain("environment variables it no longer reads: FAKE_OLD");
  expect(run.out).toContain(`npm, new: left-pad@file:${pkg}`);
  expect(run.out).toContain("files: no change");
  expect(run.code).toBe(0);
  expect(read(dir, ".env.example")).toBe("# the project's own\n\n# tool-fake\n# FAKE_NEW. (optional)\nFAKE_NEW=\n");
  expect(JSON.parse(read(dir, "package.json")).dependencies).toEqual({ "left-pad": `file:${pkg}` });
  expect(record(dir).addedDependencies).toEqual(["left-pad"]);
  expect(existsSync(join(dir, "node_modules", "left-pad"))).toBe(true);

  publish(registry, "tool-fake", "0.3.0", {}, { environment: [variable("FAKE_NEW")] });
  const dropped = pikit(["upgrade", "--yes"], dir);
  expect(dropped.out).toContain("npm, taken out unless something else needs it: left-pad");
  expect(dropped.code).toBe(0);
  expect(JSON.parse(read(dir, "package.json")).dependencies).toEqual({});
  expect(record(dir).addedDependencies).toEqual([]);
}, 60_000);

test("a version this CLI's contracts do not satisfy is refused before any write; --force upgrades to it", () => {
  const { dir, registry } = installed({});
  publish(registry, "tool-fake", "0.2.0", { "index.ts": INDEX("tool-fake", "// 0.2.0") }, { requires: { pikit: "0.0.0", contracts: "^9.0.0", capabilities: [] } });
  const before = snapshot(dir);
  const refused = pikit(["upgrade", "--yes"], dir);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("tool-fake requires @pikit/contracts ^9.0.0; this CLI vendors 0.0.0");
  expect(snapshot(dir)).toEqual(before);

  const forced = pikit(["upgrade", "--yes", "--force"], dir);
  expect(forced.err).toContain("tool-fake requires @pikit/contracts ^9.0.0; this CLI vendors 0.0.0; --force: going ahead");
  expect(forced.code).toBe(0);
  expect(record(dir).requires).toEqual({ pikit: "0.0.0", contracts: "^9.0.0" });
  expect(read(dir, own("index.ts"))).toBe(INDEX("tool-fake", "// 0.2.0"));
}, 60_000);

test("an upgrade whose install fails puts everything back: files, merges, bases, pikit.json, package.json", () => {
  const { dir, registry } = installed({ "lines.ts": lines(), "old.ts": "export const old = 1;\n" });
  writeFileSync(join(dir, own("lines.ts")), lines({ 2: "export const line2 = 'mine';" }));
  // Nothing resolves: `bun install` fails at once, after every file is written.
  writeFileSync(join(dir, "bunfig.toml"), '[install]\nregistry = "http://127.0.0.1:9/"\n');
  publish(registry, "tool-fake", "0.2.0", { "index.ts": INDEX("tool-fake", "// 0.2.0"), "lines.ts": lines({ 9: "x" }), "new.ts": "" }, { dependencies: { "left-pad": "1.3.0" } });
  const before = snapshot(dir);
  const run = pikit(["upgrade", "--yes"], dir);
  expect(run.err).toContain("`bun install` failed");
  expect(run.err).toContain("nothing was upgraded");
  expect(run.code).toBe(1);
  expect(snapshot(dir)).toEqual(before);
}, 120_000);

test("--dry-run says what it would do and writes nothing", () => {
  const { dir, registry } = installed({ "lines.ts": lines() });
  writeFileSync(join(dir, own("lines.ts")), lines({ 5: "export const line5 = 'mine';" }));
  publish(registry, "tool-fake", "0.2.0", { "index.ts": INDEX("tool-fake", "// 0.2.0"), "lines.ts": lines({ 5: "export const line5 = 'theirs';" }) });
  const before = snapshot(dir);
  const run = pikit(["upgrade", "--dry-run"], dir);
  expect(run.out).toContain("tool-fake 0.1.0 → 0.2.0");
  expect(run.out).toContain(`updated: ${own("index.ts")}`);
  expect(run.out).toContain(`conflicts with your edits: ${own("lines.ts")}`);
  expect(run.out).toContain("--dry-run: nothing was written");
  expect(run.code).toBe(0);
  expect(snapshot(dir)).toEqual(before);
  // Without --yes nor a terminal, the real one asks, and writes nothing.
  const asked = pikit(["upgrade"], dir);
  expect(asked.code).toBe(1);
  expect(asked.err).toContain("pass --yes");
  expect(snapshot(dir)).toEqual(before);
}, 60_000);

test("named components are the only ones upgraded; an unknown name is refused", () => {
  const { dir, registry } = installed({});
  publish(registry, "tool-other", "0.1.0", {});
  expect(pikit(["add", "tool-other", "--registry", registry, "--yes"], dir).code).toBe(0);
  publish(registry, "tool-fake", "0.2.0", { "index.ts": INDEX("tool-fake", "// 0.2.0") });
  publish(registry, "tool-other", "0.2.0", { "index.ts": INDEX("tool-other", "// 0.2.0") });

  const unknown = pikit(["upgrade", "tool-nope", "--yes"], dir);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("not installed: tool-nope");

  const run = pikit(["upgrade", "tool-other", "--yes"], dir);
  expect(run.out).toContain("tool-other 0.1.0 → 0.2.0");
  expect(run.out).not.toContain("tool-fake 0.1.0");
  expect(run.code).toBe(0);
  expect(record(dir, "tool-other").version).toBe("0.2.0");
  expect(record(dir, "tool-fake").version).toBe("0.1.0");
  expect(read(dir, own("index.ts"))).toBe(INDEX("tool-fake"));
}, 60_000);

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
import { runCli } from "../testing/cli.ts";
import { OPERATION_MARKER } from "../project/operation.ts";
import { KIT_PACKAGES } from "../project/vendor.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-upgrade-test-"));
  dirs.push(dir);
  return dir;
};

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
async function installed(files: Record<string, string>, fields: Record<string, unknown> = {}): Promise<{ dir: string; registry: string }> {
  const dir = project();
  const registry = temp();
  publish(registry, "tool-fake", "0.1.0", files, fields);
  const add = await runCli(["add", "tool-fake", "--registry", registry, "--yes"], dir);
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

test("an unmodified file is replaced, an edit merges with a change elsewhere, and then everything is up to date", async () => {
  const { dir, registry } = await installed({ "lines.ts": lines(), "same.ts": "export {};\n" });
  writeFileSync(join(dir, own("lines.ts")), lines({ 2: "export const line2 = 'mine';" }));
  const next = { "index.ts": INDEX("tool-fake", "// 0.2.0"), "lines.ts": lines({ 9: "export const line9 = 'theirs';" }), "same.ts": "export {};\n" };
  publish(registry, "tool-fake", "0.2.0", next);

  const run = await runCli(["upgrade", "--yes"], dir);
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
  expect((await runCli(["doctor"], dir)).out).toContain(`modified: ${own("lines.ts")} (tool-fake)`);

  const again = await runCli(["upgrade", "--yes"], dir);
  expect(again.out).toContain("every component is up to date with its registry");
  expect(again.code).toBe(0);
}, 60_000);

test("a conflict is written with markers, ends with code 1, and is yours: a second upgrade keeps the resolution, a third merges it", async () => {
  const { dir, registry } = await installed({ "lines.ts": lines() });
  writeFileSync(join(dir, own("lines.ts")), lines({ 5: "export const line5 = 'mine';" }));
  publish(registry, "tool-fake", "0.2.0", { "lines.ts": lines({ 5: "export const line5 = 'theirs';" }) });

  const run = await runCli(["upgrade", "tool-fake", "--yes"], dir);
  expect(run.out).toContain(`conflicts with your edits: ${own("lines.ts")}`);
  expect(run.err).toContain(`these files have conflicts between your edits and the new version:\n  ${own("lines.ts")} (tool-fake@0.2.0)`);
  expect(run.code).toBe(1);
  const conflicted = read(dir, own("lines.ts"));
  expect(conflicted).toContain("<<<<<<< yours\nexport const line5 = 'mine';\n=======\nexport const line5 = 'theirs';\n>>>>>>> tool-fake@0.2.0\n");
  // Recorded as 0.2.0 ships it, so the conflicted file is a modification of 0.2.0.
  expect(record(dir).version).toBe("0.2.0");
  expect(record(dir).files[own("lines.ts")].hash).toBe(hashOf(lines({ 5: "export const line5 = 'theirs';" })));
  expect(bases(dir)).toContain(baseOf(lines({ 5: "export const line5 = 'theirs';" })));
  expect((await runCli(["doctor"], dir)).out).toContain(`modified: ${own("lines.ts")} (tool-fake)`);

  // Resolved; the registry has not moved: nothing to do, the resolution stays.
  const resolved = lines({ 5: "export const line5 = 'both';" });
  writeFileSync(join(dir, own("lines.ts")), resolved);
  const again = await runCli(["upgrade", "--yes"], dir);
  expect(again.out).toContain("every component is up to date");
  expect(read(dir, own("lines.ts"))).toBe(resolved);

  // The next version changes another line: merged into the resolution.
  publish(registry, "tool-fake", "0.3.0", { "lines.ts": lines({ 5: "export const line5 = 'theirs';", 10: "export const line10 = 'later';" }) });
  const third = await runCli(["upgrade", "--yes"], dir);
  expect(third.out).toContain(`merged with your edits: ${own("lines.ts")}`);
  expect(third.code).toBe(0);
  expect(read(dir, own("lines.ts"))).toBe(lines({ 5: "export const line5 = 'both';", 10: "export const line10 = 'later';" }));
}, 60_000);

test("files the new version adds are added; those it drops go when unmodified and stay when modified", async () => {
  const { dir, registry } = await installed({ "old.ts": "export const old = 1;\n", "edited.ts": "export const edited = 1;\n" });
  writeFileSync(join(dir, own("edited.ts")), "export const edited = 'mine';\n");
  publish(registry, "tool-fake", "0.2.0", { "sub/new.ts": "export const fresh = 1;\n" });

  const run = await runCli(["upgrade", "--yes"], dir);
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

test("a new file where the project has one of its own is refused before anything is written", async () => {
  const { dir, registry } = await installed({});
  writeFileSync(join(dir, own("new.ts")), "// the user's own\n");
  publish(registry, "tool-fake", "0.2.0", { "new.ts": "export const fresh = 1;\n" });
  const before = snapshot(dir);
  const run = await runCli(["upgrade", "--yes"], dir);
  expect(run.code).toBe(1);
  expect(run.err).toContain(`these files exist and differ from tool-fake's (pass --force to overwrite them):\n  ${own("new.ts")}`);
  expect(snapshot(dir)).toEqual(before);
}, 60_000);

test("a file the user deleted is not restored: it is named, and recorded as the new version ships it", async () => {
  const { dir, registry } = await installed({ "lines.ts": lines() });
  unlinkSync(join(dir, own("lines.ts")));
  publish(registry, "tool-fake", "0.2.0", { "lines.ts": lines({ 1: "export const line1 = 'theirs';" }) });
  const run = await runCli(["upgrade", "--yes"], dir);
  expect(run.out).toContain(`not restored, deleted by you (\`pikit add --force\` restores it): ${own("lines.ts")}`);
  expect(run.code).toBe(0);
  expect(existsSync(join(dir, own("lines.ts")))).toBe(false);
  expect(record(dir).files[own("lines.ts")].hash).toBe(hashOf(lines({ 1: "export const line1 = 'theirs';" })));
  expect((await runCli(["doctor"], dir)).out).toContain(`deleted: ${own("lines.ts")} (tool-fake)`);
}, 60_000);

test("the environment block follows the new version; a dependency it adds is added, one it drops is taken out", async () => {
  const pkg = temp();
  writeFileSync(join(pkg, "package.json"), '{ "name": "left-pad", "version": "1.0.0", "main": "index.js" }\n');
  writeFileSync(join(pkg, "index.js"), "module.exports = 1;\n");
  const variable = (name: string) => ({ name, description: `${name}.`, required: false, secret: false });
  const { dir, registry } = await installed({}, { environment: [variable("FAKE_OLD")] });
  expect(read(dir, ".env.example")).toContain("# tool-fake\n# FAKE_OLD. (optional)\nFAKE_OLD=\n");

  publish(registry, "tool-fake", "0.2.0", {}, { environment: [variable("FAKE_NEW")], dependencies: { "left-pad": `file:${pkg}` } });
  const run = await runCli(["upgrade", "--yes"], dir);
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
  const dropped = await runCli(["upgrade", "--yes"], dir);
  expect(dropped.out).toContain("npm, taken out unless something else needs it: left-pad");
  expect(dropped.code).toBe(0);
  expect(JSON.parse(read(dir, "package.json")).dependencies).toEqual({});
  expect(record(dir).addedDependencies).toEqual([]);
}, 60_000);

test("a version this CLI's contracts do not satisfy is refused before any write; --force upgrades to it", async () => {
  const { dir, registry } = await installed({});
  publish(registry, "tool-fake", "0.2.0", { "index.ts": INDEX("tool-fake", "// 0.2.0") }, { requires: { pikit: "0.0.0", contracts: "^9.0.0", capabilities: [] } });
  const before = snapshot(dir);
  const refused = await runCli(["upgrade", "--yes"], dir);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("tool-fake requires @pikit/contracts ^9.0.0; this CLI vendors 0.0.0");
  expect(snapshot(dir)).toEqual(before);

  const forced = await runCli(["upgrade", "--yes", "--force"], dir);
  expect(forced.err).toContain("tool-fake requires @pikit/contracts ^9.0.0; this CLI vendors 0.0.0; --force: going ahead");
  expect(forced.code).toBe(0);
  expect(record(dir).requires).toEqual({ pikit: "0.0.0", contracts: "^9.0.0" });
  expect(read(dir, own("index.ts"))).toBe(INDEX("tool-fake", "// 0.2.0"));
}, 60_000);

test("an adapter range this CLI's does not satisfy needs --force; a missing range is refused even with it", async () => {
  const { dir, registry } = await installed({});
  publish(registry, "tool-fake", "0.2.0", {}, { dependencies: { "@pikit/pi-adapter": "0.0.0" } });
  const before = snapshot(dir);
  const missing = await runCli(["upgrade", "--yes", "--force"], dir);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("tool-fake's component.json: dependencies lists @pikit/pi-adapter, but requires.adapter does not say which versions it works with");
  expect(snapshot(dir)).toEqual(before);

  publish(registry, "tool-fake", "0.2.0", {}, { requires: { pikit: "0.0.0", adapter: "^9.0.0", capabilities: [] } });
  const refused = await runCli(["upgrade", "--yes"], dir);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("tool-fake requires @pikit/pi-adapter ^9.0.0; this CLI vendors 0.0.0");
  expect(snapshot(dir)).toEqual(before);
  const forced = await runCli(["upgrade", "--yes", "--force"], dir);
  expect(forced.err).toContain("tool-fake requires @pikit/pi-adapter ^9.0.0; this CLI vendors 0.0.0; --force: going ahead");
  expect(forced.code).toBe(0);
  expect(record(dir).requires).toEqual({ pikit: "0.0.0", adapter: "^9.0.0" });
}, 60_000);

test("providers are offered by what the project will compose: an up-to-date provider counts, one whose new version drops the capability does not", async () => {
  /** A component whose setup runs `body` (with `pikit`). */
  const code = (name: string, body = "") => ({
    "index.ts": `import { defineComponent } from "@pikit/core";\n\nexport default defineComponent({\n  name: "${name}",\n  setup(pikit) {\n    ${body}\n  },\n});\n`,
  });
  const { dir, registry } = await installed({});
  publish(registry, "outbound-fake", "0.1.0", code("outbound-fake", 'pikit.provide("outbound.queue", {});'), { provides: ["outbound.queue"] });
  publish(registry, "outbound-other", "0.1.0", code("outbound-other", 'pikit.provide("outbound.queue", {});'), { provides: ["outbound.queue"] });
  expect((await runCli(["add", "outbound-fake", "--registry", registry, "--yes"], dir)).code).toBe(0);

  // tool-fake can now use the queue, which the installed outbound-fake provides: nothing to offer.
  publish(registry, "tool-fake", "0.2.0", code("tool-fake", 'pikit.useOptional("outbound.queue");'), { optional: { capabilities: ["outbound.queue"] } });
  const kept = await runCli(["upgrade", "--dry-run"], dir);
  expect(kept.out).toContain("tool-fake 0.1.0 \u2192 0.2.0");
  expect(kept.out).not.toContain("outbound-fake 0.1.0 \u2192");
  expect(kept.out).not.toContain("would offer");
  expect(kept.code).toBe(0);

  // Its next version no longer provides it: what it provides installed does not count, the other provider is offered.
  publish(registry, "outbound-fake", "0.2.0", code("outbound-fake"));
  const dropped = await runCli(["upgrade", "--dry-run"], dir);
  expect(dropped.out).toContain("would offer outbound-other, for tool-fake (outbound.queue)");
  expect(dropped.code).toBe(0);
}, 60_000);

test("an upgrade whose install fails puts everything back: files, merges, bases, pikit.json, package.json", async () => {
  const { dir, registry } = await installed({ "lines.ts": lines(), "old.ts": "export const old = 1;\n" });
  writeFileSync(join(dir, own("lines.ts")), lines({ 2: "export const line2 = 'mine';" }));
  // Nothing resolves: `bun install` fails at once, after every file is written.
  writeFileSync(join(dir, "bunfig.toml"), '[install]\nregistry = "http://127.0.0.1:9/"\n');
  publish(registry, "tool-fake", "0.2.0", { "index.ts": INDEX("tool-fake", "// 0.2.0"), "lines.ts": lines({ 9: "x" }), "new.ts": "" }, { dependencies: { "left-pad": "1.3.0" } });
  const before = snapshot(dir);
  const run = await runCli(["upgrade", "--yes"], dir);
  expect(run.err).toContain("`bun install` failed");
  expect(run.err).toContain("nothing was upgraded");
  expect(run.code).toBe(1);
  const after = snapshot(dir);
  expect(after[OPERATION_MARKER]).toBeDefined();
  delete after[OPERATION_MARKER];
  expect(after).toEqual(before);
}, 120_000);

test("--dry-run says what it would do and writes nothing", async () => {
  const { dir, registry } = await installed({ "lines.ts": lines() });
  writeFileSync(join(dir, own("lines.ts")), lines({ 5: "export const line5 = 'mine';" }));
  publish(registry, "tool-fake", "0.2.0", { "index.ts": INDEX("tool-fake", "// 0.2.0"), "lines.ts": lines({ 5: "export const line5 = 'theirs';" }) });
  const before = snapshot(dir);
  const run = await runCli(["upgrade", "--dry-run"], dir);
  expect(run.out).toContain("tool-fake 0.1.0 → 0.2.0");
  expect(run.out).toContain(`updated: ${own("index.ts")}`);
  expect(run.out).toContain(`conflicts with your edits: ${own("lines.ts")}`);
  expect(run.out).toContain("--dry-run: nothing was written");
  expect(run.code).toBe(0);
  expect(snapshot(dir)).toEqual(before);
  // Without --yes nor a terminal, the real one asks, and writes nothing.
  const asked = await runCli(["upgrade"], dir);
  expect(asked.code).toBe(1);
  expect(asked.err).toContain("pass --yes");
  expect(snapshot(dir)).toEqual(before);
}, 60_000);

test("named components are the only ones upgraded; an unknown name is refused", async () => {
  const { dir, registry } = await installed({});
  publish(registry, "tool-other", "0.1.0", {});
  expect((await runCli(["add", "tool-other", "--registry", registry, "--yes"], dir)).code).toBe(0);
  publish(registry, "tool-fake", "0.2.0", { "index.ts": INDEX("tool-fake", "// 0.2.0") });
  publish(registry, "tool-other", "0.2.0", { "index.ts": INDEX("tool-other", "// 0.2.0") });

  const unknown = await runCli(["upgrade", "tool-nope", "--yes"], dir);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("not installed: tool-nope");

  const run = await runCli(["upgrade", "tool-other", "--yes"], dir);
  expect(run.out).toContain("tool-other 0.1.0 → 0.2.0");
  expect(run.out).not.toContain("tool-fake 0.1.0");
  expect(run.code).toBe(0);
  expect(record(dir, "tool-other").version).toBe("0.2.0");
  expect(record(dir, "tool-fake").version).toBe("0.1.0");
  expect(read(dir, own("index.ts"))).toBe(INDEX("tool-fake"));
}, 60_000);

/** A project whose vendored kit is another checkout's (`vendor/`, package.json's overrides), with nothing installed. */
function otherKitProject(): string {
  const dir = temp();
  writeProjectManifest(dir, emptyManifest());
  mkdirSync(join(dir, "vendor"));
  const overrides: Record<string, string> = {};
  for (const [name, packageDir] of Object.entries(KIT_PACKAGES)) {
    overrides[name] = `file:vendor/pikit-${packageDir}-0.0.0-0000000000.tgz`;
    writeFileSync(join(dir, "vendor", `pikit-${packageDir}-0.0.0-0000000000.tgz`), "another kit");
  }
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "other-kit", dependencies: { "@pikit/core": overrides["@pikit/core"] }, overrides }, null, 2)}\n`);
  writeFileSync(join(dir, "bun.lock"), "the lockfile of the other kit\n");
  writeFileSync(join(dir, "pikit.config.ts"), 'import { defineApp } from "@pikit/core";\n\nexport default defineApp({\n  components: [\n  ],\n  config: {},\n});\n');
  return dir;
}

test("a kit that is not this CLI's is a plan of its own: doctor notes it, --dry-run and the confirmation show it, and nothing is written", async () => {
  const dir = otherKitProject();
  const before = snapshot(dir);
  const doctor = await runCli(["doctor"], dir);
  expect(doctor.out).toContain("the project's kit (vendor/) is another, not this CLI's");
  expect(doctor.out).toContain("`pikit upgrade` refreshes it");

  const dry = await runCli(["upgrade", "--dry-run"], dir);
  expect(dry.out).toContain("the kit (vendor/): an unrecorded kit → this CLI's");
  expect(dry.out).toContain("refreshed: @pikit/core, @pikit/contracts, @pikit/pi-adapter");
  expect(dry.out).toContain("Pi (@earendil-works/pi-durable): not installed → ");
  expect(dry.out).toContain("--dry-run: nothing was written");
  expect(dry.out).not.toContain("every component is up to date");
  expect(dry.code).toBe(0);
  expect(snapshot(dir)).toEqual(before);

  const asked = await runCli(["upgrade"], dir);
  expect(asked.code).toBe(1);
  expect(asked.err).toContain("pass --yes");
  expect(snapshot(dir)).toEqual(before);
  // A name that is not installed is refused before the kit is touched.
  const named = await runCli(["upgrade", "nothing-installed", "--yes"], dir);
  expect(named.code).toBe(1);
  expect(snapshot(dir)).toEqual(before);
}, 60_000);

test("a kit refresh that fails mid-way leaves the project as it was: package.json, vendor/, bun.lock, pikit.json", async () => {
  const dir = otherKitProject();
  // Nothing resolves: `bun install` fails at once, after the new tarballs and package.json are written.
  writeFileSync(join(dir, "bunfig.toml"), '[install]\nregistry = "http://127.0.0.1:9/"\n');
  const before = snapshot(dir);
  const run = await runCli(["upgrade", "--yes"], dir);
  expect(run.out).toContain("refreshed to this CLI's, in vendor/");
  expect(run.err).toContain("`bun install` failed");
  expect(run.err).toContain("nothing was upgraded");
  expect(run.code).toBe(1);
  const after = snapshot(dir);
  expect(after[OPERATION_MARKER]).toBeDefined();
  delete after[OPERATION_MARKER];
  expect(after).toEqual(before);
}, 120_000);

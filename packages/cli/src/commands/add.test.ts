/**
 * `pikit add`, run as a user runs it, on what it must refuse or undo: a refusal leaves the project
 * byte for byte as it was, and a step that fails once writing began puts back what was written. The
 * projects are "made by another kit revision": their vendored tarballs are not this checkout's, so
 * an add that went ahead would rewrite `package.json` and `vendor/` (SPEC §10.5, "Vendored kit").
 * No network: the one `bun install` here is made to fail at once.
 *
 * A registry may be anyone's (`--registry`): the plan names every file written outside the
 * component's own directory, and the project's own records are never a component's to write.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PIKIT_ROOT } from "../paths.ts";
import { emptyManifest, hashOf, writeProjectManifest } from "../project/pikit-json.ts";
import { EXTENSION_ALIAS, KIT_PACKAGES } from "../project/vendor.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-add-test-"));
  dirs.push(dir);
  return dir;
};

function pikit(args: string[], cwd: string, env?: Record<string, string>) {
  const run = Bun.spawnSync([process.execPath, MAIN, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(env !== undefined && { env: { ...process.env, ...env } }),
  });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

/** `pikit add` in a pseudo-terminal, answering its first question with Enter once it shows. */
async function pikitAnsweringEnter(args: string[], cwd: string, question: string) {
  let output = "";
  const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd,
    terminal: { cols: 200, rows: 50, data: (_terminal, data) => void (output += decoder.decode(data)) },
  });
  const text = () => output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
  const deadline = Date.now() + 30_000;
  while (!text().includes(question)) {
    if (proc.exitCode !== null || Date.now() > deadline) throw new Error(`never asked ${JSON.stringify(question)}; printed:\n${text()}`);
    await Bun.sleep(20);
  }
  proc.terminal?.write("\r");
  const code = await proc.exited;
  return { code, text: text() };
}

/** A project whose kit tarballs are another checkout's, with a lockfile naming them; `kit` is that checkout's commit. */
function otherKitProject(installed: string[] = [], kit?: string): string {
  const dir = temp();
  const manifest = emptyManifest(undefined, kit);
  for (const name of installed) manifest.components[name] = { registry: "default", version: "0.0.0", files: {}, dependencies: {}, environment: [] };
  writeProjectManifest(dir, manifest);
  mkdirSync(join(dir, "vendor"));
  const overrides: Record<string, string> = {};
  for (const [name, packageDir] of Object.entries(KIT_PACKAGES)) {
    overrides[name] = `file:vendor/pikit-${packageDir}-0.0.0-0000000000.tgz`;
    writeFileSync(join(dir, "vendor", `pikit-${packageDir}-0.0.0-0000000000.tgz`), "another kit");
  }
  const dependencies = { [EXTENSION_ALIAS]: overrides["@pikit/pi-extension-shim"], "@pikit/core": overrides["@pikit/core"] };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "other-kit", dependencies, overrides }, null, 2)}\n`);
  writeFileSync(join(dir, "bun.lock"), "the lockfile of the other kit\n");
  writeFileSync(join(dir, ".env.example"), "# the project's own\n");
  writeFileSync(
    join(dir, "pikit.config.ts"),
    'import { defineApp } from "@pikit/core";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n  ],\n  config,\n});\n',
  );
  return dir;
}

/**
 * A registry with one component, `tool-fake`: its own `src/pikit/tool-fake/index.ts`, plus `extra`
 * (component-relative source → project target; a source under `files/src/` rides on the src mapping).
 */
function fakeRegistry(extra: Record<string, string>): string {
  const root = temp();
  const dir = join(root, "components", "tool-fake");
  const put = (file: string, text: string) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  put("files/src/pikit/tool-fake/index.ts", "export default {};\n");
  const files = [{ source: "files/src", target: "src" }];
  for (const [source, target] of Object.entries(extra)) {
    put(source, "written by tool-fake\n");
    if (!source.startsWith("files/src/")) files.push({ source, target });
  }
  const manifest = {
    name: "tool-fake", version: "0.0.0", description: "tool-fake", targets: ["server"], requires: { pikit: "0.0.0", capabilities: [] },
    optional: { capabilities: [] }, provides: [], dependencies: {}, files,
  };
  writeFileSync(join(dir, "component.json"), JSON.stringify(manifest));
  const index = { "tool-fake": { version: "0.0.0", description: "tool-fake", targets: ["server"], path: "components/tool-fake" } };
  writeFileSync(join(root, "registry.json"), JSON.stringify({ version: 1, components: index }));
  return root;
}

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

test("adding an installed component on another kit's project changes nothing: package.json, vendor/, bun.lock", () => {
  const dir = otherKitProject(["tool-bash"]);
  const before = snapshot(dir);
  const run = pikit(["add", "tool-bash", "--yes"], dir);
  expect(run.code).toBe(1);
  expect(run.err).toContain("tool-bash is already installed");
  expect(snapshot(dir)).toEqual(before);
}, 60_000);

test("a file conflict refuses before anything is written", () => {
  const dir = otherKitProject();
  mkdirSync(join(dir, "src", "pikit", "log-events"), { recursive: true });
  writeFileSync(join(dir, "src", "pikit", "log-events", "index.ts"), "// the user's own\n");
  const before = snapshot(dir);
  const run = pikit(["add", "log-events", "--yes"], dir);
  expect(run.code).toBe(1);
  expect(run.err).toContain("these files exist and differ from log-events's");
  expect(snapshot(dir)).toEqual(before);
}, 60_000);

test("a config file the CLI cannot edit refuses before a file is copied", () => {
  const dir = otherKitProject();
  writeFileSync(join(dir, "pikit.config.ts"), 'import { defineApp } from "@pikit/core";\n\nexport default defineApp({ components: [], config: {} });\n');
  const before = snapshot(dir);
  const run = pikit(["add", "log-events", "--yes"], dir);
  expect(run.code).toBe(1);
  expect(run.err).toContain("pikit.config.ts: the `components` list must have one entry per line");
  expect(snapshot(dir)).toEqual(before);
}, 60_000);

test("a declined confirmation changes nothing", async () => {
  const dir = otherKitProject();
  const before = snapshot(dir);
  const run = await pikitAnsweringEnter(["add", "log-events"], dir, "Install log-events?");
  expect(run.code).toBe(1);
  expect(run.text).toContain("cancelled");
  expect(snapshot(dir)).toEqual(before);
}, 60_000);

test("an add that fails once writing began puts back what it wrote: files, tarballs, package.json", () => {
  const dir = otherKitProject();
  // Nothing resolves: `bun install` fails at once, after the kit refresh and the copy.
  writeFileSync(join(dir, "bunfig.toml"), '[install]\nregistry = "http://127.0.0.1:9/"\n');
  const before = snapshot(dir);
  const run = pikit(["add", "log-events", "--yes"], dir);
  expect(run.code).toBe(1);
  expect(run.err).toContain("`bun install` failed");
  expect(run.err).toContain("nothing was added");
  expect(run.out).toContain("refreshed to this CLI's");
  expect(snapshot(dir)).toEqual(before);
  expect(existsSync(join(dir, "pikit-bases"))).toBe(false);
}, 120_000);

test("a reinstall that fails puts back the bases it replaced, and removes those it wrote", () => {
  const dir = otherKitProject();
  // log-events, installed by an older registry: one file, with its base.
  const file = "src/pikit/log-events/index.ts";
  const hash = hashOf("the older log-events\n");
  const manifest = JSON.parse(readFileSync(join(dir, "pikit.json"), "utf8"));
  manifest.components["log-events"] = { registry: "default", version: "0.0.0", files: { [file]: { hash } }, dependencies: {}, environment: [] };
  writeFileSync(join(dir, "pikit.json"), JSON.stringify(manifest));
  mkdirSync(join(dir, "src", "pikit", "log-events"), { recursive: true });
  writeFileSync(join(dir, file), "the older log-events\n");
  mkdirSync(join(dir, "pikit-bases"));
  writeFileSync(join(dir, "pikit-bases", hash.slice("sha256:".length)), "the older log-events\n");
  writeFileSync(join(dir, "bunfig.toml"), '[install]\nregistry = "http://127.0.0.1:9/"\n');
  const before = snapshot(dir);
  const run = pikit(["add", "log-events", "--yes", "--force"], dir);
  expect(run.code).toBe(1);
  expect(run.err).toContain("nothing was added");
  expect(snapshot(dir)).toEqual(before);
}, 120_000);

test("the plan says when the registry has uncommitted changes", () => {
  const dir = otherKitProject();
  const registry = fakeRegistry({});
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", registry, "-c", "user.email=t@pikit.test", "-c", "user.name=t", ...args], { stdout: "pipe", stderr: "pipe" });
  expect(git("init", "-q").exitCode).toBe(0);
  git("add", "-A");
  expect(git("commit", "-qm", "registry").exitCode).toBe(0);
  const clean = pikit(["add", "tool-fake", "--registry", registry], dir);
  expect(clean.out).toMatch(/tool-fake 0\.0\.0 from .* at [0-9a-f]{40}\n/);
  expect(clean.err).not.toContain("uncommitted changes");

  writeFileSync(join(registry, "components", "tool-fake", "files", "src", "pikit", "tool-fake", "index.ts"), "export default { edited: true };\n");
  const dirty = pikit(["add", "tool-fake", "--registry", registry], dir);
  expect(dirty.out).toMatch(/at [0-9a-f]{40}-dirty\n/);
  expect(dirty.err).toContain("the registry has uncommitted changes: its commit does not name these files");
  expect(dirty.err).toContain("pass --yes");
}, 60_000);

test("the plan and the confirmation name each file written outside the component's directory", async () => {
  const dir = otherKitProject();
  const registry = fakeRegistry({ "files/src/other/x.ts": "src/other/x.ts" });
  const before = snapshot(dir);
  const plan = pikit(["add", "tool-fake", "--registry", registry], dir);
  expect(plan.code).toBe(1);
  expect(plan.out).toContain("files: 1 in src/pikit/tool-fake/");
  expect(plan.out).toContain("files outside src/pikit/tool-fake/: 1\n    ! src/other/x.ts\n");
  expect(plan.err).toContain("pass --yes");

  const asked = await pikitAnsweringEnter(["add", "tool-fake", "--registry", registry], dir, "It also writes, outside src/pikit/tool-fake/: src/other/x.ts");
  expect(asked.code).toBe(1);
  expect(snapshot(dir)).toEqual(before);

  // The repository's own: deployment-docker's root files are shown by name.
  expect(pikit(["add", "deployment-docker"], dir).out).toContain("files outside src/pikit/deployment-docker/: 3\n    ! .dockerignore\n    ! Dockerfile\n    ! compose.yaml\n");
}, 60_000);

test("a component that would write the project's own records is refused, --force or not, and nothing changes", () => {
  const dir = otherKitProject();
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "config"), "[core]\n");
  const before = snapshot(dir);
  for (const target of ["package.json", ".git/config", "vendor/pikit-core-0.0.0-0000000000.tgz", "Pikit.json"]) {
    const run = pikit(["add", "tool-fake", "--yes", "--force", "--registry", fakeRegistry({ "files/payload": target })], dir);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`tool-fake: the file target "${target}" is the project's own`);
    expect(snapshot(dir)).toEqual(before);
  }
}, 60_000);

/** This CLI's checkout, when it is a Git repository: the kit's commits are its commits. */
const cliGit = (...args: string[]) => Bun.spawnSync(["git", "-C", PIKIT_ROOT, ...args], { stdout: "pipe", stderr: "pipe" });
const CLI_IN_GIT = cliGit("rev-parse", "HEAD").exitCode === 0;

test.skipIf(!CLI_IN_GIT)("a project whose kit is newer than this CLI's is refused before any write; --force replaces it", () => {
  // A commit after this checkout's HEAD, as a newer pikit would have. It is written to a temporary
  // object store, never to the checkout's own .git: only the CLI runs below see it, as an alternate.
  const objects = temp();
  const realObjects = cliGit("rev-parse", "--path-format=absolute", "--git-path", "objects").stdout.toString().trim();
  const newer = Bun.spawnSync(
    ["git", "-C", PIKIT_ROOT, "-c", "user.email=t@pikit.test", "-c", "user.name=t", "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "a newer kit"],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: realObjects } },
  ).stdout.toString().trim();
  expect(newer).toMatch(/^[0-9a-f]{40}$/);
  expect(cliGit("cat-file", "-e", newer).exitCode).not.toBe(0);
  const seesNewer = { GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
  const dir = otherKitProject([], newer);
  writeFileSync(join(dir, "bunfig.toml"), '[install]\nregistry = "http://127.0.0.1:9/"\n');
  const before = snapshot(dir);

  const refused = pikit(["add", "log-events", "--yes"], dir, seesNewer);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain(`this project's kit (vendor/) comes from pikit ${newer}, which this CLI's checkout`);
  expect(refused.err).toContain("pass --force to replace the kit anyway");
  expect(refused.out).not.toContain("log-events 0.0.0 from");
  expect(snapshot(dir)).toEqual(before);

  // Forced, it goes on to the kit refresh (the install then fails here, and everything is put back).
  const forced = pikit(["add", "log-events", "--yes", "--force"], dir, seesNewer);
  expect(forced.err).toContain("--force: replacing it with this older kit");
  expect(forced.out).toContain("refreshed to this CLI's");
  expect(forced.err).toContain("nothing was added");
  expect(snapshot(dir)).toEqual(before);
}, 120_000);

test.skipIf(!CLI_IN_GIT)("an older kit is replaced without a word; an unrecorded one with a warning", () => {
  const head = cliGit("rev-parse", "HEAD").stdout.toString().trim();
  const older = pikit(["add", "log-events"], otherKitProject([], head));
  expect(older.err).toContain("pass --yes");
  expect(older.err).not.toContain("project's kit");

  const unrecorded = pikit(["add", "log-events"], otherKitProject());
  expect(unrecorded.err).toContain("the project's kit is replaced with this CLI's");
  expect(unrecorded.err).toContain("pikit.json does not record the project's kit");
}, 60_000);

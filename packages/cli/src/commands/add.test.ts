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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";
import { emptyManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { EXTENSION_ALIAS, KIT_PACKAGES } from "../project/vendor.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-add-test-"));
  dirs.push(dir);
  return dir;
};

function pikit(args: string[], cwd: string) {
  const run = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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

/** A project whose kit tarballs are another checkout's, with a lockfile naming them. */
function otherKitProject(installed: string[] = []): string {
  const dir = temp();
  const manifest = emptyManifest(DEFAULT_REGISTRY);
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
}, 120_000);

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

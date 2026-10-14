import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUNFIG, tsconfig } from "../commands/starter.ts";
import { uiProjects, watchUiProjects, withBunfigIgnored, withTsconfigExcluded } from "./ui-project.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-ui-projects-"));
  dirs.push(dir);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

test("a UI project is a folder of src/ with a package.json, src/pikit/ aside", () => {
  const dir = tree({
    "src/dashboard/package.json": "{}",
    "src/chat/package.json": "{}",
    "src/pikit/package.json": "{}",
    "src/agents/assistant/agent.ts": "",
    "src/chat/src/deep/package.json": "{}",
  });
  expect(uiProjects(dir)).toEqual(["src/chat", "src/dashboard"]);
  expect(uiProjects(tree({ "pikit.config.ts": "" }))).toEqual([]);
});

test("tsconfig.json: a UI project joins exclude and leaves it; untouched when listed, undefined when not JSON", () => {
  const starter = tsconfig();
  const added = withTsconfigExcluded(starter, ["src/chat"], []) as string;
  expect(JSON.parse(added).exclude).toEqual(["node_modules", "vendor", ".pikit", "registry", "src/dashboard", "src/chat"]);
  expect(JSON.parse(added).compilerOptions).toEqual(JSON.parse(starter).compilerOptions);
  expect(withTsconfigExcluded(added, ["src/chat"], [])).toBe(added);
  expect(withTsconfigExcluded(added, [], ["src/chat"])).toBe(starter);
  // Without exclude, tsc leaves node_modules out on its own: so does the one written.
  expect(JSON.parse(withTsconfigExcluded("{}", ["src/chat"], []) as string).exclude).toEqual(["node_modules", "src/chat"]);
  expect(withTsconfigExcluded('{ // mine\n "exclude": [] }', ["src/chat"], [])).toBeUndefined();
});

test("bunfig.toml: a UI project joins pathIgnorePatterns and leaves it; undefined when it is not one line", () => {
  const added = withBunfigIgnored(BUNFIG, ["src/chat"], []) as string;
  expect(added).toContain('pathIgnorePatterns = ["registry/**", "src/dashboard/**", "src/chat/**"]');
  expect(withBunfigIgnored(added, ["src/chat"], [])).toBe(added);
  expect(withBunfigIgnored(added, [], ["src/chat"])).toBe(BUNFIG);
  expect(withBunfigIgnored('preload = ["x.ts"]\n', ["src/chat"], [])).toBe('preload = ["x.ts"]\n\n[test]\npathIgnorePatterns = ["src/chat/**"]\n');
  expect(withBunfigIgnored("[test]\nroot = \".\"\n", ["src/chat"], [])).toBe('[test]\npathIgnorePatterns = ["src/chat/**"]\nroot = "."\n');
  expect(withBunfigIgnored('[test]\npathIgnorePatterns = [\n  "registry/**",\n]\n', ["src/chat"], [])).toBeUndefined();
});

/** Waits until `check` holds, or fails after `ms`. */
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

test("pikit dev's watcher builds a UI project again when its files change, never for what its build writes", async () => {
  const dir = tree({ "src/chat/package.json": "{}", "src/chat/src/app.tsx": "1", "src/chat/index.html": "<html>", "src/pikit/channel-web/chat-files.ts": "" });
  const builds: string[] = [];
  // macOS may report the files just made to a watcher started at once: let them settle first.
  await Bun.sleep(300);
  const watcher = watchUiProjects(dir, async (_project, ui) => {
    builds.push(ui);
    // What a build writes: its dist/ and its component's module.
    mkdirSync(join(dir, ui, "dist"), { recursive: true });
    writeFileSync(join(dir, ui, "dist", "index.html"), String(builds.length));
    writeFileSync(join(dir, "src/pikit/channel-web/chat-files.ts"), String(builds.length));
  });
  try {
    writeFileSync(join(dir, "src/chat/src/app.tsx"), "2");
    await until(() => builds.length === 1);
    // Its own writes start nothing.
    await Bun.sleep(600);
    expect(builds).toEqual(["src/chat"]);

    writeFileSync(join(dir, "src/chat/index.html"), "<html lang=en>");
    await until(() => builds.length === 2);
    expect(readFileSync(join(dir, "src/pikit/channel-web/chat-files.ts"), "utf8")).toBe("2");
  } finally {
    watcher.close();
  }
  expect(existsSync(join(dir, "src/chat/dist/index.html"))).toBe(true);
}, 30_000);

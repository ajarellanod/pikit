/**
 * `initRepository`: what `pikit new` does on a server, with the machine's git, in temporary
 * directories.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRepository } from "./git.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-git-test-"));
  dirs.push(dir);
  return dir;
};

async function git(dir: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "ignore" });
  return (await new Response(child.stdout).text()).trim();
}

test("a repository on main with everything committed but what .gitignore leaves out", async () => {
  const dir = temp();
  writeFileSync(join(dir, ".gitignore"), ".env\n.pikit/\nnode_modules/\n");
  writeFileSync(join(dir, "pikit.config.ts"), "export default {};\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  mkdirSync(join(dir, ".pikit"));
  writeFileSync(join(dir, ".pikit", "state.db"), "");
  expect(await initRepository(dir, "pikit new bot")).toMatchObject({ made: true });
  expect(await git(dir, "symbolic-ref", "--short", "HEAD")).toBe("main");
  expect((await git(dir, "ls-files")).split("\n")).toEqual([".gitignore", "pikit.config.ts"]);
  expect(await git(dir, "log", "--format=%s")).toBe("pikit new bot");
  expect(await git(dir, "status", "--porcelain")).toBe("");
});

test("not inside another repository: said, nothing made", async () => {
  const outer = temp();
  writeFileSync(join(outer, "README.md"), "outer\n");
  expect((await initRepository(outer, "outer")).made).toBe(true);
  const inner = join(outer, "inner");
  mkdirSync(inner);
  writeFileSync(join(inner, "a.txt"), "a\n");
  expect(await initRepository(inner, "inner")).toEqual({ made: false, why: "the directory is inside another git repository" });
});

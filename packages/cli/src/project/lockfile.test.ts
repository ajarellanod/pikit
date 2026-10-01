/**
 * Whether `bun.lock` matches `package.json` (`lockfile.ts`), on lockfiles in the format Bun 1.4 writes:
 * JSONC with trailing commas, `overrides` in their own section, specifiers as `package.json` wrote them.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLockfile } from "./lockfile.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const KIT = "file:vendor/pikit-core-0.0.0-abcdef1234.tgz";
const PACKAGE = {
  name: "project",
  dependencies: { "@pikit/core": KIT, hono: "^4.6.0", "left-pad": "1.3.0" },
  devDependencies: { wrangler: "4.143.0" },
  optionalDependencies: { "fsevents": "*" },
  // An override replaces what a dependency's own descriptor would resolve to: the lock keeps both as written.
  overrides: { "@pikit/core": KIT, "@pikit/contracts": "file:vendor/pikit-contracts-0.0.0-0123456789.tgz", hono: "4.7.1" },
};

/** As Bun 1.4.2 writes it for PACKAGE (trailing commas; packages resolved to versions the specifiers only allow). */
const LOCK = `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "project",
      "dependencies": {
        "@pikit/core": "${KIT}",
        "hono": "^4.6.0",
        "left-pad": "1.3.0",
      },
      "devDependencies": {
        "wrangler": "4.143.0",
      },
      "optionalDependencies": {
        "fsevents": "*",
      },
    },
  },
  "overrides": {
    "@pikit/contracts": "file:vendor/pikit-contracts-0.0.0-0123456789.tgz",
    "@pikit/core": "${KIT}",
    "hono": "4.7.1",
  },
  "packages": {
    "@pikit/core": ["@pikit/core@vendor/pikit-core-0.0.0-abcdef1234.tgz", {}, "sha512-AAAA"],

    "hono": ["hono@4.7.1", "", {}, "sha512-BBBB"],

    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-CCCC"],
  }
}
`;

function project(files: Record<string, string>, nodeModules = true): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-lockfile-test-"));
  dirs.push(dir);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  if (nodeModules) mkdirSync(join(dir, "node_modules"));
  return dir;
}

const pkg = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

test("a lockfile Bun wrote for package.json matches it: overrides and resolved versions are not specifiers", () => {
  expect(checkLockfile(project({ "package.json": pkg(PACKAGE), "bun.lock": LOCK }))).toEqual({ problems: [], notes: [] });
  // Comments are JSONC too.
  const commented = LOCK.replace('"lockfileVersion": 2,', '// written by bun\n  "lockfileVersion": 2, /* v2 */');
  expect(checkLockfile(project({ "package.json": pkg(PACKAGE), "bun.lock": commented }))).toEqual({ problems: [], notes: [] });
  // Overrides have their own snapshot: changing only one must not pass merely because the root descriptors match.
  const overridden = LOCK.replace('"hono": "4.7.1"', '"hono": "4.8.0"');
  expect(checkLockfile(project({ "package.json": pkg(PACKAGE), "bun.lock": overridden })).problems[0]).toContain('overrides.hono: package.json has "4.7.1", bun.lock has "4.8.0"');
});

test("the lockfile this Bun writes matches its package.json, until package.json changes", async () => {
  // A local folder dependency and an override nothing uses: no network (the registry is unreachable anyway).
  const dir = project({
    "package.json": pkg({ name: "p", dependencies: { a: "file:./a" }, devDependencies: { b: "file:./a" }, overrides: { c: "1.2.3" } }),
    "bunfig.toml": '[install]\nregistry = "http://127.0.0.1:9/"\n',
  }, false);
  mkdirSync(join(dir, "a"));
  writeFileSync(join(dir, "a", "package.json"), pkg({ name: "a", version: "1.0.0" }));
  const child = Bun.spawn([process.execPath, "install"], { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(err).not.toContain("error");
  expect(code).toBe(0);
  expect(checkLockfile(dir)).toEqual({ problems: [], notes: [] });
  writeFileSync(join(dir, "package.json"), pkg({ name: "p", dependencies: { a: "file:./a" }, devDependencies: { b: "file:./a" }, overrides: { c: "2.0.0" } }));
  expect(checkLockfile(dir).problems[0]).toContain('overrides.c: package.json has "2.0.0", bun.lock has "1.2.3"');

  writeFileSync(join(dir, "package.json"), pkg({ name: "p", dependencies: { a: "file:./a", b: "file:./a" }, overrides: { c: "1.2.3" } }));
  expect(checkLockfile(dir).problems[0]).toContain('b: package.json has dependencies "file:./a", bun.lock has devDependencies "file:./a"');
}, 60_000);

test("a name added, removed, moved to another field, or with another specifier is a problem, each named", () => {
  const changed = {
    ...PACKAGE,
    dependencies: { "@pikit/core": KIT, hono: "^4.7.0", "is-odd": "3.0.1" },
    devDependencies: { wrangler: "4.143.0", "left-pad": "1.3.0" },
    optionalDependencies: {},
  };
  const { problems, notes } = checkLockfile(project({ "package.json": pkg(changed), "bun.lock": LOCK }));
  expect(notes).toEqual([]);
  expect(problems).toHaveLength(1);
  const problem = problems[0] as string;
  expect(problem).toContain("bun.lock does not match package.json, so node_modules may not either: run `bun install`");
  expect(problem).toContain('fsevents: bun.lock has it (optionalDependencies "*"), package.json does not');
  expect(problem).toContain('hono: package.json has dependencies "^4.7.0", bun.lock has dependencies "^4.6.0"');
  expect(problem).toContain('is-odd: package.json has it (dependencies "3.0.1"), bun.lock does not');
  expect(problem).toContain('left-pad: package.json has devDependencies "1.3.0", bun.lock has dependencies "1.3.0"');
  expect(problem).not.toContain("wrangler");
  expect(problem).not.toContain("@pikit/core");
});

test("a name in several fields of package.json matches the one field Bun records it in", () => {
  const both = { name: "p", dependencies: { a: "file:vendor/a.tgz" }, devDependencies: { a: "file:vendor/a.tgz" } };
  const lock = '{ "lockfileVersion": 2, "workspaces": { "": { "name": "p", "devDependencies": { "a": "file:vendor/a.tgz", }, }, }, "packages": {}, }';
  expect(checkLockfile(project({ "package.json": pkg(both), "bun.lock": lock })).problems).toEqual([]);
  const other = lock.replace('"devDependencies": { "a": "file:vendor/a.tgz"', '"devDependencies": { "a": "file:vendor/b.tgz"');
  expect(checkLockfile(project({ "package.json": pkg(both), "bun.lock": other })).problems).toHaveLength(1);
});

test("an unreadable lockfile, or one without a root workspace, is a problem; package.json too", () => {
  const broken = checkLockfile(project({ "package.json": pkg(PACKAGE), "bun.lock": LOCK.slice(0, 200) }));
  expect(broken.problems[0]).toContain("bun.lock cannot be read");
  const rootless = checkLockfile(project({ "package.json": pkg(PACKAGE), "bun.lock": '{ "lockfileVersion": 2, "workspaces": {}, }' }));
  expect(rootless.problems[0]).toContain('bun.lock has no root workspace (`workspaces[""]`)');
  const noPackage = checkLockfile(project({ "bun.lock": LOCK }));
  expect(noPackage.problems[0]).toContain("package.json cannot be read");
});

test("bun.lockb is not parsed, and no lockfile is not a problem: each is said once, as unchecked", () => {
  expect(checkLockfile(project({ "package.json": pkg(PACKAGE), "bun.lockb": "\u0000binary" }))).toEqual({
    problems: [],
    notes: ["bun.lockb is Bun's old binary lockfile: whether it matches package.json is not checked"],
  });
  expect(checkLockfile(project({ "package.json": pkg(PACKAGE) }))).toEqual({
    problems: [],
    notes: ["there is no bun.lock: whether node_modules matches package.json is not checked"],
  });
  // Without node_modules either, doctor already asks for `bun install`.
  expect(checkLockfile(project({ "package.json": pkg(PACKAGE) }, false))).toEqual({ problems: [], notes: [] });
});

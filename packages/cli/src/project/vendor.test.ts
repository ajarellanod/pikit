/**
 * The vendored kit follows the CLI: a project made by an older checkout gets this one's kit when a
 * component is added (`refreshKit`), since the component may need what that core added. Never an
 * older one: the kit's commit orders them (`compareKits`), on a throwaway repository here.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPackageJson } from "./package-json.ts";
import { compareKits, EXTENSION_ALIAS, kitSpecifier, pruneVendor, refreshKit, staleKit } from "./vendor.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test("a project on another kit gets this CLI's: tarballs, dependencies and overrides; the old tarballs go", () => {
  // The old kit predates @pikit/contracts: it gets an override, since the other kit packages name it.
  const project = mkdtempSync(join(tmpdir(), "pikit-vendor-"));
  dirs.push(project);
  mkdirSync(join(project, "vendor"));
  // What `pikit new` wrote before tarballs carried a hash.
  const old = {
    "@pikit/core": "file:vendor/pikit-core-0.0.0.tgz",
    "@pikit/pi-adapter": "file:vendor/pikit-pi-adapter-0.0.0.tgz",
    "@pikit/pi-extension-shim": "file:vendor/pikit-pi-extension-shim-0.0.0.tgz",
  };
  for (const specifier of Object.values(old)) writeFileSync(join(project, specifier.slice("file:".length)), "an older kit");
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      name: "old",
      dependencies: { [EXTENSION_ALIAS]: old["@pikit/pi-extension-shim"], "@pikit/core": old["@pikit/core"], hono: "4.13.9" },
      overrides: old,
    }),
  );

  // What a refresh would do is known before it writes anything: `add` decides in its plan.
  const text = readFileSync(join(project, "package.json"), "utf8");
  const all = ["@pikit/contracts", "@pikit/core", "@pikit/pi-adapter", "@pikit/pi-extension-shim"];
  expect(staleKit(project).vendored).toBe(true);
  expect(staleKit(project).stale.sort()).toEqual(all);
  expect(readFileSync(join(project, "package.json"), "utf8")).toBe(text);
  expect(readdirSync(join(project, "vendor")).length).toBe(3);

  expect(refreshKit(project).sort()).toEqual(all);

  const pkg = readPackageJson(project);
  expect(pkg.dependencies).toEqual({ [EXTENSION_ALIAS]: kitSpecifier("@pikit/pi-extension-shim"), "@pikit/core": kitSpecifier("@pikit/core"), hono: "4.13.9" });
  expect(pkg.overrides).toEqual({
    "@pikit/contracts": kitSpecifier("@pikit/contracts"),
    "@pikit/core": kitSpecifier("@pikit/core"),
    "@pikit/pi-adapter": kitSpecifier("@pikit/pi-adapter"),
    "@pikit/pi-extension-shim": kitSpecifier("@pikit/pi-extension-shim"),
  });
  // The old tarballs stay until the install rewrote bun.lock; then they go.
  for (const specifier of Object.values(old)) expect(existsSync(join(project, specifier.slice("file:".length)))).toBe(true);
  expect(pruneVendor(project).sort()).toEqual(["pikit-core-0.0.0.tgz", "pikit-pi-adapter-0.0.0.tgz", "pikit-pi-extension-shim-0.0.0.tgz"]);
  expect(readdirSync(join(project, "vendor")).sort()).toEqual(
    Object.values(pkg.overrides ?? {})
      .map((s) => s.slice("file:vendor/".length))
      .sort(),
  );

  // Already on this kit: nothing to do.
  expect(refreshKit(project)).toEqual([]);
  expect(staleKit(project)).toEqual({ vendored: true, stale: [] });
}, 60_000);

test("a kit replaces another when it comes after it; before it, or on another branch, is a downgrade; else unknown", () => {
  const repo = mkdtempSync(join(tmpdir(), "pikit-kit-repo-"));
  dirs.push(repo);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@pikit.test", "-c", "user.name=t", ...args], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  git("init", "-q");
  const commit = (message: string) => {
    git("commit", "-q", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const a = commit("a");
  const b = commit("b");
  git("checkout", "-q", "-b", "other", a);
  const c = commit("c");

  expect(compareKits(repo, a, b)).toEqual({ verdict: "upgrade" });
  expect(compareKits(repo, a, a)).toEqual({ verdict: "upgrade" });
  expect(compareKits(repo, a, `${b}-dirty`)).toEqual({ verdict: "upgrade" });
  expect(compareKits(repo, `${a}-dirty`, b)).toEqual({ verdict: "upgrade" });
  expect(compareKits(repo, b, a)).toEqual({ verdict: "downgrade" });
  expect(compareKits(repo, c, b)).toEqual({ verdict: "downgrade" });

  const unknown = (current: string | undefined, next: string | undefined) => compareKits(repo, current, next).verdict;
  expect(unknown(`${a}-dirty`, a)).toBe("unknown");
  expect(unknown("0123456789abcdef0123456789abcdef01234567", a)).toBe("unknown");
  expect(unknown(undefined, a)).toBe("unknown");
  expect(unknown(a, undefined)).toBe("unknown");
  expect(compareKits(tmpdir(), a, b).verdict).toBe("unknown");
});

test("a tarball's name carries a hash of the package's files", () => {
  expect(kitSpecifier("@pikit/core")).toMatch(/^file:vendor\/pikit-core-0\.0\.0-[0-9a-f]{10}\.tgz$/);
});

/**
 * The vendored kit follows the CLI: a project made by an older checkout gets this one's kit when a
 * component is added (`refreshKit`), since the component may need what that core added.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPackageJson } from "./package-json.ts";
import { EXTENSION_ALIAS, kitSpecifier, refreshKit } from "./vendor.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test("a project on another kit gets this CLI's: tarballs, dependencies and overrides; the old tarballs go", () => {
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

  expect(refreshKit(project).sort()).toEqual(["@pikit/core", "@pikit/pi-adapter", "@pikit/pi-extension-shim"]);

  const pkg = readPackageJson(project);
  expect(pkg.dependencies).toEqual({ [EXTENSION_ALIAS]: kitSpecifier("@pikit/pi-extension-shim"), "@pikit/core": kitSpecifier("@pikit/core"), hono: "4.13.9" });
  expect(pkg.overrides).toEqual({
    "@pikit/core": kitSpecifier("@pikit/core"),
    "@pikit/pi-adapter": kitSpecifier("@pikit/pi-adapter"),
    "@pikit/pi-extension-shim": kitSpecifier("@pikit/pi-extension-shim"),
  });
  expect(readdirSync(join(project, "vendor")).sort()).toEqual(
    Object.values(pkg.overrides ?? {})
      .map((s) => s.slice("file:vendor/".length))
      .sort(),
  );
  for (const specifier of Object.values(old)) expect(existsSync(join(project, specifier.slice("file:".length)))).toBe(false);

  // Already on this kit: nothing to do.
  expect(refreshKit(project)).toEqual([]);
}, 60_000);

test("a tarball's name carries a hash of the package's files", () => {
  expect(kitSpecifier("@pikit/core")).toMatch(/^file:vendor\/pikit-core-0\.0\.0-[0-9a-f]{10}\.tgz$/);
});

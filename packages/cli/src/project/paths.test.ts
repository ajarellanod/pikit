import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { add, checkConflicts } from "../commands/add.ts";
import { checkManifest } from "../registry/checks.ts";
import type { Manifest, RegistryIndex } from "../registry/manifest.ts";
import { unreferencedBases } from "./bases.ts";
import { emptyManifest, writeProjectManifest } from "./pikit-json.ts";
import { confinedPath, isInside } from "./paths.ts";
import { isProtected, openRegistry } from "./registry-source.ts";
import { Undo } from "./undo.ts";
import { pruneVendor, vendorKitPackage } from "./vendor.ts";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-path-test-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

function registry() {
  const root = temp();
  const name = "storage-fake";
  const component = join(root, "components", name);
  const source = join(component, "files", "src", "pikit", name, "index.ts");
  write(source, "export const value = 1;\n");
  const manifest: Manifest = {
    name, version: "0.0.0", description: name, targets: ["server"],
    requires: { pikit: "0.0.0", capabilities: [] }, optional: { capabilities: [] }, provides: [], dependencies: {},
    files: [{ source: "files/src", target: "src" }],
  };
  const index: RegistryIndex = { version: 1, components: { [name]: { version: manifest.version, description: name, targets: manifest.targets, path: `components/${name}` } } };
  write(join(component, "component.json"), JSON.stringify(manifest));
  write(join(root, "registry.json"), JSON.stringify(index));
  return { root, name, component, source, manifest, index };
}

test("relative confinement uses portable separators and allows a symlinked root", () => {
  for (const file of ["", ".", "..", "../x", "..\\x", "/x", "C:\\x", "C:x", "\\\\host\\x", "a\0b"]) expect(isInside(file), file).toBe(false);
  for (const file of ["src/a.ts", "src\\a.ts", "./src/a.ts", "a/../src/a.ts"]) expect(isInside(file), file).toBe(true);
  const root = temp();
  const alias = join(temp(), "root");
  symlinkSync(root, alias, "dir");
  expect(confinedPath(alias, "missing\\nested.txt")).toBe(join(realpathSync(root), "missing/nested.txt"));
});

test("registry index shape and component paths are validated, including physical aliases", () => {
  const f = registry();
  for (const invalid of [{ version: 2, components: {} }, { version: 1, components: [] }, { version: 1, components: { x: { path: 7 } } }]) {
    write(join(f.root, "registry.json"), JSON.stringify(invalid));
    expect(() => openRegistry(f.root)).toThrow("invalid registry.json");
  }
  for (const path of ["../outside", "..\\outside", "/outside", "C:\\outside"]) {
    f.index.components[f.name]!.path = path;
    write(join(f.root, "registry.json"), JSON.stringify(f.index));
    expect(() => openRegistry(f.root)).toThrow(/leaves/);
  }
  const outside = temp();
  symlinkSync(outside, join(f.root, "linked"), "dir");
  f.index.components[f.name]!.path = "linked";
  write(join(f.root, "registry.json"), JSON.stringify(f.index));
  expect(() => openRegistry(f.root).dir(f.name)).toThrow(/symlink/);
  expect(() => openRegistry(f.root).dir("constructor")).toThrow(/has no component/);
});

test("sources cannot escape lexically, link to an external tree, or contain a symlink cycle", () => {
  const f = registry();
  for (const source of ["../../outside.ts", "..\\outside.ts", "/outside.ts"]) {
    const manifest = { ...f.manifest, files: [{ source, target: "src/new.ts" }] };
    write(join(f.component, "component.json"), JSON.stringify(manifest));
    expect(() => openRegistry(f.root).files(f.name)).toThrow(/leaves/);
    expect(checkManifest(manifest, f.component, f.name, "0.0.0", "0.0.0", "0.0.0").some((p) => p.includes("leaves"))).toBe(true);
  }
  write(join(f.component, "component.json"), JSON.stringify(f.manifest));
  const src = join(f.component, "files", "src");
  rmSync(src, { recursive: true });
  const outside = temp();
  write(join(outside, "external.ts"), "private source");
  symlinkSync(outside, src, "dir");
  expect(() => openRegistry(f.root).files(f.name)).toThrow(/symlink/);
  rmSync(src);
  mkdirSync(src);
  symlinkSync(src, join(src, "loop"), "dir");
  expect(() => openRegistry(f.root).files(f.name)).toThrow(/symlink/);
  expect(readFileSync(join(outside, "external.ts"), "utf8")).toBe("private source");
});

test("a symlinked manifest and a manifest whose name differs from its index are rejected", () => {
  const f = registry();
  write(join(f.component, "component.json"), JSON.stringify({ ...f.manifest, name: "storage-other" }));
  expect(() => openRegistry(f.root).manifest(f.name)).toThrow(/component.json name/);
  rmSync(join(f.component, "component.json"));
  const outside = join(temp(), "component.json");
  write(outside, JSON.stringify(f.manifest));
  symlinkSync(outside, join(f.component, "component.json"));
  expect(() => openRegistry(f.root).manifest(f.name)).toThrow(/symlink/);
  expect(() => openRegistry(f.root).preset("../../outside")).toThrow(/invalid preset name/);
});

test("Undo refuses linked ancestors, files and protected-record aliases, even for deletes", () => {
  const root = temp();
  const outside = temp();
  write(join(outside, "sentinel.txt"), "outside");
  symlinkSync(outside, join(root, "src"), "dir");
  const undo = new Undo(root);
  for (const operation of [() => undo.keep("src/sentinel.txt"), () => undo.mkdirFor("src/new.txt"), () => undo.delete("src/sentinel.txt"), () => undo.mkdirFor("..\\outside.txt")]) expect(operation).toThrow(/symlink|leaves/);
  write(join(root, "package.json"), "{}");
  symlinkSync(join(root, "package.json"), join(root, "alias.json"));
  expect(() => undo.mkdirFor("alias.json")).toThrow(/symlink/);
  expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("outside");
});

test("Undo restores normal operations, but never restores through a replaced ancestor", () => {
  const root = temp();
  write(join(root, "src", "existing.txt"), "before");
  const undo = new Undo(root);
  undo.keep("src/existing.txt");
  writeFileSync(undo.mkdirFor("src/existing.txt"), "after");
  undo.keep("src/new/file.txt");
  writeFileSync(undo.mkdirFor("src/new/file.txt"), "new");
  undo.delete("src/existing.txt");
  undo.restore();
  expect(readFileSync(join(root, "src", "existing.txt"), "utf8")).toBe("before");
  expect(existsSync(join(root, "src", "new"))).toBe(false);

  const guarded = new Undo(root);
  guarded.keep("src/existing.txt");
  renameSync(join(root, "src"), join(root, "saved-src"));
  const outside = temp();
  write(join(outside, "existing.txt"), "outside");
  symlinkSync(outside, join(root, "src"), "dir");
  expect(() => guarded.restore()).toThrow(/symlink/);
  expect(readFileSync(join(outside, "existing.txt"), "utf8")).toBe("outside");
});

test("bases and vendor operations cannot follow linked directories", () => {
  const root = temp();
  const outside = temp();
  write(join(root, "package.json"), "{}");
  write(join(outside, "unused.tgz"), "outside");
  symlinkSync(outside, join(root, "pikit-bases"), "dir");
  symlinkSync(outside, join(root, "vendor"), "dir");
  expect(() => unreferencedBases(root, emptyManifest())).toThrow(/symlink/);
  expect(() => vendorKitPackage(root, "@pikit/core")).toThrow(/symlink/);
  expect(() => pruneVendor(root)).toThrow(/symlink/);
  expect(readFileSync(join(outside, "unused.tgz"), "utf8")).toBe("outside");
  for (const file of [".pikit-operation-unfinished", ".pikit-new-unfinished"]) expect(isProtected(file)).toBe(true);
});

test("add rejects a symlinked destination during preflight without modifying the project or exterior", async () => {
  const f = registry();
  const root = temp();
  const outside = temp();
  symlinkSync(outside, join(root, "src"), "dir");
  write(join(root, "package.json"), "{}");
  write(join(root, "pikit.config.ts"), "export default {};\n");
  writeProjectManifest(root, emptyManifest(f.root));
  const before = readFileSync(join(root, "pikit.json"), "utf8");
  const files = openRegistry(f.root).files(f.name);
  expect(() => checkConflicts(root, emptyManifest(f.root), f.name, files, true)).toThrow(/symlink/);
  await expect(add(root, f.name, { yes: true, force: true, quiet: true })).rejects.toThrow(/symlink/);
  expect(readFileSync(join(root, "pikit.json"), "utf8")).toBe(before);
  expect(readFileSync(join(root, "package.json"), "utf8")).toBe("{}");
  expect(existsSync(join(outside, "pikit", f.name, "index.ts"))).toBe(false);
  expect(existsSync(join(root, ".pikit-operation-unfinished"))).toBe(false);
});

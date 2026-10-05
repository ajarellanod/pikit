/**
 * The dashboard template (`registry/dashboard/files/`, copied to a project's `src/dashboard/` by
 * `pikit ui on`) keeps what SPEC §5 asks of it. Building it needs its npm packages, so it is built by
 * hand (`bun install && bun run build` in that folder); these checks need nothing.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssets, type DashboardFiles } from "../registry/components/admin-api/files/src/pikit/admin-api/assets.ts";
import { generated, OUTPUT } from "./ui-registry.ts";

const REPO = join(import.meta.dir, "..");
const DASHBOARD = join(REPO, "registry/dashboard/files");
const read = (path: string) => readFileSync(join(DASHBOARD, path), "utf8");

test("the dashboard's copy of the admin API's types is admin-api's api.ts, byte for byte", () => {
  const original = readFileSync(join(REPO, "registry/components/admin-api/files/src/pikit/admin-api/api.ts"), "utf8");

  expect(read("src/lib/admin-api.ts")).toBe(original);
});

test("its npm packages are pinned to exact versions, so every project builds the same dashboard", () => {
  const manifest = JSON.parse(read("package.json")) as Record<string, Record<string, string> | undefined>;
  const ranges = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(version));

  expect(ranges).toEqual([]);
  expect(existsSync(join(DASHBOARD, "bun.lock"))).toBe(true);
});

test("every view is a folder of src/views/ with an index.tsx that defines it under its own name", () => {
  const views = readdirSync(join(DASHBOARD, "src/views"));

  expect(views.length).toBeGreaterThan(0);
  for (const view of views) {
    expect(read(`src/views/${view}/index.tsx`)).toContain(`id: "${view}"`);
  }
});

const temps: string[] = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A project's src/ with the template's embed step and a built dist/, and admin-api's folder when `withAdminApi`. */
function builtProject(withAdminApi: boolean): string {
  const src = mkdtempSync(join(realpathSync(tmpdir()), "pikit-embed-"));
  temps.push(src);
  cpSync(join(DASHBOARD, "scripts"), join(src, "dashboard", "scripts"), { recursive: true });
  mkdirSync(join(src, "dashboard", "dist", "assets"), { recursive: true });
  writeFileSync(join(src, "dashboard", "dist", "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(join(src, "dashboard", "dist", "assets", "index-abc.js"), "console.log('é')");
  writeFileSync(join(src, "dashboard", "dist", "favicon.ico"), new Uint8Array([0, 159, 255]));
  if (withAdminApi) mkdirSync(join(src, "pikit", "admin-api"), { recursive: true });
  return src;
}

async function embed(src: string): Promise<{ code: number; out: string }> {
  const child = Bun.spawn([process.execPath, join(src, "dashboard", "scripts", "embed.ts")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out: out + err };
}

test("its build's last step writes dist/ into admin-api's dashboard-files.ts, which admin-api serves byte for byte", async () => {
  const src = builtProject(true);
  expect(read("package.json")).toContain('"build": "tsc -b && vite build && bun scripts/embed.ts"');

  const first = await embed(src);
  expect(first).toMatchObject({ code: 0 });
  expect(first.out).toContain("embed: 3 files into");
  const module = join(src, "pikit", "admin-api", "dashboard-files.ts");
  const { DASHBOARD_FILES } = (await import(module)) as { DASHBOARD_FILES: DashboardFiles };
  expect(Object.keys(DASHBOARD_FILES)).toEqual(["assets/index-abc.js", "favicon.ico", "index.html"]);

  const assets = createAssets(DASHBOARD_FILES);
  expect(await assets.serve("/admin/conversations/x").text()).toContain("id=root");
  expect(await assets.serve("/admin/assets/index-abc.js").text()).toBe("console.log('é')");
  expect([...new Uint8Array(await assets.serve("/admin/favicon.ico").arrayBuffer())]).toEqual([0, 159, 255]);

  // Built again with nothing changed, the module is left as it was.
  const again = await embed(src);
  expect(again.out).toContain("is up to date (3 files)");
});

test("without admin-api next to it, the build makes dist/ only", async () => {
  const src = builtProject(false);

  expect(await embed(src)).toMatchObject({ code: 0, out: expect.stringContaining("admin-api is not installed") });
  expect(existsSync(join(src, "pikit"))).toBe(false);
});

test("it is served under /admin/ and its primitives are attributed", () => {
  expect(read("vite.config.ts")).toContain('base: "/admin/"');
  expect(read("NOTICE")).toContain("shadcn/ui");
  expect(read("NOTICE")).toContain("MIT");
});

test("the @pikit shadcn registry (registry/ui/r/) is what scripts/ui-registry.ts generates from the sources", () => {
  const files = generated();

  for (const [name, text] of files) expect({ name, text: readFileSync(join(OUTPUT, name), "utf8") }).toEqual({ name, text });
  expect(readdirSync(OUTPUT).sort()).toEqual([...files.keys()].sort());
  expect((JSON.parse(read("components.json")) as { registries: Record<string, string> }).registries["@pikit"]).toContain("registry/ui/r/{name}.json");
});

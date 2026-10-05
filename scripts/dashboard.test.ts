/**
 * The dashboard template (`registry/dashboard/files/`, copied to a project's `src/dashboard/` by
 * `pikit ui on`) keeps what SPEC §5 asks of it. Building it needs its npm packages, so it is built by
 * hand (`bun install && bun run build` in that folder); these checks need nothing.
 */

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

test("it is served under /admin/ and its primitives are attributed", () => {
  expect(read("vite.config.ts")).toContain('base: "/admin/"');
  expect(read("NOTICE")).toContain("shadcn/ui");
  expect(read("NOTICE")).toContain("MIT");
});

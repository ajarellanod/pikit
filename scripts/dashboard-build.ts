/**
 * Builds the dashboard template with every registry component's view in it, as a project with all of
 * them installed would have it: the check that the components' views compile (`tsc -b`) and bundle
 * (`vite build`) against the dashboard they are written for. Needs the template's packages:
 *
 *   cd registry/dashboard/files && bun install
 *   bun scripts/dashboard-build.ts
 *
 * It works on a copy (the real temporary directory, never through a symlink) that reuses the
 * template's node_modules, and deletes it after.
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const DASHBOARD = join(REPO, "registry/dashboard/files");
const COMPONENTS = join(REPO, "registry/components");

if (!existsSync(join(DASHBOARD, "node_modules"))) {
  console.error("dashboard-build: the template has no node_modules: run `bun install` in registry/dashboard/files first");
  process.exit(1);
}
const work = mkdtempSync(join(realpathSync(tmpdir()), "pikit-dashboard-build-"));
try {
  cpSync(DASHBOARD, work, { recursive: true, filter: (source) => !/\/(node_modules|dist)(\/|$)/.test(source.slice(DASHBOARD.length)) });
  symlinkSync(join(DASHBOARD, "node_modules"), join(work, "node_modules"));
  const views: string[] = [];
  for (const component of readdirSync(COMPONENTS).sort()) {
    const manifestPath = join(COMPONENTS, component, "component.json");
    if (!existsSync(manifestPath)) continue;
    const { view } = JSON.parse(readFileSync(manifestPath, "utf8")) as { view?: string };
    if (view === undefined) continue;
    cpSync(join(COMPONENTS, component, view), join(work, "src/views", component), { recursive: true });
    views.push(component);
  }
  console.log(`dashboard-build: the template with the views of ${views.join(", ") || "no component"}`);
  const child = Bun.spawn([process.execPath, "run", "build"], { cwd: work, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) {
    console.error(`dashboard-build: the build failed (code ${code})`);
    process.exitCode = 1;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

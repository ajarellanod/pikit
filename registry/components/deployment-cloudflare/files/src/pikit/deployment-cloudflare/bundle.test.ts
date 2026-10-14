/**
 * The Worker bundles: `wrangler deploy --dry-run` on a throwaway project with this component where
 * `pikit add` puts it and a two-App `pikit.config.ts`. It uploads nothing and needs no account, only
 * the project's wrangler (`node_modules/.bin/wrangler`, which runs on Node). With UI projects (the
 * dashboard's `src/dashboard/`, a component's `src/chat/`), wrangler's `build.command` builds each first,
 * whoever runs wrangler.
 */

import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * A throwaway project with this component, its `wrangler.jsonc` and `files` (fake UI projects), whose
 * Worker serves `GET /hello` with what the modules of `files` (`src/pikit/<component>/<name>-files.ts`)
 * hold, if anything; `wrangler deploy --dry-run` on it.
 */
async function dryRun(files: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string; bundle: string }> {
  const project = mkdtempSync(join(tmpdir(), "pikit-deployment-cloudflare-"));
  try {
    const installed = join(project, "src", "pikit", "deployment-cloudflare");
    mkdirSync(installed, { recursive: true });
    for (const file of ["worker.ts", "entrypoint.ts", "host.ts"]) copyFileSync(join(import.meta.dir, file), join(installed, file));
    copyFileSync(join(ROOT, "wrangler.jsonc"), join(project, "wrangler.jsonc"));
    const installedModules = nodeModules();
    symlinkSync(installedModules, join(project, "node_modules"), "dir");
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "bundle-check", type: "module" }));
    const modules = Object.keys(files).filter((file) => /^src\/pikit\/[^/]+\/[^/]+-files\.ts$/.test(file));
    writeFileSync(
      join(project, "pikit.config.ts"),
      [
        'import { defineApp, defineComponent } from "@pikit/core";',
        ...modules.map((file, i) => `import * as built${i} from "./${file}";`),
        `const BUILT = [${modules.map((_, i) => `built${i}`).join(", ")}];`,
        'const hello = defineComponent({ name: "hello", setup(pikit) { pikit.provideKeyed("http.route", "GET /hello", () => new Response(JSON.stringify(BUILT))); } });',
        "export const worker = defineApp({ components: [hello] });",
        "export default defineApp({ components: [] });",
        "",
      ].join("\n"),
    );
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(project, file)), { recursive: true });
      writeFileSync(join(project, file), text);
    }

    const child = Bun.spawn([join(installedModules, ".bin", "wrangler"), "deploy", "--dry-run", "--outdir", "out", "--name", "bundle-check"], {
      cwd: project,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const output = join(project, "out", "worker.js");
    return { code, stdout, stderr, bundle: existsSync(output) ? readFileSync(output, "utf8") : "" };
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

test("wrangler bundles worker.ts with the project's two Apps, and exports the Conversation class", async () => {
  const { code, stdout, stderr, bundle } = await dryRun();
  expect({ code, stderr }).toEqual({ code: 0, stderr: expect.any(String) });
  expect(stdout).toContain("env.CONVERSATION (Conversation)");
  expect(bundle).toMatch(/export \{[^}]*\bConversation\b[^}]*\bas default\b[^}]*\}/s);
  // The machine's commands (node:child_process) never reach the Worker.
  expect(bundle).not.toContain("child_process");
}, 60_000);

/**
 * A UI project at `src/<name>/` whose build writes its component's module (as the dashboard's
 * `scripts/embed.ts` does), exporting `marker`; or, without one, fails.
 */
const fakeUi = (name: string, component: string, marker: string | undefined): Record<string, string> => {
  const module = `src/pikit/${component}/${name}-files.ts`;
  const text = (value: string) => `export const FILES = { "index.html": "${value}" };\n`;
  return {
    [`src/${name}/package.json`]: JSON.stringify({ name, private: true, scripts: { build: "bun build.ts" } }),
    [`src/${name}/build.ts`]:
      marker === undefined ? 'console.error("vite: broken view"); process.exit(3);\n' : `await Bun.write("../pikit/${component}/${name}-files.ts", ${JSON.stringify(text(marker))});\n`,
    // What the repository holds: an old build, which the deploy must not ship.
    [module]: text(`OLD_${name.toUpperCase()}`),
  };
};

test("with UI projects, any wrangler deploy builds each (the dashboard, a component's) before it bundles: the Worker has the new builds", async () => {
  const { code, stdout, bundle } = await dryRun({ ...fakeUi("dashboard", "admin-api", "NEW_DASHBOARD"), ...fakeUi("chat", "channel-web", "NEW_CHAT") });
  expect(code).toBe(0);
  expect(stdout).toContain("[custom build]");
  expect(bundle).toContain("NEW_DASHBOARD");
  expect(bundle).toContain("NEW_CHAT");
  expect(bundle).not.toContain("OLD_DASHBOARD");
  expect(bundle).not.toContain("OLD_CHAT");
}, 60_000);

test("with UI projects, one build that fails stops the deploy: nothing is bundled", async () => {
  const { code, stdout, stderr, bundle } = await dryRun({ ...fakeUi("chat", "channel-web", undefined), ...fakeUi("dashboard", "admin-api", "NEW_DASHBOARD") });
  expect(code).not.toBe(0);
  expect(`${stdout}${stderr}`).toContain("Running custom build");
  expect(bundle).toBe("");
}, 60_000);

/** The `node_modules` with `@pikit/core` and wrangler: the project's (or the monorepo's). */
function nodeModules(): string {
  for (let dir = import.meta.dir; dir !== dirname(dir); dir = dirname(dir)) {
    const modules = join(dir, "node_modules");
    if (existsSync(join(modules, "@pikit", "core"))) {
      if (!existsSync(join(modules, ".bin", "wrangler"))) throw new Error(`${modules} has no wrangler: run \`bun add --dev wrangler\``);
      return modules;
    }
  }
  throw new Error("no node_modules with @pikit/core above this test");
}

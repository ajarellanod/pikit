/**
 * The components' own steps of `pikit configure` (`component-configure.ts`), run as the CLI runs them:
 * a project with one step that sets a variable and a key of its config, in both Apps' configs when the
 * component goes in both (admin-proposals' repository, on Cloudflare).
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComponentConfigureResult } from "./component-configure.ts";
import { readEnv } from "./env-file.ts";

const SCRIPT = join(import.meta.dir, "component-configure.ts");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const installed = (apps?: { worker: string }) => ({
  registry: "builtin",
  version: "0.0.0",
  requires: { pikit: "0.0.0" },
  files: {},
  dependencies: {},
  addedDependencies: [],
  environment: [],
  ...(apps !== undefined && { apps }),
});

const CONFIG = `export const config = {
  "admin-proposals": {
    // the project's repository
    repository: "",
  },
};

export const workerConfig = {
  "admin-proposals": { repository: "" },
};

export default { config };
export const worker = { config: workerConfig };
`;

/** A project whose components each have a step that sets KEY in .env and `repository` in its config. */
function project(components: Record<string, ReturnType<typeof installed>>): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-component-configure-"));
  dirs.push(dir);
  writeFileSync(join(dir, "pikit.json"), JSON.stringify({ version: 1, targets: ["durable"], registries: { builtin: "builtin" }, components }));
  writeFileSync(join(dir, "pikit.config.ts"), CONFIG);
  for (const name of Object.keys(components)) {
    mkdirSync(join(dir, "src", "pikit", name), { recursive: true });
    writeFileSync(
      join(dir, "src", "pikit", name, "configure.ts"),
      `export async function configure(io) { io.set("STEP_${name.replace(/-/g, "_").toUpperCase()}", "set"); io.setConfig("repository", "ana/bot"); return []; }\n`,
    );
  }
  return dir;
}

async function runSteps(dir: string): Promise<ComponentConfigureResult> {
  const output = join(dir, "result.json");
  const child = Bun.spawn([process.execPath, SCRIPT, dir, output, "batch"], { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect([code, err.includes("error")]).toEqual([0, false]);
  return JSON.parse(readFileSync(output, "utf8")) as ComponentConfigureResult;
}

test("a step sets a variable in .env and a key of its config: in both Apps' configs for a component in both", async () => {
  const dir = project({ "admin-proposals": installed({ worker: "default" }) });
  expect(await runSteps(dir)).toEqual({ ok: true, ran: ["admin-proposals"], missing: [] });
  expect(readEnv(dir).get("STEP_ADMIN_PROPOSALS")).toBe("set");
  expect(readFileSync(join(dir, "pikit.config.ts"), "utf8")).toBe(
    CONFIG.replace('repository: "",\n  },\n};', 'repository: "ana/bot",\n  },\n};').replace('{ repository: "" }', '{ repository: "ana/bot" }'),
  );
});

test("a component only in the default App: only config changes", async () => {
  const dir = project({ "admin-proposals": installed() });
  expect((await runSteps(dir)).ok).toBe(true);
  const text = readFileSync(join(dir, "pikit.config.ts"), "utf8");
  expect(text).toContain('repository: "ana/bot",');
  expect(text).toContain('"admin-proposals": { repository: "" }');
});

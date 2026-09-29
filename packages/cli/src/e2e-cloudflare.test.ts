/**
 * A project on Cloudflare, end to end on this machine (SPEC §4.1): `pikit new --target cloudflare
 * --preset cloudflare-minimal`, `pikit doctor`, the project's own tests (with its `wrangler deploy
 * --dry-run`) and typecheck, then `pikit dev` (wrangler dev, workerd) answering `/health` from the
 * object's App. Nothing reaches a Cloudflare account: `pikit up` is never run.
 *
 * Slow (it runs `bun install`), so it runs only with `PIKIT_E2E=1`. It needs port 8787 free and Node
 * on the PATH (wrangler runs on it).
 *
 *   PIKIT_E2E=1 bun test packages/cli/src/e2e-cloudflare.test.ts
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const E2E = process.env.PIKIT_E2E === "1";
const MAIN = join(import.meta.dir, "main.ts");
const TIMEOUT = 600_000;

const parent = mkdtempSync(join(tmpdir(), "pikit-e2e-cloudflare-"));
const project = join(parent, "edge-bot");
afterAll(() => rmSync(parent, { recursive: true, force: true }));

async function run(command: string[], cwd = project) {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

test.skipIf(!E2E)(
  "pikit new --target cloudflare: a project that composes, bundles, typechecks and passes its own tests",
  async () => {
    const created = await run([process.execPath, MAIN, "new", "edge-bot", "--target", "cloudflare", "--preset", "cloudflare-minimal"], parent);
    expect(created.err).not.toContain("✗");
    expect(created.code).toBe(0);
    expect(JSON.parse(readFileSync(join(project, "pikit.json"), "utf8")).targets).toEqual(["cloudflare"]);

    const doctor = await run([process.execPath, MAIN, "doctor"]);
    expect(doctor.out).toContain("pikit doctor: green");

    // The installed components' tests: deployment-cloudflare's bundles the Worker with the project's wrangler.
    const tests = await run([process.execPath, "test"]);
    expect(tests.err).toContain(" 0 fail");
    expect(tests.code).toBe(0);
    const typecheck = await run([process.execPath, "run", "typecheck"]);
    expect(typecheck.err + typecheck.out).not.toContain("error TS");
    expect(typecheck.code).toBe(0);
  },
  TIMEOUT,
);

test.skipIf(!E2E)(
  "pikit dev runs the Worker in workerd, and /health starts the object's App",
  async () => {
    const dev = Bun.spawn([process.execPath, MAIN, "dev"], { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    try {
      let body: unknown;
      for (let i = 0; i < 60 && body === undefined; i++) {
        body = await fetch("http://127.0.0.1:8787/health").then(
          (response) => response.json(),
          () => undefined,
        );
        if (body === undefined) await Bun.sleep(1_000);
      }
      expect(body).toMatchObject({ ok: true, version: expect.any(String) });
    } finally {
      // wrangler dev is the CLI's child: stopping the CLI's process group stops both.
      dev.kill("SIGINT");
      Bun.spawnSync(["pkill", "-INT", "-f", "wrangler dev --name edge-bot"]);
      await dev.exited;
    }
  },
  TIMEOUT,
);

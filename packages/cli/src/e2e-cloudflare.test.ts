/**
 * A project on Cloudflare, end to end on this machine (SPEC §4.1): `pikit new --target cloudflare
 * --preset cloudflare-minimal`, `pikit doctor`, the project's own tests (with its `wrangler deploy
 * --dry-run`) and typecheck, then `pikit dev` (wrangler dev, workerd) answering `/health` from the
 * object's App. Then `pikit add secrets-cloudflare` and `pikit add channel-telegram-webhook` (with what
 * it offers) put each half in its App (C1), the project installs, typechecks and passes its tests, and
 * `pikit remove` undoes both Apps. Nothing reaches a Cloudflare account: `pikit up` is never run.
 *
 * Slow (it runs `bun install`), so it runs only with `PIKIT_E2E=1`. It needs port 8787 free and Node
 * on the PATH (wrangler runs on it).
 *
 *   PIKIT_E2E=1 bun test packages/cli/src/e2e-cloudflare.test.ts
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/** The two lists of `pikit.config.ts`: the default export's (the object's App) and `worker`'s. */
function lists(): { object: string[]; worker: string[] } {
  const text = readFileSync(join(project, "pikit.config.ts"), "utf8");
  const list = (app: string) => {
    const at = text.indexOf(app);
    const body = /components: \[\n([^\]]*)\]/.exec(text.slice(at))?.[1] ?? "";
    return body.split("\n").map((line) => line.trim().replace(/,$/, "")).filter((line) => line !== "");
  };
  return { object: list("export default defineApp"), worker: list("export const worker = defineApp") };
}

test.skipIf(!E2E)(
  "pikit add channel-telegram-webhook puts each half in its App, with what it offers; the project installs, typechecks and passes its tests; remove undoes both",
  async () => {
    const configPath = join(project, "pikit.config.ts");
    const before = readFileSync(configPath, "utf8");
    const preset = lists();

    // secrets-cloudflare works in both Apps: it goes in both.
    const secrets = await run([process.execPath, MAIN, "add", "secrets-cloudflare", "--yes"]);
    expect(secrets.err).not.toContain("\u2717");
    expect(secrets.code).toBe(0);
    const withSecrets = readFileSync(configPath, "utf8");
    expect(lists()).toEqual({ object: [...preset.object, "secretsCloudflare"], worker: ["secretsCloudflare"] });

    const added = await run([process.execPath, MAIN, "add", "channel-telegram-webhook", "--yes"]);
    // What it offers, for its object's half: the record of submissions and durable delivery (storage-do has their storage).
    expect(added.out).toContain("submissions-sql, for channel-telegram-webhook (agent.submissions)");
    expect(added.out).toContain("outbound-durable, for channel-telegram-webhook (outbound.queue)");
    // Checked per App: the Worker's half needs actor.mailbox in the Worker's App, and the object's half
    // a runtime and wakeups in the object's. No component of this registry provides them on Cloudflare
    // yet (platform-cloudflare and a Cloudflare runtime are not in it), so doctor says the object's App
    // does not compose, and `add` exits 1 with everything installed.
    expect(added.err).toContain('channel-telegram-webhook requires "actor.mailbox" in the Worker\'s App (export const worker), which no installed component provides there yet');
    expect(added.err).toContain('channel-telegram-webhook requires "agent.runtime" in the default App, which no installed component provides there yet');
    expect(added.err).not.toContain('"secrets"');
    expect(added.err).toContain("pikit.config.ts does not compose");
    expect(added.err).toContain("channel-telegram-webhook is installed, but `pikit doctor` found 1 problem(s)");
    expect(added.code).toBe(1);

    const text = readFileSync(configPath, "utf8");
    expect(text).toContain('import channelTelegramWebhook, { worker as channelTelegramWebhookWorker } from "./src/pikit/channel-telegram-webhook/index.ts";\n');
    expect(lists()).toEqual({
      object: [...preset.object, "secretsCloudflare", "channelTelegramWebhook", "submissionsSql", "outboundDurable"],
      worker: ["secretsCloudflare", "channelTelegramWebhookWorker"],
    });
    const manifest = JSON.parse(readFileSync(join(project, "pikit.json"), "utf8"));
    expect(manifest.components["channel-telegram-webhook"].hooks).toEqual({ afterDeploy: "src/pikit/channel-telegram-webhook/deploy.ts" });
    expect(manifest.components["submissions-sql"].installedFor).toEqual(["channel-telegram-webhook"]);

    // The project installs (the add ran `bun install`), typechecks with both halves imported, and passes its tests.
    expect(existsSync(join(project, "node_modules", "typebox"))).toBe(true);
    const typecheck = await run([process.execPath, "run", "typecheck"]);
    expect(typecheck.err + typecheck.out).not.toContain("error TS");
    expect(typecheck.code).toBe(0);
    const tests = await run([process.execPath, "test"]);
    expect(tests.err).toContain(" 0 fail");
    expect(tests.err).toContain("channel-telegram-webhook.test.ts");
    expect(tests.code).toBe(0);

    // remove undoes both Apps, and what came for it; the app composes again (--force: it does not now).
    const removed = await run([process.execPath, MAIN, "remove", "channel-telegram-webhook", "--force"]);
    expect(removed.err).not.toContain("\u2717");
    expect(removed.code).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(withSecrets);
    expect(Object.keys(JSON.parse(readFileSync(join(project, "pikit.json"), "utf8")).components)).not.toContain("submissions-sql");
    expect((await run([process.execPath, MAIN, "remove", "secrets-cloudflare"])).code).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect((await run([process.execPath, MAIN, "doctor"])).out).toContain("pikit doctor: green");
  },
  TIMEOUT,
);

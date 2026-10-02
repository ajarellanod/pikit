/**
 * A project on Cloudflare, end to end on this machine (SPEC §4.1): `pikit new --target cloudflare
 * --preset cloudflare-minimal`, `pikit doctor`, the project's own tests (with its `wrangler deploy
 * --dry-run`) and typecheck, then `pikit dev` (wrangler dev, workerd) answering `/health` from the
 * object's App. Then a Telegram agent on Cloudflare: `pikit add` of secrets-cloudflare and
 * platform-cloudflare (both in both Apps), provider-openrouter (the starter agent's model on Cloudflare
 * is already OpenRouter's: the Anthropic provider is server-only), runtime-pi, conversations-kv and channel-telegram-webhook (with what they offer)
 * put each half in its App (C1), every add is green, the project installs, typechecks and passes its
 * tests, and `pikit remove` undoes both Apps. wrangler is deployment-cloudflare's dev dependency: removing
 * the component takes it out, and adding it back puts it back, bundling again. Nothing reaches a
 * Cloudflare account: `pikit up` is never run.
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
    // wrangler comes with deployment-cloudflare, which declares it: the starter adds none.
    expect(JSON.parse(readFileSync(join(project, "pikit.json"), "utf8")).components["deployment-cloudflare"].devDependencies).toEqual({ wrangler: "4.143.0" });
    expect(devDependencies().wrangler).toBe("4.143.0");
    expect(existsSync(join(project, "node_modules", ".bin", "wrangler"))).toBe(true);

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

/** The project's package.json devDependencies. */
function devDependencies(): Record<string, string> {
  return JSON.parse(readFileSync(join(project, "package.json"), "utf8")).devDependencies ?? {};
}

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

/** `pikit add <name> --yes`, which must install it and leave `pikit doctor` green. */
async function add(name: string) {
  const added = await run([process.execPath, MAIN, "add", name, "--yes"]);
  expect(added.err).not.toContain("\u2717");
  expect(added.out + added.err).toContain(`${name} installed; \`pikit doctor\` is green`);
  expect(added.code).toBe(0);
  return added;
}

test.skipIf(!E2E)(
  "a Telegram agent on Cloudflare: each add puts each half in its App, with what it offers, and is green; the project installs, typechecks and passes its tests; remove undoes both Apps",
  async () => {
    const configPath = join(project, "pikit.config.ts");
    const agentPath = join(project, "src", "agents", "assistant", "agent.ts");
    const before = readFileSync(configPath, "utf8");
    const agentBefore = readFileSync(agentPath, "utf8");
    const preset = lists();

    // secrets-cloudflare and platform-cloudflare work in both Apps: each goes in both.
    await add("secrets-cloudflare");
    expect(lists()).toEqual({ object: [...preset.object, "secretsCloudflare"], worker: ["secretsCloudflare"] });
    await add("platform-cloudflare");
    expect(lists()).toEqual({ object: [...preset.object, "secretsCloudflare", "platformCloudflare"], worker: ["secretsCloudflare", "platformCloudflare"] });

    // The provider of the starter's model, which on Cloudflare is one that runs there.
    expect(agentBefore).toContain('model: "openrouter/z-ai/glm-5.3-flash"');
    await add("provider-openrouter");
    // The runtime, with what it offers: the record of submissions (storage-do has its storage).
    const runtime = await add("runtime-pi");
    expect(runtime.out).toContain("submissions-sql, for runtime-pi (agent.submissions)");
    // The registry, which creates conversations through the runtime's agent.conversations.
    await add("conversations-kv");

    // The channel: its object half needs actor.inbox and wakeups (platform-cloudflare), the runtime and
    // the rest in the object's App; its Worker half, actor.mailbox (platform-cloudflare) in the Worker's.
    const channel = await add("channel-telegram-webhook");
    expect(channel.out).toContain("outbound-durable, for channel-telegram-webhook (outbound.queue)");
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain('import channelTelegramWebhook, { worker as channelTelegramWebhookWorker } from "./src/pikit/channel-telegram-webhook/index.ts";\n');
    expect(lists()).toEqual({
      object: [
        ...preset.object,
        "secretsCloudflare",
        "platformCloudflare",
        "providerOpenrouter",
        "runtimePi",
        "submissionsSql",
        "conversationsKv",
        "channelTelegramWebhook",
        "outboundDurable",
      ],
      worker: ["secretsCloudflare", "platformCloudflare", "channelTelegramWebhookWorker"],
    });
    const manifest = JSON.parse(readFileSync(join(project, "pikit.json"), "utf8"));
    expect(manifest.components["channel-telegram-webhook"].hooks).toEqual({ afterDeploy: "src/pikit/channel-telegram-webhook/deploy.ts" });
    expect(manifest.components["submissions-sql"].installedFor).toEqual(["runtime-pi"]);
    expect(manifest.components["outbound-durable"].installedFor).toEqual(["channel-telegram-webhook"]);

    // The project installs (each add ran `bun install`), typechecks with both halves imported, and passes its tests.
    expect(existsSync(join(project, "node_modules", "typebox"))).toBe(true);
    const typecheck = await run([process.execPath, "run", "typecheck"]);
    expect(typecheck.err + typecheck.out).not.toContain("error TS");
    expect(typecheck.code).toBe(0);
    const tests = await run([process.execPath, "test"]);
    expect(tests.err).toContain(" 0 fail");
    expect(tests.err).toContain("channel-telegram-webhook.test.ts");
    expect(tests.err).toContain("platform-cloudflare.test.ts");
    expect(tests.err).toContain("runtime-pi.test.ts");
    expect(tests.code).toBe(0);

    // remove undoes both Apps, and what came for each; the project is the preset's again, and green.
    for (const name of ["channel-telegram-webhook", "conversations-kv", "runtime-pi", "provider-openrouter", "platform-cloudflare", "secrets-cloudflare"]) {
      const removed = await run([process.execPath, MAIN, "remove", name]);
      expect(removed.err).not.toContain("\u2717");
      expect(removed.code).toBe(0);
    }
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(Object.keys(JSON.parse(readFileSync(join(project, "pikit.json"), "utf8")).components).sort()).toEqual(
      ["deployment-cloudflare", "storage-do", "storage-kv-sql"],
    );
    expect(readFileSync(agentPath, "utf8")).toBe(agentBefore);
    expect((await run([process.execPath, MAIN, "doctor"])).out).toContain("pikit doctor: green");
  },
  TIMEOUT,
);

test.skipIf(!E2E)(
  "wrangler is deployment-cloudflare's: remove takes it out of devDependencies, and add puts it back and the Worker bundles again",
  async () => {
    const removed = await run([process.execPath, MAIN, "remove", "deployment-cloudflare"]);
    expect(removed.err).not.toContain("\u2717");
    expect(removed.out).toContain("the npm packages only it used: wrangler");
    expect(removed.code).toBe(0);
    expect(devDependencies()).toEqual({ "@types/bun": expect.any(String), typescript: expect.any(String) });
    // `bun install` ran: the lockfile has no wrangler. (Bun leaves the hoisted copy in node_modules.)
    expect(readFileSync(join(project, "bun.lock"), "utf8")).not.toContain('"wrangler"');
    expect(existsSync(join(project, "wrangler.jsonc"))).toBe(false);

    // Added to an existing project, it brings its wrangler itself.
    const added = await add("deployment-cloudflare");
    expect(added.out).toContain("npm (dev): wrangler@4.143.0");
    expect(devDependencies().wrangler).toBe("4.143.0");
    expect(readFileSync(join(project, "bun.lock"), "utf8")).toContain('"wrangler": "4.143.0"');
    // Its tests bundle the Worker with that wrangler (`wrangler deploy --dry-run`).
    const tests = await run([process.execPath, "test", "src/pikit/deployment-cloudflare"]);
    expect(tests.err).toContain("bundle.test.ts");
    expect(tests.err).toContain(" 0 fail");
    expect(tests.code).toBe(0);
  },
  TIMEOUT,
);

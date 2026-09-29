/**
 * `pikit up` on Cloudflare registers the Telegram webhook once the new version answers (SPEC §4.1, C8):
 * deployment-cloudflare's `up`, with a fake wrangler and a fake `/health`, runs the `afterDeploy` hook
 * that channel-telegram-webhook's `component.json` names and `pikit add` records in `pikit.json`,
 * against the channel's fake Telegram. No Cloudflare account, no Telegram. And before it bundles, it
 * runs tool-mcp's `beforeDeploy`, which writes the seed of the MCP servers' tools, against a fake MCP
 * server.
 *
 * The project is the smallest one that holds both: the channel's installed files (linked from the
 * registry), a two-App `pikit.config.ts` on the repository's `@pikit/core`, `pikit.json` and `.env`.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Runner, up } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/commands.ts";
import {
  type FakeTelegram,
  startFakeTelegram,
} from "../../../registry/components/channel-telegram-webhook/files/src/pikit/channel-telegram-webhook/fake-telegram.test-support.ts";
import { createFakeMcpServer } from "../../pi-adapter/src/mcp/testing.ts";
import { PACKAGES_DIR, PIKIT_ROOT } from "./paths.ts";

const CHANNEL = "channel-telegram-webhook";
const SECRET = "a-good-webhook-secret-0123456789";
const URL = "https://edge-bot.acme.workers.dev";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const fakes: FakeTelegram[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop();
});

function project(telegram: FakeTelegram, env: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-deploy-hooks-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "edge-bot" }));
  writeFileSync(join(dir, ".env"), env);
  // As `pikit add channel-telegram-webhook` records it (the manifest's hooks.afterDeploy, by project path).
  const manifest = JSON.parse(readFileSync(join(PIKIT_ROOT, "registry", "components", CHANNEL, "component.json"), "utf8")) as { hooks: { afterDeploy: string } };
  const components = { [CHANNEL]: { hooks: { afterDeploy: `src/pikit/${CHANNEL}/${manifest.hooks.afterDeploy}` } }, "storage-do": {} };
  writeFileSync(join(dir, "pikit.json"), JSON.stringify({ version: 2, targets: ["cloudflare"], registries: { default: "builtin" }, components }));
  mkdirSync(join(dir, "src", "pikit"), { recursive: true });
  symlinkSync(join(PIKIT_ROOT, "registry", "components", CHANNEL, "files", "src", "pikit", CHANNEL), join(dir, "src", "pikit", CHANNEL));
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  symlinkSync(join(PACKAGES_DIR, "core"), join(dir, "node_modules", "@pikit", "core"));
  writeFileSync(
    join(dir, "pikit.config.ts"),
    `import { defineApp } from "@pikit/core";
import channelTelegramWebhook, { worker as channelTelegramWebhookWorker } from "./src/pikit/${CHANNEL}/index.ts";

export const config = {
  "${CHANNEL}": { apiBase: "${telegram.url}" },
};

export default defineApp({
  components: [
    channelTelegramWebhook,
  ],
  config,
});

export const workerConfig = {
  "${CHANNEL}-worker": { apiBase: "${telegram.url}" },
};

export const worker = defineApp({
  components: [
    channelTelegramWebhookWorker,
  ],
  config: workerConfig,
});
`,
  );
  return dir;
}

/** Logged in; `wrangler deploy` succeeds with version v2 at URL; nothing else runs. */
const wrangler: Runner = async (command, { env }) => {
  if (command[1] === "whoami") return { code: 0, stdout: JSON.stringify({ loggedIn: true }) };
  const output = env?.WRANGLER_OUTPUT_FILE_PATH;
  if (command[1] === "deploy" && output !== undefined) writeFileSync(output, `${JSON.stringify({ type: "deploy", version_id: "v2", targets: [URL] })}\n`);
  return { code: 0, stdout: "" };
};

/** `/health` answers the previous version first, then v2; notes whether a webhook was set by each answer. */
function health(telegram: FakeTelegram) {
  const answers = [{ ok: true, version: "v1" }, { ok: true, version: "v2" }];
  const webhooksSetBefore: number[] = [];
  const fetcher = (async () => {
    webhooksSetBefore.push(telegram.webhooksSet);
    return Response.json(answers.length > 1 ? answers.shift() : answers[0]);
  }) as unknown as typeof fetch;
  return { fetcher, webhooksSetBefore };
}

test("pikit up registers the bot's webhook at the deployed URL, with its secret, once the new version answers", async () => {
  const telegram = startFakeTelegram();
  fakes.push(telegram);
  const cwd = project(telegram, `TELEGRAM_BOT_TOKEN=${telegram.token}\nTELEGRAM_ALLOWED_USERS=1001\nTELEGRAM_WEBHOOK_SECRET=${SECRET}\n`);
  const probe = health(telegram);
  const said: string[] = [];

  const deployed = await up({ cwd, run: wrangler, fetch: probe.fetcher, intervalMs: 1, say: (line) => said.push(line) });

  expect(deployed).toEqual({ version: "v2", url: URL });
  // Nothing was registered while the previous version answered (C8).
  expect(probe.webhooksSetBefore).toEqual([0, 0]);
  expect([telegram.webhookUrl, telegram.webhookSecret, telegram.allowedUpdates, telegram.webhooksSet]).toEqual([`${URL}/telegram`, SECRET, ["message"], 1]);
  expect(said).toEqual([`✓ Telegram telegram: webhook ${URL}/telegram`]);
});

test("pikit up fails with what the webhook's registration reports, and names the component", async () => {
  const telegram = startFakeTelegram();
  fakes.push(telegram);
  const cwd = project(telegram, `TELEGRAM_BOT_TOKEN=${telegram.token}\nTELEGRAM_ALLOWED_USERS=1001\n`);

  await expect(up({ cwd, run: wrangler, fetch: health(telegram).fetcher, intervalMs: 1, say: () => {} })).rejects.toThrow(
    `the new version v2 answers at ${URL}, but what runs after a deploy failed:\n  ${CHANNEL}: telegram: TELEGRAM_WEBHOOK_SECRET is not set; run \`pikit configure\`, then \`pikit up\` again\n`,
  );
  expect(telegram.webhookUrl).toBe("");
});

const TOOL_MCP = join(PIKIT_ROOT, "registry", "components", "tool-mcp");

/**
 * A project with tool-mcp installed (its files copied: `beforeDeploy` writes one of them), its hooks
 * recorded as `pikit add` records them, one server at `url`, and the repository's packages.
 */
function mcpProject(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-deploy-seed-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mcp-bot" }));
  const manifest = JSON.parse(readFileSync(join(TOOL_MCP, "component.json"), "utf8")) as { hooks: Record<string, string> };
  const hooks = Object.fromEntries(Object.entries(manifest.hooks).map(([hook, file]) => [hook, `src/pikit/tool-mcp/${file}`]));
  writeFileSync(join(dir, "pikit.json"), JSON.stringify({ version: 2, targets: ["cloudflare"], registries: { default: "builtin" }, components: { "tool-mcp": { hooks } } }));
  cpSync(join(TOOL_MCP, "files", "src"), join(dir, "src"), { recursive: true });
  symlinkSync(join(PIKIT_ROOT, "node_modules"), join(dir, "node_modules"));
  writeFileSync(
    join(dir, "pikit.config.ts"),
    `import { defineApp } from "@pikit/core";
import toolMcp from "./src/pikit/tool-mcp/index.ts";

export default defineApp({
  components: [toolMcp],
  config: { "tool-mcp": { servers: { wiki: { url: "${url}", tools: ["ask_question"] } } } },
});
`,
  );
  return dir;
}

const MCP_TOOLS = [
  { name: "ask_question", description: "Asks a question about a repository.", inputSchema: { type: "object", properties: { repoName: { type: "string" } } } },
  { name: "open_issue", inputSchema: { type: "object" } },
];

test("pikit up writes the MCP servers' tools into tool-mcp's seed.ts before it bundles, and a server that is down stops it first", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createFakeMcpServer({ tools: MCP_TOOLS }).fetch });
  const url = `http://127.0.0.1:${server.port}/mcp`;
  const cwd = mcpProject(url);
  const seedPath = join(cwd, "src", "pikit", "tool-mcp", "seed.ts");
  const deployed: string[] = [];
  const run: Runner = async (command, options) => {
    if (command[1] === "deploy") deployed.push(readFileSync(seedPath, "utf8"));
    return wrangler(command, options);
  };
  const said: string[] = [];
  try {
    await up({ cwd, run, fetch: (async () => Response.json({ ok: true, version: "v2" })) as unknown as typeof fetch, say: (line) => said.push(line) });
  } finally {
    await server.stop(true);
  }
  expect(said).toEqual(["✓ tool-mcp: the tools of 1 MCP server in src/pikit/tool-mcp/seed.ts (changed: commit it)"]);
  // What wrangler bundled: the seed, with the named tool only.
  expect(deployed).toHaveLength(1);
  expect(deployed[0]).toContain('"description": "Asks a question about a repository."');
  const { seed } = (await import(`${seedPath}?after-up`)) as { seed: unknown };
  expect(seed).toEqual({ wiki: { url, tools: { ask_question: MCP_TOOLS[0] } } });

  // The server is down now: up stops before wrangler, and the seed stays as it was.
  await expect(up({ cwd, run, fetch: (async () => Response.json({ ok: true, version: "v2" })) as unknown as typeof fetch, say: () => {} })).rejects.toThrow(
    `what runs before a deploy failed, so nothing was deployed:\n  tool-mcp: the MCP server "wiki" (${url}) could not list its tools`,
  );
  expect(deployed).toHaveLength(1);
  expect(readFileSync(seedPath, "utf8")).toContain("Asks a question about a repository.");
});

test("tool-mcp's seed.ts, as installed, is what beforeDeploy writes for no server", async () => {
  const { seedModule } = await import(join(TOOL_MCP, "files", "src", "pikit", "tool-mcp", "deploy.ts"));
  expect(readFileSync(join(TOOL_MCP, "files", "src", "pikit", "tool-mcp", "seed.ts"), "utf8")).toBe((seedModule as (seed: object) => string)({}));
});

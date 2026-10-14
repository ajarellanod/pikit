/**
 * The component's step of `pikit configure`, with a scripted person (`io`) and the local stand-in of
 * Cloudflare's API: the values asked and checked, the tunnel made on a yes with the token typed once and
 * never stored, nothing asked without a terminal.
 */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { channelRoutes, configure, type ConfigureIO, uncovered } from "./configure.ts";
import { fakeCloudflare, type FakeCloudflare } from "./fake-cloudflare.test-support.ts";

const API_TOKEN = "cf-api-token-secret";
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

let cf: FakeCloudflare;
const shellToken = process.env.CLOUDFLARE_API_TOKEN;
beforeEach(() => {
  cf = fakeCloudflare({ token: API_TOKEN, zones: [{ id: "zone-1", name: "example.com", account: "account-1" }] });
  delete process.env.CLOUDFLARE_API_TOKEN;
});
afterEach(() => {
  cf.stop();
  if (shellToken !== undefined) process.env.CLOUDFLARE_API_TOKEN = shellToken;
});

/** A project with `.env`, and a person who answers `answers` in order (`confirms` for yes or no). */
function person(env: string, answers: string[], options: { interactive?: boolean; confirms?: boolean[]; secrets?: string[] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pikit-expose-configure-"));
  dirs.push(cwd);
  writeFileSync(join(cwd, ".env"), env);
  const read = () => parseEnv(readFileSync(join(cwd, ".env"), "utf8"));
  const said: string[] = [];
  const asked: string[] = [];
  const confirmed: { message: string; initial: boolean }[] = [];
  const secrets = [...(options.secrets ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const io: ConfigureIO = {
    interactive: options.interactive ?? true,
    config: {},
    get: (name) => read()[name],
    set: (name, value) => {
      const env = { ...read(), [name]: value };
      writeFileSync(join(cwd, ".env"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    },
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? "";
    },
    askSecret: async (question) => {
      asked.push(question);
      return secrets.shift() ?? "";
    },
    confirm: async (message, initial) => {
      confirmed.push({ message, initial });
      return confirms.shift() ?? initial;
    },
    say: (line) => said.push(line),
  };
  return { cwd, io, read, said, asked, confirmed };
}

test("asks the hostname and the paths, checking each answer; on yes, makes the tunnel with a token typed once and never stored", async () => {
  const p = person("MODEL_KEY=x\n", ["https://bot.example.com", "Bot.example.com", "googlechat", "/googlechat"], { secrets: [API_TOKEN] });
  expect(await configure(p.io, { cwd: p.cwd, api: { base: cf.base } })).toEqual([]);

  expect(p.asked.map((q) => q.split(":")[0])).toEqual([
    "CLOUDFLARE_TUNNEL_HOSTNAME",
    "CLOUDFLARE_TUNNEL_HOSTNAME",
    "PIKIT_EXPOSE_PATHS",
    "PIKIT_EXPOSE_PATHS",
    "Cloudflare API token (Account > Cloudflare Tunnel > Edit, and Zone > DNS > Edit on the hostname's zone; used now, never stored)",
  ]);
  expect(p.said).toContain('✗ CLOUDFLARE_TUNNEL_HOSTNAME "https://bot.example.com" is not a hostname (bot.example.com: no scheme, no path)');
  expect(p.said).toContain('✗ PIKIT_EXPOSE_PATHS: "googlechat" is not a path (/googlechat) or a prefix (/hooks/*)');
  expect(p.confirmed).toEqual([{ message: "Create the Cloudflare Tunnel for https://Bot.example.com now? It needs a Cloudflare API token, used now and never stored", initial: true }]);

  expect(cf.tunnels.map((t) => t.name)).toEqual(["pikit-bot.example.com"]);
  expect(existsSync(join(p.cwd, ".env.cloudflared"))).toBe(true);
  expect(p.read()).toEqual({ MODEL_KEY: "x", CLOUDFLARE_TUNNEL_HOSTNAME: "Bot.example.com", PIKIT_EXPOSE_PATHS: "/googlechat", PIKIT_PUBLIC_URL: "https://bot.example.com" });
  expect([...p.said, readFileSync(join(p.cwd, ".env"), "utf8")].join("\n")).not.toContain(API_TOKEN);
});

test("values already set are kept; a tunnel already made is updated only when asked, by default when a value changed", async () => {
  const env = "CLOUDFLARE_TUNNEL_HOSTNAME=bot.example.com\nPIKIT_EXPOSE_PATHS=/googlechat\n";
  const first = person(env, [], { secrets: [API_TOKEN] });
  await configure(first.io, { cwd: first.cwd, api: { base: cf.base } });
  expect(first.asked).toHaveLength(1);
  const writes = cf.writes.length;

  // Run again in the same project: nothing changed, so the default is no; the person says no.
  const again = { ...first.io, confirm: async (message: string, initial: boolean) => ((againAsked = { message, initial }), false) };
  let againAsked: { message: string; initial: boolean } | undefined;
  expect(await configure(again, { cwd: first.cwd, api: { base: cf.base } })).toEqual([]);
  expect(againAsked).toEqual({ message: "Update the Cloudflare Tunnel of https://bot.example.com now?", initial: false });
  expect(first.said.at(-1)).toBe("  the tunnel: unchanged (`pikit expose` updates it)");
  expect(cf.writes.length).toBe(writes);
});

test("declined: nothing reaches Cloudflare, and it says how to make the tunnel later", async () => {
  const p = person("", ["bot.example.com", "/googlechat"], { confirms: [false] });
  expect(await configure(p.io, { cwd: p.cwd, api: { base: cf.base } })).toEqual([]);
  expect(p.said.at(-1)).toBe("  the tunnel: run `pikit expose` when you are ready");
  expect(cf.writes).toEqual([]);
  expect(p.asked.some((q) => q.startsWith("Cloudflare API token"))).toBe(false);
});

test("a refused token is what is left to configure; the values stay", async () => {
  const p = person("", ["bot.example.com", "/googlechat"], { secrets: ["x".repeat(40)] });
  const left = await configure(p.io, { cwd: p.cwd, api: { base: cf.base } });
  expect(left[0]).toStartWith("Cloudflare refused the API token");
  expect(p.read()).toEqual({ CLOUDFLARE_TUNNEL_HOSTNAME: "bot.example.com", PIKIT_EXPOSE_PATHS: "/googlechat" });
});

/** The App's routes, as `describe()` gives `http.route`'s keys: two channels' and the dashboard's. */
const ROUTES = { "POST /googlechat": "channel-google-chat", "GET /admin/*": "admin-api", "POST /whatsapp/:account": "channel-whatsapp", "GET /": "tool-home" };

test("the proposal is the channels' routes as public paths: a parameter becomes a prefix, the dashboard's never", () => {
  expect(channelRoutes(ROUTES)).toEqual([
    { key: "POST /googlechat", component: "channel-google-chat", path: "/googlechat" },
    { key: "POST /whatsapp/:account", component: "channel-whatsapp", path: "/whatsapp/*" },
  ]);
  expect(channelRoutes({ "POST /:token": "channel-a", "GET /hooks/*": "channel-b" }).map((route) => route.path)).toEqual(["/*", "/hooks/*"]);
  const channels = channelRoutes(ROUTES);
  expect(uncovered(channels, ["/googlechat"]).map((route) => route.key)).toEqual(["POST /whatsapp/:account"]);
  expect(uncovered(channels, ["/googlechat", "/whatsapp/*"])).toEqual([]);
  expect(uncovered(channels, ["/*"])).toEqual([]);
});

test("Enter takes the installed channels' paths, said first with their components", async () => {
  const p = person("", ["bot.example.com", ""], { confirms: [false] });
  expect(await configure(p.io, { cwd: p.cwd, api: { base: cf.base }, routes: ROUTES })).toEqual([]);
  expect(p.said).toContain("  The installed channels receive: POST /googlechat (channel-google-chat), POST /whatsapp/:account (channel-whatsapp)");
  expect(p.asked[1]).toEndWith(". Enter: /googlechat,/whatsapp/*");
  expect(p.read().PIKIT_EXPOSE_PATHS).toBe("/googlechat,/whatsapp/*");
  expect(p.said.some((line) => line.includes("not public"))).toBe(false);
});

test("kept paths that leave a channel's route out are said; a typed answer wins over the proposal", async () => {
  const kept = person("CLOUDFLARE_TUNNEL_HOSTNAME=bot.example.com\nPIKIT_EXPOSE_PATHS=/googlechat\n", [], { confirms: [false] });
  await configure(kept.io, { cwd: kept.cwd, api: { base: cf.base }, routes: ROUTES });
  expect(kept.said).toContain("  not public (not in PIKIT_EXPOSE_PATHS): POST /whatsapp/:account (channel-whatsapp)");
  expect(kept.said.some((line) => line.startsWith("  The installed channels receive"))).toBe(false);

  const typed = person("", ["bot.example.com", "/googlechat"], { confirms: [false] });
  await configure(typed.io, { cwd: typed.cwd, api: { base: cf.base }, routes: ROUTES });
  expect(typed.read().PIKIT_EXPOSE_PATHS).toBe("/googlechat");
  expect(typed.said).toContain("  not public (not in PIKIT_EXPOSE_PATHS): POST /whatsapp/:account (channel-whatsapp)");
});

test("the routes come from pikit.config.ts, created and described; one that does not compose proposes nothing", async () => {
  const p = person("", ["bot.example.com", "", "", ""], { confirms: [false] });
  const describe = { capabilities: { "http.route": { keys: { "POST /googlechat": "channel-google-chat" } } } };
  writeFileSync(join(p.cwd, "pikit.config.ts"), `export default { create: async () => ({ describe: () => (${JSON.stringify(describe)}) }) };\n`);
  await configure(p.io, { cwd: p.cwd, api: { base: cf.base } });
  expect(p.read().PIKIT_EXPOSE_PATHS).toBe("/googlechat");

  const broken = person("", ["bot.example.com", "", "", ""], { confirms: [false] });
  writeFileSync(join(broken.cwd, "pikit.config.ts"), "export default { create: async () => { throw new Error('no router'); } };\n");
  expect(await configure(broken.io, { cwd: broken.cwd, api: { base: cf.base } })).toEqual([
    "PIKIT_EXPOSE_PATHS is required and not set: run `pikit configure` again, or set it in .env",
  ]);
  expect(broken.asked[1]).not.toContain("Enter:");
});

test("without a terminal it asks nothing: missing values are said, set ones kept, the tunnel left to pikit expose", async () => {
  const empty = person("", [], { interactive: false });
  expect(await configure(empty.io, { cwd: empty.cwd, api: { base: cf.base } })).toEqual([
    "CLOUDFLARE_TUNNEL_HOSTNAME is required and not set: export it, or run `pikit configure` in a terminal",
    "PIKIT_EXPOSE_PATHS is required and not set: export it, or run `pikit configure` in a terminal",
  ]);
  const proposed = person("CLOUDFLARE_TUNNEL_HOSTNAME=bot.example.com\n", [], { interactive: false });
  expect(await configure(proposed.io, { cwd: proposed.cwd, api: { base: cf.base }, routes: ROUTES })).toEqual([
    "PIKIT_EXPOSE_PATHS is required and not set (the installed channels': /googlechat,/whatsapp/*): export it, or run `pikit configure` in a terminal",
  ]);
  const set = person("CLOUDFLARE_TUNNEL_HOSTNAME=bot.example.com\nPIKIT_EXPOSE_PATHS=/googlechat\n", [], { interactive: false });
  expect(await configure(set.io, { cwd: set.cwd, api: { base: cf.base } })).toEqual([]);
  expect(set.said.at(-1)).toBe("  the tunnel: run `pikit expose` to create it (it asks for a Cloudflare API token, never stored)");
  expect([...empty.asked, ...set.asked]).toEqual([]);
  expect(cf.writes).toEqual([]);
});

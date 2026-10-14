/**
 * `pikit expose` against a local stand-in of Cloudflare's API (`fake-cloudflare.test-support.ts`) and a
 * fake `cloudflared`: no account, no network, no Docker.
 */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { doctor } from "./doctor.ts";
import { command, expose, type ExposeContext, quick, remove, status } from "./expose.ts";
import { fakeCloudflare, type FakeCloudflare } from "./fake-cloudflare.test-support.ts";
import { ingressRules, pathPattern, readSettings } from "./project.ts";

const API_TOKEN = "cf-api-token-secret";
const ZONE = { id: "zone-1", name: "example.com", account: "account-1" };

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

let cf: FakeCloudflare;
beforeEach(() => {
  cf = fakeCloudflare({ token: API_TOKEN, zones: [ZONE] });
});
afterEach(() => cf.stop());

/** A project directory with `.env`, and the context `pikit expose` runs with there (`token` null: none to use). */
function project(env: string, token: string | null = API_TOKEN) {
  const cwd = mkdtempSync(join(tmpdir(), "pikit-expose-"));
  dirs.push(cwd);
  writeFileSync(join(cwd, ".env"), env);
  const said: string[] = [];
  const asked: number[] = [];
  const context: ExposeContext = {
    cwd,
    get: (name) => parseEnv(readFileSync(join(cwd, ".env"), "utf8"))[name],
    say: (line) => said.push(line),
    apiToken: async () => {
      asked.push(1);
      return token ?? undefined;
    },
    api: { base: cf.base },
  };
  return { cwd, context, said, asked, env: () => parseEnv(readFileSync(join(cwd, ".env"), "utf8")) };
}

const SETTINGS = "CLOUDFLARE_TUNNEL_HOSTNAME=bot.example.com\nPIKIT_EXPOSE_PATHS=/googlechat, /hooks/*\n";

test("expose makes the tunnel, its routes, the DNS record and the token file once; a second run writes nothing", async () => {
  const p = project(`MODEL_KEY=x\n${SETTINGS}`);
  expect(await expose(p.context)).toEqual([]);

  const [tunnel] = cf.tunnels;
  expect(tunnel?.name).toBe("pikit-bot.example.com");
  expect(tunnel?.ingress).toEqual([
    { hostname: "bot.example.com", path: "^/health$", service: "http://app:3000" },
    { hostname: "bot.example.com", path: "^/googlechat$", service: "http://app:3000" },
    { hostname: "bot.example.com", path: "^/hooks(/.*)?$", service: "http://app:3000" },
    { service: "http_status:404" },
  ]);
  expect(cf.records.get(ZONE.id)).toEqual([
    { id: expect.any(String), type: "CNAME", name: "bot.example.com", content: `${tunnel?.id}.cfargotunnel.com`, proxied: true, comment: "pikit expose: pikit-bot.example.com" },
  ]);
  const tokenFile = join(p.cwd, ".env.cloudflared");
  expect(parseEnv(readFileSync(tokenFile, "utf8")).TUNNEL_TOKEN).toBe(cf.tokenOf(tunnel?.id ?? ""));
  expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  expect(p.env()).toEqual({ MODEL_KEY: "x", CLOUDFLARE_TUNNEL_HOSTNAME: "bot.example.com", PIKIT_EXPOSE_PATHS: "/googlechat, /hooks/*", PIKIT_PUBLIC_URL: "https://bot.example.com" });
  expect(p.said).toContain("https://bot.example.com");

  const writes = cf.writes.length;
  expect(await expose(p.context)).toEqual([]);
  expect(cf.writes.length).toBe(writes);
  expect(cf.tunnels).toHaveLength(1);
});

test("changed paths update the routes only", async () => {
  const p = project(SETTINGS);
  await expose(p.context);
  const before = cf.writes.length;
  writeFileSync(join(p.cwd, ".env"), "CLOUDFLARE_TUNNEL_HOSTNAME=bot.example.com\nPIKIT_EXPOSE_PATHS=/googlechat\n");
  expect(await expose(p.context)).toEqual([]);
  expect(cf.writes.slice(before)).toEqual([`PUT /accounts/account-1/cfd_tunnel/${cf.tunnels[0]?.id}/configurations`]);
  expect(cf.tunnels[0]?.ingress?.map((rule) => rule.path)).toEqual(["^/health$", "^/googlechat$", undefined]);
});

test("a DNS record of the hostname it did not make stops it before any write", async () => {
  cf.records.get(ZONE.id)?.push({ id: "r1", type: "A", name: "bot.example.com", content: "203.0.113.7", proxied: false });
  const p = project(SETTINGS);
  expect(await expose(p.context)).toEqual([
    "bot.example.com already has DNS records pikit expose did not make (A 203.0.113.7): remove them in Cloudflare, or choose another CLOUDFLARE_TUNNEL_HOSTNAME",
  ]);
  expect(cf.writes).toEqual([]);
  expect(existsSync(join(p.cwd, ".env.cloudflared"))).toBe(false);
});

test("its own record pointing at a deleted tunnel is moved to the new one", async () => {
  const p = project(SETTINGS);
  await expose(p.context);
  const old = cf.tunnels[0];
  if (old !== undefined) old.deleted = true;
  expect(await expose(p.context)).toEqual([]);
  expect(cf.records.get(ZONE.id)?.map((record) => record.content)).toEqual([`${cf.tunnels[1]?.id}.cfargotunnel.com`]);
});

test("a refused token, a hostname on no zone of the account, and no token at all are told; nothing is written", async () => {
  const unknown = "x".repeat(40);
  const [problem] = await expose(project(SETTINGS, unknown).context);
  expect(problem).toContain("Cloudflare refused the API token (GET /zones: HTTP 403, Authentication error (10000)): it needs Account > Cloudflare Tunnel > Edit");
  expect(problem).not.toContain(unknown);
  // A malformed token is a 400 at Cloudflare, refused all the same.
  const [malformed] = await expose(project(SETTINGS, "bogus").context);
  expect(malformed).toContain("Cloudflare refused the API token (GET /zones: HTTP 400, Invalid request headers (6003)): it needs");

  const elsewhere = project("CLOUDFLARE_TUNNEL_HOSTNAME=bot.other.org\nPIKIT_EXPOSE_PATHS=/a\n");
  expect((await expose(elsewhere.context))[0]).toStartWith("no zone of this token's account holds bot.other.org");

  const none = project(SETTINGS, null);
  expect((await expose(none.context))[0]).toStartWith("no Cloudflare API token: set CLOUDFLARE_API_TOKEN in the shell (not in .env)");
  expect(cf.writes).toEqual([]);
});

test("CLOUDFLARE_API_TOKEN in .env is refused before any token is asked or any call made", async () => {
  const p = project(`${SETTINGS}CLOUDFLARE_API_TOKEN=${API_TOKEN}\n`);
  const problems = await expose(p.context);
  expect(problems[0]).toStartWith("CLOUDFLARE_API_TOKEN is in .env, which the app's container gets");
  expect(p.asked).toEqual([]);
  expect(cf.writes).toEqual([]);
});

test("no token reaches what it says or writes to .env", async () => {
  const p = project(SETTINGS);
  const problems = await expose(p.context);
  const tunnelToken = cf.tokenOf(cf.tunnels[0]?.id ?? "");
  const out = [...p.said, ...problems, readFileSync(join(p.cwd, ".env"), "utf8")].join("\n");
  expect(out).not.toContain(API_TOKEN);
  expect(out).not.toContain(tunnelToken);
});

test("paths become anchored Go regular expressions; a malformed one or none is refused", () => {
  expect(pathPattern("/googlechat")).toBe("^/googlechat$");
  expect(pathPattern("/v1.0/hook")).toBe("^/v1\\.0/hook$");
  expect(pathPattern("/admin/*")).toBe("^/admin(/.*)?$");
  expect(pathPattern("/*")).toBe("^(/.*)?$");
  expect(pathPattern("/")).toBe("^/$");
  const settings = readSettings((name) => ({ CLOUDFLARE_TUNNEL_HOSTNAME: "Bot.Example.com", PIKIT_EXPOSE_PATHS: "/health,/a" })[name]).settings;
  expect(settings).toEqual({ hostname: "bot.example.com", paths: ["/health", "/a"] });
  expect(ingressRules(settings ?? { hostname: "", paths: [] }).at(-1)).toEqual({ service: "http_status:404" });
  const bad = readSettings((name) => ({ CLOUDFLARE_TUNNEL_HOSTNAME: "https://bot.example.com", PIKIT_EXPOSE_PATHS: "googlechat,/a*/b" })[name]);
  expect(bad.settings).toBeUndefined();
  expect(bad.problems).toEqual([
    'CLOUDFLARE_TUNNEL_HOSTNAME "https://bot.example.com" is not a hostname (bot.example.com: no scheme, no path)',
    'PIKIT_EXPOSE_PATHS: "googlechat" is not a path (/googlechat) or a prefix (/hooks/*)',
    'PIKIT_EXPOSE_PATHS: "/a*/b" is not a path (/googlechat) or a prefix (/hooks/*)',
  ]);
  expect(readSettings(() => undefined).problems.map((problem) => problem.split(":")[0])).toEqual(["CLOUDFLARE_TUNNEL_HOSTNAME is not set", "PIKIT_EXPOSE_PATHS is not set"]);
});

test("status tells the app answering, no connector, routes not this project's, and no tunnel here", async () => {
  const p = project(SETTINGS);
  expect(await status(p.context)).toEqual(["no .env.cloudflared here: run `pikit expose` to create the tunnel"]);
  await expose(p.context);
  const answering = (code: number) => (async () => new Response("", { status: code })) as unknown as typeof fetch;
  expect(await status({ ...p.context, fetch: answering(200) })).toEqual([]);
  expect(p.said).toContain("GET https://bot.example.com/health: 200");
  expect((await status({ ...p.context, fetch: answering(530) }))[0]).toStartWith("Cloudflare reaches no connector of the tunnel");
  expect((await status({ ...p.context, fetch: answering(404) }))[0]).toStartWith("/health answered 404");
  const down = (async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  }) as unknown as typeof fetch;
  expect(await status({ ...p.context, fetch: down })).toEqual(["the app does not answer /health through the tunnel (unreachable (getaddrinfo ENOTFOUND))"]);
});

test("delete asks first, then removes its record, the tunnel (connections first), the token file and the URL", async () => {
  const p = project(SETTINGS);
  await expose(p.context);
  const tunnel = cf.tunnels[0];
  if (tunnel !== undefined) tunnel.connections = [{ id: "c1" }];
  cf.records.get(ZONE.id)?.push({ id: "mx", type: "MX", name: "example.com", content: "mail.example.com" });

  expect(await remove(p.context, { confirm: async () => false })).toEqual(["cancelled"]);
  expect(tunnel?.deleted).toBe(false);
  expect(await remove(p.context)).toEqual(["pikit expose delete asks for confirmation; pass --yes when it runs without a terminal"]);

  let question = "";
  expect(await remove(p.context, { confirm: async (q) => ((question = q), true) })).toEqual([]);
  expect(question).toBe("Delete the tunnel pikit-bot.example.com and the DNS record of bot.example.com? https://bot.example.com stops answering");
  expect(tunnel?.deleted).toBe(true);
  expect(cf.records.get(ZONE.id)?.map((record) => record.type)).toEqual(["MX"]);
  expect(existsSync(join(p.cwd, ".env.cloudflared"))).toBe(false);
  expect(p.env().PIKIT_PUBLIC_URL).toBeUndefined();
  expect(p.env().CLOUDFLARE_TUNNEL_HOSTNAME).toBe("bot.example.com");
});

test("quick prints the temporary URL cloudflared announces, for the given port; a missing cloudflared is told", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-expose-quick-"));
  dirs.push(dir);
  const script = join(dir, "cloudflared.ts");
  const argv = join(dir, "argv.json");
  writeFileSync(
    script,
    `await Bun.write(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)));
console.error("INF Requesting new quick Tunnel on trycloudflare.com...");
console.error("INF |  https://calm-river-1234.trycloudflare.com  |");
`,
  );
  const p = project("");
  expect(await quick(p.context, { port: "4000", cloudflared: [process.execPath, script] })).toEqual([]);
  expect(p.said.at(-1)).toBe("https://calm-river-1234.trycloudflare.com");
  expect(p.said[0]).toStartWith("A temporary tunnel: every path of this machine's app is public while it runs");
  expect(JSON.parse(readFileSync(argv, "utf8"))).toEqual(["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:4000"]);
  expect(existsSync(join(p.cwd, ".env.cloudflared"))).toBe(false);

  expect((await quick(p.context, { cloudflared: ["pikit-no-such-cloudflared"] }))[0]).toStartWith("pikit-no-such-cloudflared is not installed");
  expect(await quick(p.context, { port: "http" })).toEqual(['"http" is not a port']);
});

test("the command takes no other subcommand", async () => {
  const io = { config: async () => ({}), get: () => undefined, say: () => {} };
  for (const args of [["start"], ["status", "now"], ["delete", "--force"], ["quick", "1", "2"]]) {
    expect(await command({ ...io, args })).toEqual(["usage: pikit expose [status | quick [port] | delete [--yes]]"]);
  }
});

test("doctor: a token in .env is a problem, a malformed value too; no tunnel yet is a note", async () => {
  const p = project(`${SETTINGS}CLOUDFLARE_API_TOKEN=x\n`);
  const cwd = process.cwd();
  process.chdir(p.cwd);
  try {
    const found = await doctor({ config: {}, get: p.context.get });
    expect(found.problems).toEqual([
      "CLOUDFLARE_API_TOKEN is in .env, which the app's container gets: take it out, and give it to `pikit expose` from the shell or when asked",
    ]);
    expect(found.notes).toEqual(["no tunnel yet (.env.cloudflared): `pikit configure` or `pikit expose` creates it; `pikit up` cannot start cloudflared before"]);
    writeFileSync(join(p.cwd, ".env"), "CLOUDFLARE_TUNNEL_HOSTNAME=bot\n");
    writeFileSync(join(p.cwd, ".env.cloudflared"), "TUNNEL_TOKEN=t\n");
    // Not set is pikit doctor's own problem (`required`); a malformed one is this hook's.
    expect(await doctor({ config: {}, get: p.context.get })).toEqual({
      problems: ['CLOUDFLARE_TUNNEL_HOSTNAME "bot" is not a hostname (bot.example.com: no scheme, no path)'],
      notes: [],
    });
  } finally {
    process.chdir(cwd);
  }
});

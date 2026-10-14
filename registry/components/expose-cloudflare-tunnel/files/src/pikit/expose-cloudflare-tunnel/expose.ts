/**
 * `pikit expose`: a public HTTPS URL for a server project, by a Cloudflare Tunnel (features/completed/expose.md).
 *
 *   pikit expose               create or reconcile the tunnel, its routes and its DNS record; print the URL
 *   pikit expose status        the tunnel, and GET <url>/health through it
 *   pikit expose quick [port]  a temporary tunnel to this machine's app (pikit dev), until Ctrl-C
 *   pikit expose delete [--yes]  the DNS record and the tunnel
 *
 * component.json declares it (`"commands": { "expose": … }`): the CLI runs `command(io)` in a child
 * process in the project's directory, never in the app. Every step is idempotent, so running it again
 * repairs drift. The Cloudflare API token is read from the shell's `CLOUDFLARE_API_TOKEN`, or asked
 * without echo, and never written anywhere: `.env` reaches the app's container, where the agent runs.
 */

import { spawn } from "node:child_process";
import { cloudflare, type Cloudflare, CloudflareError, type DnsRecord, TOKEN_PERMISSIONS } from "./cloudflare.ts";
import {
  dotEnv,
  hasTunnelToken,
  ingressRules,
  readHostname,
  readSettings,
  recordComment,
  removeTunnelToken,
  setDotEnv,
  TUNNEL_TOKEN_FILE,
  tunnelName,
  unsetDotEnv,
  writeTunnelToken,
} from "./project.ts";
import { askSecret, confirm, interactive } from "./prompt.ts";

const USAGE = "pikit expose [status | quick [port] | delete [--yes]]";

/** What the CLI gives a component's command (`component-command.ts`). */
export interface CommandIO {
  args: readonly string[];
  config(): Promise<Readonly<Record<string, unknown>>>;
  get(name: string): string | undefined;
  say(line: string): void;
}

/** What every subcommand works with; tests give their own. */
export interface ExposeContext {
  /** The project's directory. */
  cwd: string;
  /** A variable of the environment or `.env`: the hostname and the paths. */
  get(name: string): string | undefined;
  say(line: string): void;
  /** The Cloudflare API token, or undefined when there is none to use. Asked only when needed. */
  apiToken(): Promise<string | undefined>;
  /** Cloudflare's API: its base and fetch. */
  api?: { base?: string; fetch?: typeof fetch };
  /** The public probe's fetch (`status`). Default: the global `fetch`. */
  fetch?: typeof fetch;
}

export async function command(io: CommandIO): Promise<string[]> {
  const cwd = process.cwd();
  const context: ExposeContext = { cwd, get: io.get, say: io.say, apiToken: () => apiTokenFromShell(cwd) };
  const [sub, ...rest] = io.args;
  if (sub === undefined) return expose(context);
  if (sub === "status" && rest.length === 0) return status(context);
  if (sub === "quick" && rest.length <= 1) return quick(context, rest[0] === undefined ? {} : { port: rest[0] });
  if (sub === "delete" && rest.every((arg) => arg === "--yes")) return remove(context, { yes: rest.includes("--yes") });
  return [`usage: ${USAGE}`];
}

/**
 * The API token: the shell's `CLOUDFLARE_API_TOKEN`, or asked without echo at a terminal (`ask`, this
 * file's own prompt by default; `pikit configure`'s step passes the CLI's). Never from `.env` (refused
 * before: `tokenInDotEnv`), never stored.
 */
export async function apiTokenFromShell(cwd: string, ask: ((question: string) => Promise<string>) | undefined = interactive() ? askSecret : undefined): Promise<string | undefined> {
  // The CLI puts `.env` under the environment it gives the command: refused there before this is asked.
  if (dotEnv(cwd).CLOUDFLARE_API_TOKEN !== undefined) return undefined;
  const fromShell = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (fromShell) return fromShell;
  if (ask === undefined) return undefined;
  const typed = (await ask(`Cloudflare API token (${TOKEN_PERMISSIONS}; used now, never stored): `)).trim();
  return typed === "" ? undefined : typed;
}

/** `CLOUDFLARE_API_TOKEN` in `.env` would reach the app's container, where the agent could read it. */
function tokenInDotEnv(cwd: string): string[] {
  return dotEnv(cwd).CLOUDFLARE_API_TOKEN === undefined
    ? []
    : ["CLOUDFLARE_API_TOKEN is in .env, which the app's container gets (the agent could read it, and edit your DNS with it): take it out of .env, and pass it from the shell (CLOUDFLARE_API_TOKEN=… pikit expose) or type it when asked"];
}

const NO_TOKEN = `no Cloudflare API token: set CLOUDFLARE_API_TOKEN in the shell (not in .env), or run it at a terminal to be asked. It needs ${TOKEN_PERMISSIONS}`;

/** The account's API, the zone holding the hostname, and the tunnel's name; or why not. */
async function connect(context: ExposeContext, hostname: string): Promise<{ api: Cloudflare; zone: { id: string; accountId: string } } | string[]> {
  const refused = tokenInDotEnv(context.cwd);
  if (refused.length > 0) return refused;
  const token = await context.apiToken();
  if (token === undefined) return [NO_TOKEN];
  const api = cloudflare({ token, ...context.api });
  const zone = await api.zoneFor(hostname);
  if (zone === undefined) {
    return [`no zone of this token's account holds ${hostname}: its domain must be on Cloudflare, and the token must reach that zone (${TOKEN_PERMISSIONS})`];
  }
  return { api, zone };
}

/** What a DNS record of the hostname is to us: ours (made by `pikit expose`, or already the tunnel's), or someone else's. */
function isOurs(record: DnsRecord, hostname: string, target?: string): boolean {
  return record.comment === recordComment(hostname) || (target !== undefined && record.type === "CNAME" && record.content === target);
}

/**
 * Creates or reconciles the tunnel (`pikit-<hostname>`), its ingress rules, the hostname's DNS record and
 * the tunnel's token file, then writes `PIKIT_PUBLIC_URL`. Writes only what differs. A DNS record of
 * the hostname it did not make stops it before any write.
 */
export async function expose(context: ExposeContext): Promise<string[]> {
  const { settings, problems } = readSettings(context.get);
  if (settings === undefined) return problems;
  const { hostname } = settings;
  try {
    const connected = await connect(context, hostname);
    if (Array.isArray(connected)) return connected;
    const { api, zone } = connected;
    const name = tunnelName(hostname);
    const existing = await api.findTunnel(zone.accountId, name);
    const records = await api.dnsRecords(zone.id, hostname);
    const target = existing === undefined ? undefined : `${existing.id}.cfargotunnel.com`;
    const foreign = records.filter((record) => !isOurs(record, hostname, target));
    if (foreign.length > 0) {
      return [
        `${hostname} already has DNS records pikit expose did not make (${foreign.map((record) => `${record.type} ${record.content}`).join(", ")}): remove them in Cloudflare, or choose another CLOUDFLARE_TUNNEL_HOSTNAME`,
      ];
    }

    const tunnel = existing ?? (await api.createTunnel(zone.accountId, name));
    if (existing === undefined) context.say(`created the tunnel ${name}`);

    const rules = ingressRules(settings);
    if (JSON.stringify(await api.ingress(zone.accountId, tunnel.id)) !== JSON.stringify(rules)) {
      await api.putIngress(zone.accountId, tunnel.id, rules);
      context.say(`routes: ${settings.paths.join(", ")} to the app; anything else answers 404`);
    }

    const record = { type: "CNAME", name: hostname, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, comment: recordComment(hostname) };
    const current = records[0];
    if (current === undefined) {
      await api.createDnsRecord(zone.id, record);
      context.say(`DNS: ${hostname} to the tunnel`);
    } else if (current.type !== record.type || current.content !== record.content || current.proxied !== true || current.comment !== record.comment) {
      await api.updateDnsRecord(zone.id, current.id, record);
      context.say(`DNS: ${hostname} to the tunnel (updated)`);
    }
    for (const extra of records.slice(1)) await api.deleteDnsRecord(zone.id, extra.id);

    if (writeTunnelToken(context.cwd, await api.tunnelToken(zone.accountId, tunnel.id))) {
      context.say(`${TUNNEL_TOKEN_FILE}: the tunnel's token, for the cloudflared service only`);
    }
    const url = `https://${hostname}`;
    setDotEnv(context.cwd, "PIKIT_PUBLIC_URL", url);
    context.say(url);
    context.say("`pikit up` runs cloudflared beside the app; then `pikit expose status`");
    return [];
  } catch (error) {
    if (error instanceof CloudflareError) return [error.message];
    throw error;
  }
}

/**
 * The tunnel's state, when an API token is at hand (the shell's; never asked), and `GET <url>/health`
 * through Cloudflare, told apart: no connector (530), a path not public (404), the app's answer.
 */
export async function status(context: ExposeContext): Promise<string[]> {
  const { settings, problems } = readSettings(context.get);
  if (settings === undefined) return problems;
  const url = `https://${settings.hostname}`;
  context.say(`URL: ${url}`);
  context.say(`public: ${settings.paths.join(", ")}`);
  if (!hasTunnelToken(context.cwd)) return [`no ${TUNNEL_TOKEN_FILE} here: run \`pikit expose\` to create the tunnel`];
  const found: string[] = [];
  const token = dotEnv(context.cwd).CLOUDFLARE_API_TOKEN === undefined ? process.env.CLOUDFLARE_API_TOKEN?.trim() : undefined;
  if (token) {
    try {
      const api = cloudflare({ token, ...context.api });
      const zone = await api.zoneFor(settings.hostname);
      const tunnel = zone === undefined ? undefined : await api.findTunnel(zone.accountId, tunnelName(settings.hostname));
      if (tunnel === undefined) found.push(`the tunnel ${tunnelName(settings.hostname)} does not exist in Cloudflare: run \`pikit expose\``);
      else context.say(`tunnel ${tunnel.name}: ${tunnel.status}, ${tunnel.connections.length} connection(s)`);
    } catch (error) {
      context.say(`tunnel: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const fetcher = context.fetch ?? fetch;
  let answer: number | string;
  try {
    answer = (await fetcher(`${url}/health`, { signal: AbortSignal.timeout(10_000), redirect: "manual" })).status;
  } catch (error) {
    answer = `unreachable (${error instanceof Error ? error.message : String(error)})`;
  }
  context.say(`GET ${url}/health: ${answer}`);
  if (answer === 530 || answer === 502) found.push("Cloudflare reaches no connector of the tunnel: is `pikit up` running cloudflared (`pikit status`), and is the app healthy?");
  else if (answer === 404) found.push("/health answered 404: the tunnel's routes are not this project's; run `pikit expose`");
  else if (answer !== 200) found.push(`the app does not answer /health through the tunnel (${answer})`);
  return found;
}

export interface QuickOptions {
  /** The app's port on this machine. Default: 3000, server-bun's. */
  port?: string;
  /** The program and its first arguments. Default: `cloudflared`. Tests give a fake. */
  cloudflared?: readonly string[];
}

/**
 * A temporary tunnel (`https://<random>.trycloudflare.com`) to this machine's app, while it runs: for a
 * try with `pikit dev`. It has no routes, so every path is public; it writes nothing.
 */
export async function quick(context: ExposeContext, options: QuickOptions = {}): Promise<string[]> {
  const port = options.port ?? "3000";
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) return [`"${port}" is not a port`];
  context.say("A temporary tunnel: every path of this machine's app is public while it runs (no routes), its URL changes each time, and Cloudflare gives it no uptime. For a try, never for a platform's settings. Ctrl-C ends it.");
  const [file = "cloudflared", ...first] = options.cloudflared ?? ["cloudflared"];
  return new Promise((resolve) => {
    const child = spawn(file, [...first, "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "ignore", "pipe"] });
    let url: string | undefined;
    let output = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      output = `${output}${chunk}`.slice(-4000);
      if (url !== undefined) return;
      url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(output)?.[0];
      if (url !== undefined) context.say(url);
    });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    child.on("error", (error: NodeJS.ErrnoException) => {
      resolve([error.code === "ENOENT" ? `${file} is not installed: \`brew install cloudflared\`, or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/` : error.message]);
    });
    child.on("close", (code, signal) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (url === undefined && signal === null && code !== 0) resolve([`cloudflared ended (${code}) before giving a URL: ${output.trim().split("\n").slice(-3).join(" / ")}`]);
      else resolve([]);
    });
  });
}

/** Deletes the hostname's DNS record (only its own), the tunnel and the token file, and `PIKIT_PUBLIC_URL`, after a confirmation. */
export async function remove(context: ExposeContext, options: { yes?: boolean; confirm?(question: string): Promise<boolean> } = {}): Promise<string[]> {
  const { hostname, problems } = readHostname(context.get);
  if (hostname === undefined) return problems;
  const question = `Delete the tunnel ${tunnelName(hostname)} and the DNS record of ${hostname}? https://${hostname} stops answering`;
  if (options.yes !== true) {
    const ask = options.confirm ?? (interactive() ? confirm : undefined);
    if (ask === undefined) return ["pikit expose delete asks for confirmation; pass --yes when it runs without a terminal"];
    if (!(await ask(question))) return ["cancelled"];
  }
  try {
    const connected = await connect(context, hostname);
    if (Array.isArray(connected)) return connected;
    const { api, zone } = connected;
    const tunnel = await api.findTunnel(zone.accountId, tunnelName(hostname));
    const target = tunnel === undefined ? undefined : `${tunnel.id}.cfargotunnel.com`;
    for (const record of await api.dnsRecords(zone.id, hostname)) {
      if (!isOurs(record, hostname, target)) continue;
      await api.deleteDnsRecord(zone.id, record.id);
      context.say(`DNS: ${hostname} deleted`);
    }
    if (tunnel !== undefined) {
      await api.cleanupConnections(zone.accountId, tunnel.id);
      await api.deleteTunnel(zone.accountId, tunnel.id);
      context.say(`deleted the tunnel ${tunnel.name}`);
    }
    if (removeTunnelToken(context.cwd)) context.say(`${TUNNEL_TOKEN_FILE} deleted`);
    unsetDotEnv(context.cwd, "PIKIT_PUBLIC_URL");
    context.say("`pikit down` stops the cloudflared container; `pikit remove expose-cloudflare-tunnel` then takes the component out");
    return [];
  } catch (error) {
    if (error instanceof CloudflareError) return [error.message];
    throw error;
  }
}

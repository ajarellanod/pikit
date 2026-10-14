/**
 * What `pikit expose` reads and writes in the project: its two values (the hostname and the public
 * paths, non-secret variables of `.env` that `pikit configure` sets), the ingress rules made of them,
 * `.env`'s `PIKIT_PUBLIC_URL`, and `.env.cloudflared`, the tunnel's token for the `cloudflared` service
 * alone (compose.yaml gives `.env` to the app, so the token never goes there).
 */

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { IngressRule } from "./cloudflare.ts";

/** Where `cloudflared` reaches the app: compose.yaml's `app` service, on compose's network. */
export const ORIGIN = "http://app:3000";
/** The tunnel's token, read by this component's compose.yaml's `cloudflared` service only (`env_file`). */
export const TUNNEL_TOKEN_FILE = ".env.cloudflared";
/** Always public: `pikit expose status` and a platform's checks read it, and it tells nothing private. */
export const ALWAYS_PUBLIC = "/health";

export interface Settings {
  hostname: string;
  /** Each public path: `/health` first, then those listed, without duplicates. */
  paths: string[];
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
/** `/`, a literal path, or a prefix ending in `/*` (`/admin/*`, `/*`): the segments `http.route` keys use. */
const PUBLIC_PATH = /^\/([A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*)?(\/\*)?$|^\/\*$/;

/** The public hostname, from `CLOUDFLARE_TUNNEL_HOSTNAME`; or what is wrong with it. */
export function readHostname(get: (name: string) => string | undefined): { hostname?: string; problems: string[] } {
  const hostname = get("CLOUDFLARE_TUNNEL_HOSTNAME")?.trim().toLowerCase();
  if (hostname === undefined || hostname === "") return { problems: ["CLOUDFLARE_TUNNEL_HOSTNAME is not set: the public hostname, on a zone of your Cloudflare account (bot.example.com); `pikit configure` sets it"] };
  if (!HOSTNAME.test(hostname)) return { problems: [`CLOUDFLARE_TUNNEL_HOSTNAME "${hostname}" is not a hostname (bot.example.com: no scheme, no path)`] };
  return { hostname, problems: [] };
}

/** The hostname and the paths, from `CLOUDFLARE_TUNNEL_HOSTNAME` and `PIKIT_EXPOSE_PATHS`; or what is wrong with them. */
export function readSettings(get: (name: string) => string | undefined): { settings?: Settings; problems: string[] } {
  const { hostname, problems } = readHostname(get);
  const listed = (get("PIKIT_EXPOSE_PATHS") ?? "").split(",").map((path) => path.trim()).filter((path) => path !== "");
  if (listed.length === 0) problems.push("PIKIT_EXPOSE_PATHS is not set: the paths the internet may reach, separated by commas (/googlechat); `pikit configure` sets it");
  for (const path of listed) {
    if (!PUBLIC_PATH.test(path)) problems.push(`PIKIT_EXPOSE_PATHS: "${path}" is not a path (/googlechat) or a prefix (/hooks/*)`);
  }
  if (problems.length > 0 || hostname === undefined) return { problems };
  return { settings: { hostname, paths: [...new Set([ALWAYS_PUBLIC, ...listed])] }, problems };
}

/** A path as the Go regular expression of an ingress rule, anchored: `/a` only `/a`; `/a/*` `/a` and under it. */
export function pathPattern(path: string): string {
  const escape = (text: string) => text.replace(/[.\\+*?^$()[\]{}|]/g, "\\$&");
  if (path.endsWith("/*")) return `^${escape(path.slice(0, -2))}(/.*)?$`;
  return `^${escape(path)}$`;
}

/** One rule per public path to the app, then the catch-all: anything else is Cloudflare's 404, never the app's. */
export function ingressRules(settings: Settings): IngressRule[] {
  return [...settings.paths.map((path) => ({ hostname: settings.hostname, path: pathPattern(path), service: ORIGIN })), { service: "http_status:404" }];
}

/** The tunnel's name in the account: one tunnel per public hostname. */
export function tunnelName(hostname: string): string {
  return `pikit-${hostname}`;
}

/** The comment on the DNS record it creates: how a later run knows the record is its own. */
export function recordComment(hostname: string): string {
  return `pikit expose: ${tunnelName(hostname)}`;
}

/** `.env`'s variables, as written in the file (not the environment). */
export function dotEnv(cwd: string): Record<string, string | undefined> {
  const path = join(cwd, ".env");
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
}

const line = (name: string) => new RegExp(`^[ \\t]*(export[ \\t]+)?${name}[ \\t]*=.*$`, "m");

/** Sets `name=value` in `.env`, in place or at the end; whether it changed. */
export function setDotEnv(cwd: string, name: string, value: string): boolean {
  const path = join(cwd, ".env");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = line(name).test(text) ? text.replace(line(name), `${name}=${value}`) : `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${name}=${value}\n`;
  if (next === text) return false;
  writeFileSync(path, next);
  return true;
}

/** Takes `name` out of `.env`; whether it was there. */
export function unsetDotEnv(cwd: string, name: string): boolean {
  const path = join(cwd, ".env");
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  const next = text.replace(new RegExp(`${line(name).source}\\n?`, "m"), "");
  if (next === text) return false;
  writeFileSync(path, next);
  return true;
}

/** Writes the tunnel's token for the `cloudflared` service, readable by this user only; whether it changed. */
export function writeTunnelToken(cwd: string, token: string): boolean {
  const path = join(cwd, TUNNEL_TOKEN_FILE);
  const text = `# The tunnel's token: only the cloudflared service reads it (expose-cloudflare-tunnel). Never in .env.\nTUNNEL_TOKEN=${token}\n`;
  const same = existsSync(path) && readFileSync(path, "utf8") === text;
  if (!same) writeFileSync(path, text, { mode: 0o600 });
  // `mode` applies only to a new file: an existing one is made private too.
  chmodSync(path, 0o600);
  return !same;
}

export function hasTunnelToken(cwd: string): boolean {
  return existsSync(join(cwd, TUNNEL_TOKEN_FILE));
}

export function removeTunnelToken(cwd: string): boolean {
  const had = hasTunnelToken(cwd);
  rmSync(join(cwd, TUNNEL_TOKEN_FILE), { force: true });
  return had;
}

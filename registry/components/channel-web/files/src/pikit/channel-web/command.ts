/**
 * `pikit channel-web`: the web chat's users from a terminal, as the dashboard's Web users view does,
 * over the same operator routes (`/admin/api/channel-web/*`, `admin-api.ts`) of the running App:
 *
 *   pikit channel-web users                          every user: id, email, name, how they sign in, created, last seen, state
 *   pikit channel-web invite <email> [--name <name>]  an invitation: its link, printed once (emailed too with email.send)
 *   pikit channel-web reset <user>                   a password-reset link, printed once
 *   pikit channel-web ban <user> | unban <user>      a ban revokes every session
 *   pikit channel-web remove <user> [--yes]          the account, its sessions and sign-in methods (asks first)
 *
 * `<user>` is a user's id or email. Every subcommand takes `--url <origin>`: the App it talks to.
 * Without it, `PIKIT_PUBLIC_URL` (the environment, or `.env`), else this machine's App (`pikit dev`):
 * `http://127.0.0.1:8787` with deployment-cloudflare (wrangler), else server-bun's port (3000 unless
 * its config says otherwise). It signs in with `PIKIT_ADMIN_TOKEN` (the environment, or `.env`).
 *
 * component.json declares it (`"commands": { "channel-web": … }`): the CLI runs `command(io)` in a child
 * process in the project's directory, never in the App. A link is printed once and written nowhere.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type { AdminChatInvitation, AdminChatLink, AdminChatUser, AdminChatUsersPage } from "./admin-api.ts";

const USAGE = "pikit channel-web users | invite <email> [--name <name>] | reset <user> | ban <user> | unban <user> | remove <user> [--yes]   (<user>: an id or an email; any: --url <origin>)";
const TOKEN = "PIKIT_ADMIN_TOKEN";
const PUBLIC_URL = "PIKIT_PUBLIC_URL";
const ROUTES = "/admin/api/channel-web";
const PAGE = 100;

/** What the CLI gives a component's command (`component-command.ts`). */
export interface CommandIO {
  args: readonly string[];
  config(): Promise<Readonly<Record<string, unknown>>>;
  get(name: string): string | undefined;
  say(line: string): void;
}

/** What tests replace: the HTTP client, the confirmation, and this machine's App's origin. */
export interface CommandOptions {
  fetch?: typeof fetch;
  /** Yes or no at a terminal; `undefined` when there is none (then `remove` needs `--yes`). */
  confirm?: ((question: string) => Promise<boolean>) | undefined;
  /** The origin of this machine's App, when neither `--url` nor `PIKIT_PUBLIC_URL` is given. */
  localOrigin?: () => Promise<string>;
}

/** An answer of the App that is not a success, said for the operator. */
class Refused extends Error {}

export async function command(io: CommandIO, options: CommandOptions = {}): Promise<string[]> {
  const parsed = parse(io.args);
  if (typeof parsed === "string") return [parsed, `usage: ${USAGE}`];
  const token = io.get(TOKEN)?.trim();
  if (token === undefined || token === "") return [`${TOKEN} is not set: the operator's token, in .env or the environment (pikit configure --generate ${TOKEN})`];
  const origin = (parsed.url ?? (io.get(PUBLIC_URL)?.trim() || (await (options.localOrigin ?? localOrigin)()))).replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(origin)) return [`"${origin}" is not an origin (https://chat.example.com): pass --url, or fix ${PUBLIC_URL}`];
  const client = new Client(origin, token, options.fetch ?? fetch);
  const confirm = "confirm" in options ? options.confirm : process.stdin.isTTY ? ask : undefined;
  try {
    switch (parsed.sub) {
      case "users":
        return list(io, await client.users());
      case "invite": {
        const invitation = await client.send<AdminChatInvitation>("POST", "/invitations", { email: parsed.target, ...(parsed.name !== undefined && { name: parsed.name }) });
        io.say(`Invited ${parsed.target.toLowerCase()} (user ${invitation.userId}).`);
        printLink(io, invitation, "invitation");
        return [];
      }
      case "reset": {
        const user = await client.find(parsed.target);
        printLink(io, await client.send<AdminChatLink>("POST", `${userPath(user)}/password-reset`), `password-reset link for ${user.email}`);
        return [];
      }
      case "ban":
      case "unban": {
        const user = await client.find(parsed.target);
        await client.send("POST", `${userPath(user)}/${parsed.sub}`);
        io.say(parsed.sub === "ban" ? `Banned ${user.email} (${user.id}): every session revoked; a session its cookie vouches for ends within the component's sessionCacheSeconds.` : `Unbanned ${user.email} (${user.id}).`);
        return [];
      }
      case "remove": {
        const user = await client.find(parsed.target);
        if (!parsed.yes) {
          if (confirm === undefined) return [`removing ${user.email} cannot be undone: pass --yes to remove them without a terminal`];
          if (!(await confirm(`Remove ${user.email} (${user.id})? Their account, sessions and sign-in methods are deleted; their conversations leave their list. [y/N] `))) {
            io.say("Not removed.");
            return [];
          }
        }
        await client.send("DELETE", userPath(user));
        io.say(`Removed ${user.email} (${user.id}).`);
        return [];
      }
    }
  } catch (error) {
    if (error instanceof Refused) return [error.message];
    throw error;
  }
}

type Parsed = { url?: string } & ({ sub: "users" } | { sub: "invite"; target: string; name?: string } | { sub: "reset" | "ban" | "unban"; target: string } | { sub: "remove"; target: string; yes: boolean });

/** The subcommand and its arguments, or what is wrong with them. */
function parse(args: readonly string[]): Parsed | string {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--yes") flags.yes = true;
    else if (arg === "--url" || arg === "--name") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) return `${arg} needs a value`;
      flags[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) return `unknown option ${arg}`;
    else positional.push(arg);
  }
  const [sub, target, ...extra] = positional;
  const url = typeof flags.url === "string" ? { url: flags.url } : {};
  const only = (allowed: string[]) => Object.keys(flags).find((flag) => flag !== "url" && !allowed.includes(flag));
  if (sub === undefined) return "which subcommand?";
  if (extra.length > 0) return `unexpected ${extra.join(" ")}`;
  if (sub === "users") {
    if (target !== undefined) return `unexpected ${target}`;
    return only([]) === undefined ? { sub, ...url } : `--${only([])} is not an option of users`;
  }
  if (sub !== "invite" && sub !== "reset" && sub !== "ban" && sub !== "unban" && sub !== "remove") return `unknown subcommand ${sub}`;
  if (target === undefined) return sub === "invite" ? "invite whom? an email" : `${sub} whom? a user's id or email`;
  if (sub === "invite") {
    if (only(["name"]) !== undefined) return `--${only(["name"])} is not an option of invite`;
    if (!target.includes("@")) return `"${target}" is not an email`;
    return { sub, target, ...(typeof flags.name === "string" && { name: flags.name }), ...url };
  }
  if (sub === "remove") return only(["yes"]) === undefined ? { sub, target, yes: flags.yes === true, ...url } : `--${only(["yes"])} is not an option of remove`;
  return only([]) === undefined ? { sub, target, ...url } : `--${only([])} is not an option of ${sub}`;
}

const userPath = (user: AdminChatUser) => `/users/${encodeURIComponent(user.id)}`;

/** The operator's routes of the App at `origin`, with the token; every refusal a `Refused` said plainly. */
class Client {
  constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly fetch: typeof globalThis.fetch,
  ) {}

  async send<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(`${this.origin}${ROUTES}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Refused(`cannot reach ${this.origin} (${error instanceof Error ? error.message : String(error)}): is the App running? Pass --url <origin> to name another`);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (response.ok && json !== undefined) return json as T;
    const error = (json ?? {}) as { error?: unknown; message?: unknown };
    const code = typeof error.error === "string" ? error.error : `http_${response.status}`;
    const said = typeof error.message === "string" ? `: ${error.message}` : "";
    if (response.status === 401) throw new Refused(`${this.origin} refused ${TOKEN} (401): is it this App's token?`);
    // A user's own route is `404` for a user gone meanwhile; the list's and the invitations' only without the routes.
    if (response.status === 404 && !path.startsWith("/users/")) throw new Refused(`${this.origin} has no channel-web operator routes (404): is channel-web installed there, with an admin.auth (admin-auth-token)? Pass --url <origin> to name another App`);
    if (code === "exists") throw new Refused(`that email has an account in use (409): make a password-reset link instead (pikit channel-web reset <user>)`);
    if (response.ok) throw new Refused(`${this.origin} answered ${response.status} with no JSON: is it a pikit App?`);
    throw new Refused(`${this.origin} answered ${response.status} ${code}${said}`);
  }

  /** Every user, page by page, newest first. */
  async users(): Promise<AdminChatUser[]> {
    const all: AdminChatUser[] = [];
    for (;;) {
      const page = await this.send<AdminChatUsersPage>("GET", `/users?limit=${PAGE}&offset=${all.length}`);
      all.push(...page.items);
      // A user who came meanwhile shifts the pages: one may then show twice, never one missed.
      if (page.items.length === 0 || all.length >= page.total) break;
    }
    return [...new Map(all.map((user) => [user.id, user])).values()];
  }

  /** The user `who` names: an id, or an email (looked up in the list). */
  async find(who: string): Promise<AdminChatUser> {
    const users = await this.users();
    const email = who.toLowerCase();
    const found = users.find((user) => user.id === who) ?? users.find((user) => user.email.toLowerCase() === email);
    if (found === undefined) throw new Refused(`no user ${who}: \`pikit channel-web users\` lists them`);
    return found;
  }
}

const when = (at: number | undefined) => (at === undefined ? "never" : new Date(at).toISOString().slice(0, 16).replace("T", " "));
const stateOf = (user: AdminChatUser) => (user.banned ? "banned" : user.methods.length === 0 && user.lastSeenAt === undefined ? "invited" : "active");

function list(io: CommandIO, users: AdminChatUser[]): string[] {
  if (users.length === 0) {
    io.say("No user yet: pikit channel-web invite <email>");
    return [];
  }
  const rows = [
    ["ID", "EMAIL", "NAME", "SIGNS IN WITH", "CREATED", "LAST SEEN", "STATE"],
    ...users.map((user) => [user.id, user.email, user.name, user.methods.join(",") || "-", when(user.createdAt), when(user.lastSeenAt), stateOf(user)]),
  ];
  const widths = (rows[0] as string[]).map((_, column) => Math.max(...rows.map((row) => (row[column] as string).length)));
  for (const row of rows) io.say(row.map((cell, column) => cell.padEnd(widths[column] as number)).join("  ").trimEnd());
  io.say(`${users.length} ${users.length === 1 ? "user" : "users"} (UTC)`);
  return [];
}

function printLink(io: CommandIO, link: AdminChatLink, what: string): void {
  io.say(`The ${what}, shown only now (anyone with it can set the password):`);
  io.say(`  ${link.link}`);
  io.say(`It works until ${new Date(link.expiresAt).toISOString()}. ${link.emailed ? "It was emailed to them too." : "It was not emailed (no email sender is installed): send it to them yourself."}`);
}

async function ask(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(y|yes)$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

/**
 * This machine's App (`pikit dev`): wrangler's `http://127.0.0.1:8787` with deployment-cloudflare,
 * else server-bun's port from `pikit.config.ts` (3000 unless its config says otherwise).
 */
export async function localOrigin(cwd = process.cwd()): Promise<string> {
  try {
    const manifest = JSON.parse(readFileSync(join(cwd, "pikit.json"), "utf8")) as { components?: Record<string, unknown> };
    if (manifest.components?.["deployment-cloudflare"] !== undefined && manifest.components["server-bun"] === undefined) return "http://127.0.0.1:8787";
  } catch {
    // No pikit.json: below.
  }
  let port = 3000;
  const config = join(cwd, "pikit.config.ts");
  if (existsSync(config)) {
    try {
      const definition = ((await import(pathToFileURL(config).href)) as { default?: { config?: Record<string, { port?: unknown } | undefined> } }).default;
      const configured = definition?.config?.["server-bun"]?.port;
      if (typeof configured === "number" && Number.isInteger(configured) && configured > 0) port = configured;
    } catch {
      // A config that does not import: the default port.
    }
  }
  return `http://127.0.0.1:${port}`;
}

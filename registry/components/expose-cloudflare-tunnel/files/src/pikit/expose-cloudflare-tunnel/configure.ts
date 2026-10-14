/**
 * expose-cloudflare-tunnel's step of `pikit configure`: everything it needs, in one go, so that
 * `pikit add` then `pikit configure` leave the project ready for `pikit up`.
 *
 * 1. The public hostname (`CLOUDFLARE_TUNNEL_HOSTNAME`) and the public paths (`PIKIT_EXPOSE_PATHS`),
 *    checked as they are typed; kept when already set and well formed. The paths proposed are the
 *    `http.route` keys of the installed `channel-*` components (the App's `describe()`): Enter takes
 *    them. Kept paths that leave a channel's route out are said.
 * 2. "Create the tunnel now?": on yes it asks for the Cloudflare API token without echo (or takes the
 *    shell's `CLOUDFLARE_API_TOKEN`) and does what `pikit expose` does, then forgets the token. It is
 *    never one of `environment`'s variables: those go to `.env`, which the app's container gets.
 *
 * The CLI finds this file in the installed component and calls `configure(io)`; a component with a step
 * owns its variables, so `pikit configure` does not ask them again. Without a terminal it asks nothing:
 * both variables come from the environment or `.env`, and the tunnel is left to `pikit expose`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { apiTokenFromShell, expose, type ExposeContext } from "./expose.ts";
import { hasTunnelToken, pathPattern, readHostname, readPaths } from "./project.ts";

/** What `pikit configure` gives a component's step. Structural, so this file imports nothing from the CLI. */
export interface ConfigureIO {
  /** A person answers at a terminal. False in scripts and CI: ask nothing. */
  interactive: boolean;
  config: Readonly<Record<string, unknown>>;
  /** A variable from the environment, or else `.env`. */
  get(name: string): string | undefined;
  /** Writes a variable to `.env` (mode 0600) now. */
  set(name: string, value: string): void;
  ask(question: string): Promise<string>;
  /** Asks without echoing the answer. */
  askSecret(question: string): Promise<string>;
  /** Yes or no, Enter giving `initialValue`. */
  confirm?(message: string, initialValue: boolean): Promise<boolean>;
  say(line: string): void;
}

const HOSTNAME = "CLOUDFLARE_TUNNEL_HOSTNAME";
const PATHS = "PIKIT_EXPOSE_PATHS";
/** Wrong answers before the step gives up on a value (and says how to set it). */
const TRIES = 3;

/**
 * The values, then the tunnel; returns what is still missing (empty when done). The CLI passes `io`
 * only; tests give the project's directory, Cloudflare's API and the App's routes (`options`).
 */
export async function configure(
  io: ConfigureIO,
  options: { cwd?: string; api?: ExposeContext["api"]; routes?: Readonly<Record<string, string>> } = {},
): Promise<string[]> {
  const cwd = options.cwd ?? process.cwd();
  const hostname = await value(io, HOSTNAME, "Public hostname, on a domain of your Cloudflare account (bot.example.com)", (text) => readHostname(() => text).problems);
  const channels = channelRoutes(options.routes ?? (await appRoutes(cwd)));
  const proposal = [...new Set(channels.map((route) => route.path))].join(",");
  if (channels.length > 0 && io.get(PATHS) === undefined) {
    io.say(`  The installed channels receive: ${channels.map((route) => `${route.key} (${route.component})`).join(", ")}`);
  }
  const paths = await value(
    io,
    PATHS,
    "Public paths, separated by commas: your webhook channels' (/googlechat), a prefix as /hooks/*. /health is always public; anything else answers 404",
    (text) => readPaths(text).problems,
    proposal === "" ? undefined : proposal,
  );
  const missing = [hostname.missing, paths.missing].filter((line): line is string => line !== undefined);
  if (missing.length > 0) return missing;
  const left = uncovered(channels, readPaths(paths.value).paths);
  if (left.length > 0) io.say(`  not public (not in ${PATHS}): ${left.map((route) => `${route.key} (${route.component})`).join(", ")}`);

  const made = hasTunnelToken(cwd);
  if (!io.interactive) {
    if (!made) io.say("  the tunnel: run `pikit expose` to create it (it asks for a Cloudflare API token, never stored)");
    return [];
  }
  const changed = hostname.changed || paths.changed;
  const question = made ? `Update the Cloudflare Tunnel of https://${hostname.value} now?` : `Create the Cloudflare Tunnel for https://${hostname.value} now? It needs a Cloudflare API token, used now and never stored`;
  const now = io.confirm ? await io.confirm(question, !made || changed) : /^(y|yes)$/i.test((await io.ask(`${question} [y/N] `)).trim());
  if (!now) {
    io.say(made ? "  the tunnel: unchanged (`pikit expose` updates it)" : "  the tunnel: run `pikit expose` when you are ready");
    return [];
  }
  const context: ExposeContext = { cwd, get: io.get, say: io.say, apiToken: () => apiTokenFromShell(cwd, (q) => io.askSecret(q)) };
  return expose(options.api === undefined ? context : { ...context, api: options.api });
}

/** A channel's `http.route`: its key, the component that serves it, and the public path that reaches it. */
export interface ChannelRoute {
  key: string;
  component: string;
  path: string;
}

/**
 * The routes of `channel-*` components among `routes` (`http.route` key to its component), each with
 * the public path that reaches it: the key's path, or the prefix before its first parameter
 * (`/hooks/:id` is `/hooks/*`), since a tunnel's rule matches a path, not a method nor a parameter. The
 * dashboard's (`admin-*`) and anything else's are never proposed.
 */
export function channelRoutes(routes: Readonly<Record<string, string>>): ChannelRoute[] {
  return Object.entries(routes)
    .filter(([, component]) => component.startsWith("channel-"))
    .map(([key, component]) => {
      const segments = (key.split(" ")[1] ?? "/").split("/").slice(1);
      const parameter = segments.findIndex((segment) => segment.startsWith(":"));
      const path = parameter < 0 ? `/${segments.join("/")}` : `/${segments.slice(0, parameter).join("/")}/*`.replace("//*", "/*");
      return { key, component, path };
    })
    .filter((route) => readPaths(route.path).problems.length === 0);
}

/** The channels' routes that none of `paths` makes public. */
export function uncovered(channels: readonly ChannelRoute[], paths: readonly string[]): ChannelRoute[] {
  const patterns = paths.map((path) => new RegExp(pathPattern(path)));
  // A prefix route is reached at its own path; a parameter, by any value of it.
  const sample = (route: ChannelRoute) => (route.path.endsWith("/*") ? `${route.path.slice(0, -2)}/x` : route.path);
  return channels.filter((route) => !patterns.some((pattern) => pattern.test(sample(route))));
}

/**
 * The App's `http.route` keys and their components, from `pikit.config.ts` created (every setup, nothing
 * started) and described; none when it does not compose yet (the step still asks for the paths).
 */
async function appRoutes(cwd: string): Promise<Record<string, string>> {
  const path = join(cwd, "pikit.config.ts");
  if (!existsSync(path)) return {};
  try {
    const definition = ((await import(pathToFileURL(path).href)) as { default?: { create?(): Promise<{ describe(): unknown }> } }).default;
    const described = (await definition?.create?.())?.describe() as { capabilities?: Record<string, { keys?: Record<string, string> }> } | undefined;
    return described?.capabilities?.["http.route"]?.keys ?? {};
  } catch {
    return {};
  }
}

/**
 * One variable: kept when set and well formed, else asked (at most `TRIES` times; Enter takes `proposal`)
 * and written to `.env`. `missing` says how to set it when it could not be.
 */
async function value(
  io: ConfigureIO,
  name: string,
  question: string,
  problems: (text: string) => string[],
  proposal?: string,
): Promise<{ value?: string; changed: boolean; missing?: string }> {
  const current = io.get(name)?.trim();
  if (current !== undefined && current !== "") {
    const wrong = problems(current);
    if (wrong.length === 0) {
      // Saved to .env even when it came from the environment: `pikit expose` and `pikit up` read .env.
      io.set(name, current);
      io.say(`  ${name}: ${current}`);
      return { value: current, changed: false };
    }
    io.say(`✗ ${wrong.join("; ")}`);
  }
  const hint = proposal === undefined ? "" : ` (the installed channels': ${proposal})`;
  if (!io.interactive) return { changed: false, missing: `${name} is required and not set${hint}: export it, or run \`pikit configure\` in a terminal` };
  for (let i = 0; i < TRIES; i++) {
    const typed = (await io.ask(`${name}: ${question}${proposal === undefined ? "" : `. Enter: ${proposal}`}`)).trim();
    const answer = typed === "" ? (proposal ?? "") : typed;
    const wrong = answer === "" ? [`${name} is required`] : problems(answer);
    if (wrong.length === 0) {
      io.set(name, answer);
      return { value: answer, changed: answer !== current };
    }
    io.say(`✗ ${wrong.join("; ")}`);
  }
  return { changed: false, missing: `${name} is required and not set: run \`pikit configure\` again, or set it in .env` };
}

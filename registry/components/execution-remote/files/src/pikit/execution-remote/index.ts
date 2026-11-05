/**
 * execution-remote: the agent's files and shell in a sandbox on another machine, a host running
 * `execution-serve`, reached over HTTP with plain `fetch` (the sandbox protocol, `protocol.ts`). On
 * Cloudflare a Durable Object cannot run a VM: this is how a conversation there gets a real Linux.
 *
 * It provides `execution` and `execution.shell` (pi-durable's `ExecutionEnv`, `env.ts`) and
 * `workspace`, which the runtime asks on every tool call for the conversation's environment. A
 * conversation's sandbox is its chat's and its agent's (`ConversationRef.agent`): the chat is the
 * conversation a person or a channel opened (`originOf`), so a reset (`/new`) finds the agent's files
 * again, and a delegated child of the same agent works in its parent's sandbox on every target. Every
 * request to it carries `Pikit-Agent: <agent>`, and two agents never share one, also when one
 * delegates to the other.
 * The agent is an agent's name of at most `MAX_AGENT_LENGTH` (100) characters, this component's own
 * bound (`defineAgent` has none): a longer one is refused at `resolve`, saying so (the host answers
 * `400` too). Which sandbox (its id, `protocol.ts`'s `SANDBOX_ID`):
 * - **In a Durable Object** (`WORKERS_HOST` has an object): the object is the chat (its delegated
 *   children live in it too), so each agent of the object works in
 *   `o-<hex SHA-256 of "<object id>\n<agent>">`, with an environment of its own kept for the App's
 *   life. The object id is `idFromName(key)`'s of the chat's key: the same for the chat's whole life,
 *   through evictions, deploys and resets. `execution` alone works in `o-<object id>`, with no agent.
 * - **On a server** (no `WORKERS_HOST`): `workspace` gives each chat and agent its own sandbox,
 *   `k-<hex SHA-256 of "<chat key>\n<agent>">`, the chat key the origin's (`originOf(ref).key`: a
 *   delegated child's own `delegate:...` key chooses nothing), with an environment kept for the App's
 *   life: one per chat and agent ever resolved, never forgotten; `execution` alone is the sandbox
 *   `sandbox` of the config (`shared`), with no agent.
 * The host makes the sandbox on its first request (its provider's `workspace.resolve`) and keeps it.
 *
 * - **Which host** (`hosts`, `agents`, `defaultHost`): a conversation's sandbox is on its agent's host,
 *   `agents[ConversationRef.agent]`, or the default host for an agent `agents` does not name. A
 *   delegated child is its own agent's (`ConversationRef.agent` is the child's): a child of another
 *   agent works on that agent's host, a same-agent child on its parent's. `execution`'s own sandbox
 *   (no conversation, no agent) is on the default host. The sandbox id does not depend on the host:
 *   moving an agent to another host starts it there, in a sandbox of the same id that host makes new.
 * - **The tokens**, one secret per host (`tokenSecret`, `PIKIT_SANDBOX_TOKEN` by default), are read
 *   through `secrets` at start: missing, shorter than 32 characters, or two hosts with the same token
 *   (one secret, or two of one value), the App does not start. Each goes in the `Authorization` header of its own host's requests and
 *   nowhere else: never to another host.
 * - **A host's `url`** is `https://`, or `http://` to the machine itself (`localhost`, `127.0.0.1`,
 *   `[::1]`): the token never crosses a network in clear.
 * - **Fail closed at start**: `agents` or `defaultHost` naming a host `hosts` has not, several hosts and
 *   no `defaultHost`, a key of `agents` that is not an agent's name (or of `hosts` not a host's), two
 *   hosts at one `url` (one execution-serve takes one token, and two hosts never share one: one of them
 *   would be refused on every request): the App does not start, the error naming it.
 * - **A misspelled agent is warned of** at start, where `agent.definition`s are provided and a key of
 *   `agents` is none of theirs (`AGENTS_WARNING`): the agent meant would work on the default host. A
 *   live agent's (`agent.directory`, agents-live) is not checked, as execution-gondolin's profiles.
 * - **Credentials (SPEC C7).** Nothing secret goes to the sandbox through this component: no
 *   variable, no file, no command carries the token or any other secret of the App. A sandbox that
 *   needs a credential gets it from its host, injected outside the sandbox (execution-gondolin does it
 *   at its network layer).
 *
 * Targets: `server` and `durable` (only `fetch` and Web Crypto). On Cloudflare it belongs in the
 * conversation object's App (the default export), not the Worker's.
 */

import { defineComponent } from "@pikit/core";
import { originOf } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { toChord, type WorkspaceProvider } from "@pikit/pi-adapter";
import Type, { type Static } from "typebox";
import { RemoteExecutionEnv } from "./env.ts";
import { AGENT_NAME, DEFAULT_TOKEN_SECRET, isAgentName, isSandboxId, MAX_AGENT_LENGTH, MAX_SANDBOX_ID_LENGTH, MIN_TOKEN_LENGTH, SANDBOX_ID } from "./protocol.ts";
import { createTransport, type Transport } from "./transport.ts";

const NAME = "execution-remote";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** A host's name in `hosts`: kebab-case, as an agent's. */
const HOST_NAME = { pattern: AGENT_NAME.source, maxLength: 100 };

const Host = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      description: "Where the host's execution-serve is served (`https://sandbox.example.com`, a path prefix allowed). https://, or http:// to this machine only; checked at start.",
    }),
    // Optional, its default applied in `start`: a record's values get no schema defaults.
    tokenSecret: Type.Optional(
      Type.String({ minLength: 1, description: `The name of the secret holding this host's token, not the token: config is never secret. Each host its own; default ${DEFAULT_TOKEN_SECRET}.` }),
    ),
  },
  { additionalProperties: false },
);

const Config = Type.Object(
  {
    // At least one (checked at start: a record with `minProperties` cannot be described).
    hosts: Type.Record(Type.String(), Host, {
      propertyNames: HOST_NAME,
      description: "The sandbox hosts, by name: each runs execution-serve, with its own token.",
    }),
    defaultHost: Type.Optional(
      Type.String({ ...HOST_NAME, description: "The host of `execution`'s own sandbox and of every agent `agents` does not name. Required with several hosts; the only one otherwise." }),
    ),
    agents: Type.Record(Type.String(), Type.String(HOST_NAME), {
      default: {},
      propertyNames: { pattern: AGENT_NAME.source, maxLength: MAX_AGENT_LENGTH },
      description: "The host of each agent named (`ConversationRef.agent` → a name in `hosts`); any other agent is on the default host.",
    }),
    sandbox: Type.String({
      pattern: SANDBOX_ID.source,
      maxLength: MAX_SANDBOX_ID_LENGTH,
      default: "shared",
      description: "On a server, the sandbox `execution` works in; a conversation's tools work in its own, through `workspace`.",
    }),
  },
  // A full config: `registry generate` describes setup with it too.
  { examples: [{ hosts: { general: { url: "https://sandbox.example.com" } } }] },
);

type RemoteConfig = Static<typeof Config>;

/** The warning for a key of `agents` no `agent.definition` has. */
export const AGENTS_WARNING =
  "execution-remote: `agents` names an agent no agent.definition has (misspelled?): the agent meant works on the default host, unless the name is a live agent's (agents-live), which is not checked";

/** A host's `url` as compared with another's: the origin and the path, with no trailing `/`. */
const sameHostKey = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
};

/**
 * The host each agent is on, and the default one, or why the config cannot be used (every problem,
 * each naming what is wrong). The grammar of the names is the schema's.
 */
function routing(config: Pick<RemoteConfig, "hosts" | "defaultHost" | "agents">): { ok: true; defaultHost: string; hostOf(agent: string): string } | { ok: false; problems: string[] } {
  const names = Object.keys(config.hosts);
  const problems: string[] = [];
  const has = (name: string) => Object.hasOwn(config.hosts, name);
  const defaultHost = config.defaultHost ?? (names.length === 1 ? names[0] : undefined);
  if (names.length === 0) problems.push("hosts is empty: name at least one sandbox host");
  else if (defaultHost === undefined) problems.push(`hosts has ${names.length} hosts (${names.join(", ")}): name the default one (defaultHost)`);
  else if (!has(defaultHost)) problems.push(`defaultHost ${JSON.stringify(defaultHost)} is not a host of hosts (${names.join(", ")})`);
  for (const [agent, host] of Object.entries(config.agents)) {
    if (!has(host)) problems.push(`agents.${agent} names the host ${JSON.stringify(host)}, which hosts has not (${names.join(", ")})`);
  }
  if (problems.length > 0 || defaultHost === undefined) return { ok: false, problems };
  return { ok: true, defaultHost, hostOf: (agent) => (Object.hasOwn(config.agents, agent) ? (config.agents[agent] as string) : defaultHost) };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The sandbox of a chat's agent on a server: `k-` and the SHA-256 of `<chat key>\n<agent>`, in hex. */
export async function keySandbox(key: string, agent: string): Promise<string> {
  return `k-${await sha256Hex(`${key}\n${agent}`)}`;
}

/** The sandbox of an agent in a Durable Object: `o-` and the SHA-256 of `<object id>\n<agent>`, in hex. */
export async function objectSandbox(objectId: string, agent: string): Promise<string> {
  return `o-${await sha256Hex(`${objectId}\n${agent}`)}`;
}

/** Why a host's `url` cannot be used, or `undefined`. */
function urlProblem(host: string, endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return `hosts.${host}.url ${JSON.stringify(endpoint)} is not a URL`;
  }
  if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") return `hosts.${host}.url has a query, a fragment or credentials: give the origin and path only`;
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return undefined;
  return `hosts.${host}.url must be https:// (http:// only to this machine): the token must not cross a network in clear`;
}

export default defineComponent({
  name: NAME,
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    // Only to warn of an agent no definition has: none here is a normal state (a Worker's App with live agents only).
    const definitions = pikit.useKeyed("agent.definition");

    /** Each host's token, by host name, read at start: a host's transport reads its own only. */
    const tokens = new Map<string, string>();
    let running = false;
    /** In a Durable Object, the object's id. */
    let objectId: string | undefined;
    const transports = new Map<string, Transport>(Object.entries(config.hosts).map(([name, host]) => [name, createTransport({ endpoint: host.url, token: () => tokens.get(name) })]));
    const route = routing(config);
    /** The transport of the host `agent` is on (`undefined`: `execution`'s own sandbox, the default host's). */
    const transportOf = (agent: string | undefined): Transport => {
      if (!route.ok) throw new Error(`${NAME}: ${route.problems.join("; ")}`);
      return transports.get(agent === undefined ? route.defaultHost : route.hostOf(agent)) as Transport;
    };

    // Built now, on the default host; the sandbox is known at start (the object's id), and calls before answer that it is not running. No agent.
    const defaultName = route.ok ? route.defaultHost : (Object.keys(config.hosts)[0] as string);
    const execution = new RemoteExecutionEnv({
      transport: transports.get(defaultName) as Transport,
      sandbox: () => (running ? (objectId === undefined ? config.sandbox : `o-${objectId}`) : undefined),
    });
    pikit.provide("execution", execution);
    pikit.provide("execution.shell", execution);

    /** Each conversation sandbox's environment (one per agent of the object, or per chat and agent), kept for the App's life (its session: the sandbox's cwd). */
    const bySandbox = new Map<string, RemoteExecutionEnv>();
    const workspace: WorkspaceProvider = {
      async resolve(conversation, ctx) {
        if (!running) throw new Error(`${NAME}: the workspace was asked for while the app is not running`);
        const agent = conversation.agent;
        if (!isAgentName(agent)) throw new Error(`${NAME}: the conversation's agent ${JSON.stringify(agent.slice(0, 40))} is not an agent name (kebab-case, at most ${MAX_AGENT_LENGTH} characters)`);
        // On a server, the chat: the origin's key, the same through resets and for its delegated children.
        const sandbox = objectId === undefined ? await keySandbox(originOf(conversation).key, agent) : await objectSandbox(objectId, agent);
        // On its agent's host: the sandbox id is the same on every host, the host is chosen by the agent alone.
        const env = bySandbox.get(sandbox) ?? new RemoteExecutionEnv({ transport: transportOf(agent), agent, sandbox: () => (running ? sandbox : undefined) });
        bySandbox.set(sandbox, env);
        // Opened before it is handed out: its `cwd` is the sandbox's, and a host that refuses fails this call.
        const opened = await env.open(toChord(ctx));
        if (!opened.ok) throw opened.error;
        return { env };
      },
    };
    pikit.provide("workspace", workspace);

    return {
      async start(ctx) {
        const host = ctx.value(WORKERS_HOST);
        if (host !== undefined && host.object === undefined) {
          throw new Error(`${NAME}: this App is not a Durable Object's (WORKERS_HOST has no object): install execution-remote in the default export of pikit.config.ts, the conversation object's App, not in the Worker's.`);
        }
        if (!route.ok) throw new Error(`${NAME}: ${route.problems.join("; ")}`);
        const byUrl = new Map<string, string>();
        for (const [name, { url }] of Object.entries(config.hosts)) {
          const problem = urlProblem(name, url);
          if (problem !== undefined) throw new Error(`${NAME}: ${problem}`);
          const twin = byUrl.get(sameHostKey(url));
          if (twin !== undefined) throw new Error(`${NAME}: the hosts ${twin} and ${name} have the same url (${url}): one execution-serve, which takes one token; name it once and route both hosts' agents to it`);
          byUrl.set(sameHostKey(url), name);
        }
        const known = definitions.keys();
        const unknown = Object.keys(config.agents).filter((name) => !known.includes(name));
        if (known.length > 0 && unknown.length > 0) ctx.logger.warn(AGENTS_WARNING, { agents: unknown, defined: known });
        const sandbox = host?.object === undefined ? undefined : `o-${host.object.id}`;
        if (sandbox !== undefined && !isSandboxId(sandbox)) throw new Error(`${NAME}: the Durable Object's id makes no sandbox id (${JSON.stringify(sandbox.slice(0, 40))})`);
        const read = new Map<string, string>();
        const secretOf = (name: string) => config.hosts[name]?.tokenSecret ?? DEFAULT_TOKEN_SECRET;
        for (const name of Object.keys(config.hosts)) {
          const tokenSecret = secretOf(name);
          const secret = await secrets.get().get(tokenSecret);
          if (secret === undefined) throw new Error(`${NAME}: the secret ${tokenSecret} is not set (the token of the sandbox host ${name}, its execution-serve's)`);
          if (secret.length < MIN_TOKEN_LENGTH) throw new Error(`${NAME}: the secret ${tokenSecret} (host ${name}) is shorter than ${MIN_TOKEN_LENGTH} characters`);
          // A host never holds a token another host takes: one secret per host, and no two of the same value.
          const twin = [...read].find(([, other]) => other === secret)?.[0];
          if (twin !== undefined) throw new Error(`${NAME}: the hosts ${twin} and ${name} have the same token (${secretOf(twin)}, ${tokenSecret}): give each host its own (tokenSecret), so neither can use the other's`);
          read.set(name, secret);
        }
        for (const [name, secret] of read) tokens.set(name, secret);
        objectId = host?.object?.id;
        running = true;
      },
      async stop(ctx) {
        // Stop the commands still running, so none outlives the app (on Cloudflare, never called: the
        // host's lease stops what an evicted object left).
        const context = toChord(ctx);
        await Promise.all([execution, ...bySandbox.values()].map((env) => env.cleanup(context)));
        bySandbox.clear();
        running = false;
        tokens.clear();
      },
    };
  },
});

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
 * - **The token** (`PIKIT_SANDBOX_TOKEN`, `tokenSecret`) is read through `secrets` at start: missing,
 *   or shorter than 32 characters, the App does not start. It goes in each request's `Authorization`
 *   header to `endpoint` and nowhere else.
 * - **`endpoint`** is `https://`, or `http://` to the machine itself (`localhost`, `127.0.0.1`,
 *   `[::1]`): the token never crosses a network in clear.
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
import Type from "typebox";
import { RemoteExecutionEnv } from "./env.ts";
import { DEFAULT_TOKEN_SECRET, isAgentName, isSandboxId, MAX_AGENT_LENGTH, MAX_SANDBOX_ID_LENGTH, MIN_TOKEN_LENGTH, SANDBOX_ID } from "./protocol.ts";
import { createTransport } from "./transport.ts";

const NAME = "execution-remote";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const Config = Type.Object(
  {
    endpoint: Type.String({
      minLength: 1,
      description: "The sandbox host: where execution-serve is served (`https://sandbox.example.com`, a path prefix allowed). https://, or http:// to this machine only; checked at start.",
    }),
    tokenSecret: Type.String({ minLength: 1, default: DEFAULT_TOKEN_SECRET, description: "The name of the secret holding the shared token, not the token: config is never secret." }),
    sandbox: Type.String({
      pattern: SANDBOX_ID.source,
      maxLength: MAX_SANDBOX_ID_LENGTH,
      default: "shared",
      description: "On a server, the sandbox `execution` works in; a conversation's tools work in its own, through `workspace`.",
    }),
  },
  // A full config: `registry generate` describes setup with it too.
  { examples: [{ endpoint: "https://sandbox.example.com" }] },
);

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

/** Why `endpoint` cannot be used, or `undefined`. */
function endpointProblem(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return `endpoint ${JSON.stringify(endpoint)} is not a URL`;
  }
  if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") return "endpoint has a query, a fragment or credentials: give the origin and path only";
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return undefined;
  return `endpoint must be https:// (http:// only to this machine): the token must not cross a network in clear`;
}

export default defineComponent({
  name: NAME,
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");

    let token: string | undefined;
    let running = false;
    /** In a Durable Object, the object's id. */
    let objectId: string | undefined;
    const transport = createTransport({ endpoint: config.endpoint, token: () => token });

    // Built now; the sandbox is known at start (the object's id), and calls before answer that it is not running. No agent.
    const execution = new RemoteExecutionEnv({ transport, sandbox: () => (running ? (objectId === undefined ? config.sandbox : `o-${objectId}`) : undefined) });
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
        const env = bySandbox.get(sandbox) ?? new RemoteExecutionEnv({ transport, agent, sandbox: () => (running ? sandbox : undefined) });
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
        const problem = endpointProblem(config.endpoint);
        if (problem !== undefined) throw new Error(`${NAME}: ${problem}`);
        const sandbox = host?.object === undefined ? undefined : `o-${host.object.id}`;
        if (sandbox !== undefined && !isSandboxId(sandbox)) throw new Error(`${NAME}: the Durable Object's id makes no sandbox id (${JSON.stringify(sandbox.slice(0, 40))})`);
        const secret = await secrets.get().get(config.tokenSecret);
        if (secret === undefined) throw new Error(`${NAME}: the secret ${config.tokenSecret} is not set (the token of the sandbox host, execution-serve's)`);
        if (secret.length < MIN_TOKEN_LENGTH) throw new Error(`${NAME}: the secret ${config.tokenSecret} is shorter than ${MIN_TOKEN_LENGTH} characters`);
        token = secret;
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
        token = undefined;
      },
    };
  },
});

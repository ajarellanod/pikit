/**
 * execution-remote: the agent's files and shell in a sandbox on another machine, a host running
 * `execution-serve`, reached over HTTP with plain `fetch` (the sandbox protocol, `protocol.ts`). On
 * Cloudflare a Durable Object cannot run a VM: this is how a conversation there gets a real Linux.
 *
 * It provides `execution` and `execution.shell` (pi-durable's `ExecutionEnv`, `env.ts`) and
 * `workspace`, which the runtime asks on every tool call for the conversation's environment. Which
 * sandbox (its id, `protocol.ts`'s `SANDBOX_ID`):
 * - **In a Durable Object** (`WORKERS_HOST` has an object): the object is the conversation, so every
 *   call there works in `o-<object id>`, `execution` and `workspace` alike (a delegated child
 *   conversation, which lives in the same object, too). The id is `idFromName(key)`'s: the same for
 *   the conversation's whole life, through evictions, deploys and resets.
 * - **On a server** (no `WORKERS_HOST`): `workspace` gives each conversation key its own sandbox,
 *   `k-<SHA-256 of the key, hex>` (one key, one sandbox, through resets, as an object on Cloudflare);
 *   `execution` alone is the sandbox `sandbox` of the config (`shared`).
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
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { toChord, type WorkspaceProvider } from "@pikit/pi-adapter";
import Type from "typebox";
import { RemoteExecutionEnv } from "./env.ts";
import { DEFAULT_TOKEN_SECRET, isSandboxId, MAX_SANDBOX_ID_LENGTH, MIN_TOKEN_LENGTH, SANDBOX_ID } from "./protocol.ts";
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

/** The sandbox of a conversation key on a server: `k-` and the key's SHA-256, in hex. */
export async function keySandbox(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return `k-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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
    /** In a Durable Object, the object's sandbox. */
    let objectSandbox: string | undefined;
    const transport = createTransport({ endpoint: config.endpoint, token: () => token });

    // Built now; the sandbox is known at start (the object's id), and calls before answer that it is not running.
    const execution = new RemoteExecutionEnv({ transport, sandbox: () => (running ? (objectSandbox ?? config.sandbox) : undefined) });
    pikit.provide("execution", execution);
    pikit.provide("execution.shell", execution);

    /** On a server, each conversation key's environment, kept for the App's life (its session: the sandbox's cwd). */
    const byKey = new Map<string, RemoteExecutionEnv>();
    const workspace: WorkspaceProvider = {
      async resolve(conversation, ctx) {
        if (!running) throw new Error(`${NAME}: the workspace was asked for while the app is not running`);
        let env = execution;
        if (objectSandbox === undefined) {
          const sandbox = await keySandbox(conversation.key);
          env = byKey.get(sandbox) ?? new RemoteExecutionEnv({ transport, sandbox: () => (running ? sandbox : undefined) });
          byKey.set(sandbox, env);
        }
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
        objectSandbox = sandbox;
        running = true;
      },
      async stop(ctx) {
        // Stop the commands still running, so none outlives the app (on Cloudflare, never called: the
        // host's lease stops what an evicted object left).
        const context = toChord(ctx);
        await Promise.all([execution, ...byKey.values()].map((env) => env.cleanup(context)));
        byKey.clear();
        running = false;
        token = undefined;
      },
    };
  },
});

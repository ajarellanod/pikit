/**
 * execution-cloudflare-sandbox's Worker half: the route execution-remote calls,
 * `POST /execution/v1/sandboxes/:sandbox/:operation`, with execution-serve's checks, in its order:
 *
 * 1. **The token first**: `Authorization: Bearer <PIKIT_SANDBOX_TOKEN>` (`tokenSecret`, read through
 *    `secrets` at start: missing or shorter than 32 characters, the App does not start), compared in
 *    constant time as SHA-256 digests; only the digest is kept. Anything else is `401` before the URL's
 *    sandbox or the body are looked at.
 * 2. **The sandbox id as sent** (no percent-decoding) against the protocol's grammar, the operation
 *    among the protocol's, `Pikit-Agent` an agent's name: `400` / `404` before any object is asked.
 * 3. **The body**: at most `maxRequestBytes` (`413`), JSON, and the operation's schema (`400`).
 * 4. **The sandbox's object**: `getByName(objectName(sandbox, agent))` of the `Sandbox` namespace
 *    (`binding`), one per sandbox id and agent, asked by RPC (`serve`) within `callSeconds` past the
 *    request's own `wait`: an object that never answers (its container never started) is `503`, as one
 *    that fails.
 *
 * `component.json`'s `apps.worker` names this export (`worker`): `pikit add` puts it in
 * `export const worker` of the host's pikit.config.ts.
 */

import { defineComponent } from "@pikit/core";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import Type from "typebox";
import Value from "typebox/value";
import { within } from "./container.ts";
import { AGENT_HEADER, DEFAULT_TOKEN_SECRET, isAgentName, isOperation, isSandboxId, MAX_AGENT_LENGTH, MAX_SANDBOX_ID_LENGTH, MIN_TOKEN_LENGTH, PROTOCOL_PATH, PROTOCOL_STATUS, type ProtocolFailure, REQUESTS, ROUTE_KEY } from "./protocol.ts";
import { objectName, type SandboxReply, type SandboxRequest } from "./sandbox.ts";

export const WORKER_NAME = "execution-cloudflare-sandbox-worker";

/** What is used of the `Sandbox` Durable Object namespace: an object by name, and its RPC. */
export interface SandboxNamespace {
  getByName(name: string): { serve(request: SandboxRequest): Promise<SandboxReply> };
}

const Config = Type.Object({
  /** The name of the secret holding the shared token, not the token. */
  tokenSecret: Type.String({ minLength: 1, default: DEFAULT_TOKEN_SECRET }),
  /** The binding of the `Sandbox` Durable Object namespace in `wrangler.jsonc`. */
  binding: Type.String({ minLength: 1, default: "SANDBOX" }),
  /** Larger request bodies are refused (`413`). */
  maxRequestBytes: Type.Integer({ minimum: 1024, maximum: 32 * 1024 * 1024, default: 32 * 1024 * 1024 }),
  /** How long the object may take past the request's own `wait`: a new container (8 to 10 s) and its restore included. */
  callSeconds: Type.Integer({ minimum: 1, maximum: 120, default: 55 }),
});

function failure(code: ProtocolFailure["error"]["code"], message: string): Response {
  const body: ProtocolFailure = { error: { code, message } };
  return Response.json(body, { status: PROTOCOL_STATUS[code], ...(code === "unauthorized" && { headers: { "www-authenticate": 'Bearer realm="execution-cloudflare-sandbox"' } }) });
}

export const worker = defineComponent({
  name: WORKER_NAME,
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    let expected: Uint8Array | undefined;
    let sandboxes: SandboxNamespace | undefined;

    pikit.provideKeyed("http.route", ROUTE_KEY, async (request: Request, ctx) => {
      const namespace = sandboxes;
      if (namespace === undefined || expected === undefined) return failure("unavailable", "execution-cloudflare-sandbox is not running");
      const presented = /^Bearer[ ]+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (presented === undefined || !(await matches(presented, expected))) return failure("unauthorized", "a valid bearer token is required");

      const pathname = new URL(request.url).pathname;
      const parts = pathname.startsWith(`${PROTOCOL_PATH}/`) ? pathname.slice(PROTOCOL_PATH.length + 1).split("/") : [];
      if (parts.length !== 2) return failure("invalid_request", `expected ${PROTOCOL_PATH}/<sandbox>/<operation>`);
      const [sandbox = "", operation = ""] = parts;
      if (!isSandboxId(sandbox)) return failure("invalid_request", `the sandbox id is not one (kebab-case, lowercase, at most ${MAX_SANDBOX_ID_LENGTH} characters)`);
      if (!isOperation(operation)) return failure("unknown_operation", `no operation ${JSON.stringify(operation.slice(0, 40))}`);
      const agent = request.headers.get(AGENT_HEADER) ?? undefined;
      if (agent !== undefined && !isAgentName(agent)) return failure("invalid_request", `Pikit-Agent is not an agent's name (kebab-case, at most ${MAX_AGENT_LENGTH} characters): ${JSON.stringify(agent.slice(0, 40))}`);

      const length = Number(request.headers.get("content-length") ?? "0");
      if (length > config.maxRequestBytes) return failure("too_large", `the body is larger than ${config.maxRequestBytes} bytes`);
      const text = await request.text();
      if (text.length > config.maxRequestBytes) return failure("too_large", `the body is larger than ${config.maxRequestBytes} bytes`);
      let body: unknown;
      try {
        body = JSON.parse(text === "" ? "{}" : text);
      } catch {
        return failure("invalid_request", "the body is not JSON");
      }
      const schema = REQUESTS[operation];
      if (!Value.Check(schema, body)) {
        const [first] = Value.Errors(schema, body);
        return failure("invalid_request", `${operation}: ${first?.instancePath || "body"} ${first?.message ?? "is not valid"}`);
      }

      const wait = typeof (body as { wait?: unknown }).wait === "number" ? (body as { wait: number }).wait : 0;
      const forwarded: SandboxRequest = { sandbox, operation, body, ...(agent !== undefined && { agent }) };
      let reply: SandboxReply;
      try {
        reply = await within(namespace.getByName(objectName(sandbox, agent)).serve(forwarded), wait + config.callSeconds * 1000, "the sandbox's object");
      } catch (error) {
        // The client learns only that it failed; the log says why.
        ctx.logger.error("execution-cloudflare-sandbox: the sandbox's object did not answer", { sandbox, agent, operation, error: error instanceof Error ? error.message : String(error) });
        return failure("unavailable", "the sandbox did not answer (the host's log says why)");
      }
      return reply.ok ? Response.json(reply.answer) : failure(reply.code, reply.message);
    });

    return {
      async start(ctx) {
        const token = await secrets.get().get(config.tokenSecret);
        if (token === undefined) throw new Error(`${WORKER_NAME}: the secret ${config.tokenSecret} is not set (the token execution-remote sends; for example \`openssl rand -hex 32\`)`);
        if (token.length < MIN_TOKEN_LENGTH) throw new Error(`${WORKER_NAME}: the secret ${config.tokenSecret} is shorter than ${MIN_TOKEN_LENGTH} characters`);
        const host = ctx.value(WORKERS_HOST);
        if (host === undefined || host.object !== undefined) throw new Error(`${WORKER_NAME}: runs only in the Worker's App on Cloudflare (export const worker of pikit.config.ts)`);
        const namespace = host.env[config.binding] as SandboxNamespace | undefined;
        if (typeof namespace?.getByName !== "function") throw new Error(`${WORKER_NAME}: no Durable Object namespace bound as ${config.binding} (wrangler.jsonc's durable_objects, this component's README)`);
        expected = await digest(token);
        sandboxes = namespace;
      },
      stop() {
        expected = undefined;
        sandboxes = undefined;
      },
    };
  },
});

const encode = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(text));

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encode(text)));
}

/** Whether `presented` is the token whose digest is `expected`, in time independent of both. */
async function matches(presented: string, expected: Uint8Array): Promise<boolean> {
  const actual = await digest(presented);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  return difference === 0;
}

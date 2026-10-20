/**
 * execution-serve: this App's sandboxes, over HTTP, for `execution-remote` (the sandbox protocol,
 * `protocol.ts`). A sandbox host is a server App: server-bun, this component, and a provider of
 * `workspace` whose environments are sandboxes (execution-gondolin's micro-VMs; workspace-local over
 * execution-local for a trial, which is not a sandbox).
 *
 * - **One route**, `POST /execution/v1/sandboxes/:sandbox/:operation` (`http.route`), served by
 *   server-bun. Every request is one sandbox's: its id is the URL's, checked against `SANDBOX_ID` as
 *   it is (no percent-decoding), before anything else is asked.
 * - **Authenticated** by a shared token (`Authorization: Bearer`), the secret `PIKIT_SANDBOX_TOKEN`
 *   (`tokenSecret`) read through `secrets` at start: missing or shorter than 32 characters, the App
 *   does not start. Compared in constant time, as SHA-256 digests (as admin-auth-token does); only
 *   the digest is kept. A request without it is `401` before its body is read.
 * - **A sandbox is `workspace.resolve`** of the `ConversationRef` built from its id and the request's
 *   `Pikit-Agent` header (`sandboxConversation`): `conversationId` `remote-<id>` (the prefix keeps
 *   them apart from the host App's own conversations, which its runtime numbers `1`, `2`…; held to
 *   `^[A-Za-z0-9_-]{1,128}$`), `agent` the header's agent (execution-gondolin chooses its machine by
 *   it), or `_<id>` without one (an agentless sandbox, which gets the base), `key`
 *   `execution-serve:<id>`. An id that makes no such ref, or a malformed header, is `400`, never
 *   cleaned up.
 * - **Readers and commands stay with their sandbox and agent** (`host.ts`): another sandbox's handle,
 *   or one of the same sandbox id under another `Pikit-Agent`, is unknown.
 *   A command nobody reads for `leaseSeconds` is stopped and forgotten, so a client that went away (a
 *   Durable Object evicted mid-command) leaves nothing running.
 * - **Credentials (SPEC C7).** The token authenticates the client to this host and goes no further:
 *   no variable, file or command of a sandbox receives it, and nothing secret arrives through the
 *   protocol. A sandbox that needs a credential gets it from its provider, injected outside the
 *   sandbox (execution-gondolin does it at its network layer).
 *
 * Target: `server` (a sandbox is a VM, a container or a process: a server's).
 */

import { type AppContext, BACKGROUND_CONTEXT, defineComponent } from "@pikit/core";
import Type from "typebox";
import Value from "typebox/value";
import type { ConversationRef } from "@pikit/contracts";
import { ProtocolError, SandboxHost, sandboxConversation } from "./host.ts";
import { AGENT_HEADER, DEFAULT_TOKEN_SECRET, isOperation, isSandboxId, MAX_SANDBOX_ID_LENGTH, MIN_TOKEN_LENGTH, PROTOCOL_PATH, PROTOCOL_STATUS, type ProtocolFailure, REQUESTS, ROUTE_KEY } from "./protocol.ts";

const Config = Type.Object({
  /** The name of the secret holding the shared token, not the token: config is never secret. */
  tokenSecret: Type.String({ minLength: 1, default: DEFAULT_TOKEN_SECRET }),
  /** A command nobody reads this long is stopped, then forgotten; a reader unused this long is closed. */
  leaseSeconds: Type.Integer({ minimum: 10, maximum: 3600, default: 120 }),
  /** Larger request bodies are refused (`413`): a file written in one request, in base64, plus its JSON. server-bun's own bound (32 MiB) applies first. */
  maxRequestBytes: Type.Integer({ minimum: 1024, default: 32 * 1024 * 1024 }),
});

const NAME = "execution-serve";

function failure(code: ProtocolFailure["error"]["code"], message: string): Response {
  const body: ProtocolFailure = { error: { code, message } };
  return Response.json(body, { status: PROTOCOL_STATUS[code], ...(code === "unauthorized" && { headers: { "www-authenticate": 'Bearer realm="execution-serve"' } }) });
}

export default defineComponent({
  name: NAME,
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    const workspace = pikit.use("workspace");

    /** The token's digest, from start to stop. */
    let expected: Uint8Array | undefined;
    let host: SandboxHost | undefined;
    let sweeper: ReturnType<typeof setInterval> | undefined;

    pikit.provideKeyed("http.route", ROUTE_KEY, async (request: Request, ctx: AppContext) => {
      const running = host;
      if (running === undefined || expected === undefined) return failure("unavailable", "execution-serve is not running");
      // The token first: nothing about a sandbox is said to whoever does not hold it.
      const presented = /^Bearer[ ]+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (presented === undefined || !(await matches(presented, expected))) return failure("unauthorized", "a valid bearer token is required");

      // Two segments after PROTOCOL_PATH, read as sent (never percent-decoded).
      const pathname = new URL(request.url).pathname;
      const parts = pathname.startsWith(`${PROTOCOL_PATH}/`) ? pathname.slice(PROTOCOL_PATH.length + 1).split("/") : [];
      if (parts.length !== 2) return failure("invalid_request", `expected ${PROTOCOL_PATH}/<sandbox>/<operation>`);
      const [sandbox = "", operation = ""] = parts;
      if (!isSandboxId(sandbox)) return failure("invalid_request", `the sandbox id is not one (kebab-case, lowercase, at most ${MAX_SANDBOX_ID_LENGTH} characters)`);
      if (!isOperation(operation)) return failure("unknown_operation", `no operation ${JSON.stringify(operation.slice(0, 40))}`);
      // Refused at the door when it makes no ConversationRef for the provider (its conversationId, its agent).
      let conversation: ConversationRef;
      try {
        conversation = sandboxConversation(sandbox, request.headers.get(AGENT_HEADER) ?? undefined);
      } catch (error) {
        if (error instanceof ProtocolError) return failure(error.code, error.message);
        throw error;
      }

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

      try {
        return Response.json(await running.serve({ sandbox, conversation }, operation, body as never, ctx));
      } catch (error) {
        if (error instanceof ProtocolError) return failure(error.code, error.message);
        throw error;
      }
    });

    return {
      async start(ctx) {
        const token = await secrets.get().get(config.tokenSecret);
        if (token === undefined) throw new Error(`${NAME}: the secret ${config.tokenSecret} is not set (the token execution-remote sends; for example \`openssl rand -hex 32\`)`);
        if (token.length < MIN_TOKEN_LENGTH) throw new Error(`${NAME}: the secret ${config.tokenSecret} is shorter than ${MIN_TOKEN_LENGTH} characters`);
        expected = await digest(token);
        const background = ctx.derive(() => BACKGROUND_CONTEXT);
        const sandboxes = new SandboxHost({
          leaseMs: config.leaseSeconds * 1000,
          now: () => background.clock.now(),
          resolve: async ({ sandbox, conversation }, requestCtx) => {
            try {
              return (await workspace.get().resolve(conversation, requestCtx)).env;
            } catch (error) {
              // The client learns only that it failed; the log says why (a provider's message may hold host paths).
              requestCtx.logger.error(`${NAME}: the sandbox could not be resolved`, { sandbox, agent: conversation.agent, error: error instanceof Error ? error.message : String(error) });
              throw new ProtocolError("unavailable", "the sandbox could not be resolved");
            }
          },
        });
        host = sandboxes;
        sweeper = setInterval(
          () =>
            void sandboxes.sweep().catch((error: unknown) => {
              background.logger.error(`${NAME}: sweeping expired commands failed`, { error: error instanceof Error ? error.message : String(error) });
            }),
          Math.min(config.leaseSeconds * 250, 30_000),
        );
      },
      async stop() {
        clearInterval(sweeper);
        sweeper = undefined;
        const running = host;
        host = undefined;
        expected = undefined;
        await running?.close();
      },
    };
  },
});

// Copied: Workers' types say `encode` may answer a view of a shared buffer, which `crypto.subtle` does not take.
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

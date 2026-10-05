/**
 * admin-auth-token: who is an operator, by a bearer token (`admin.auth`, @pikit/contracts' admin.ts).
 * An admin API route (admin-api's, a component's own) asks `verify(request)`; a request that carries
 * `Authorization: Bearer <PIKIT_ADMIN_TOKEN>` is the operator `operator`, any other is not.
 *
 * - **The token is a secret**, read through `secrets` at start: an environment variable on a server
 *   (secrets-env), a Worker secret on Cloudflare (secrets-cloudflare). Without it, or shorter than 32
 *   characters, the app does not start: a dashboard nobody can open, or anybody can, is a broken
 *   deployment. `pikit configure --generate PIKIT_ADMIN_TOKEN` writes one.
 * - **Compared in constant time**, as SHA-256 digests, so a wrong token's timing says nothing of the
 *   right one. Only the digest is kept in memory; the token is in no log line, error or operator.
 * - **Headers only.** The body is the route's. A browser's `EventSource` cannot send a header: the
 *   dashboard streams server-sent events with `fetch`, which can.
 *
 * Replace it to sign operators in another way (an SSO proxy's header, Cloudflare Access): a
 * component that provides `admin.auth` and passes `createAdminAuthConformance`.
 *
 * Targets: `server` and `durable`: it uses only `secrets` and Web Crypto.
 */

import { defineComponent } from "@pikit/core";
import type { AdminAuth, Operator } from "@pikit/contracts";
import Type from "typebox";

/** The secret holding the operators' token, by default. */
export const TOKEN_SECRET = "PIKIT_ADMIN_TOKEN";
/** Shorter tokens are refused at start: an operator's token guards every conversation. */
export const MIN_TOKEN_LENGTH = 32;

const Config = Type.Object({
  /** The name of the secret holding the token, not the token: config is never secret. */
  tokenSecret: Type.String({ minLength: 1, default: TOKEN_SECRET }),
});

/** The operator a valid token is. One token, one operator. */
const OPERATOR: Operator = Object.freeze({ id: "operator" });

export default defineComponent({
  name: "admin-auth-token",
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    /** The token's digest, from start to stop. */
    let expected: Uint8Array | undefined;

    const auth: AdminAuth = {
      async verify(request) {
        const presented = /^Bearer[ ]+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1];
        if (presented === undefined || expected === undefined) return undefined;
        return (await matches(presented, expected)) ? OPERATOR : undefined;
      },
    };
    pikit.provide("admin.auth", auth);

    return {
      async start() {
        const token = await secrets.get().get(config.tokenSecret);
        if (token === undefined) throw new Error(`admin-auth-token: the secret ${config.tokenSecret} is not set`);
        if (token.length < MIN_TOKEN_LENGTH) throw new Error(`admin-auth-token: the secret ${config.tokenSecret} is shorter than ${MIN_TOKEN_LENGTH} characters`);
        expected = await digest(token);
      },
      stop() {
        expected = undefined;
      },
    };
  },
});

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Whether `presented` is the token whose digest is `expected`, in time independent of both. */
async function matches(presented: string, expected: Uint8Array): Promise<boolean> {
  const actual = await digest(presented);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  return difference === 0;
}

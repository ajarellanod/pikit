/**
 * Bearer-token authentication for channel-http. The token is a secret (`PIKIT_HTTP_TOKEN`), read
 * once at start and kept in memory only.
 *
 * Tokens are compared as SHA-256 digests, byte by byte without stopping early, so the time a
 * comparison takes says nothing about how much of a guess was right, nor about the token's length.
 */

export const TOKEN_SECRET = "PIKIT_HTTP_TOKEN";
/** Shorter tokens are refused at start: they can be guessed. `openssl rand -hex 32` makes a good one. */
export const MIN_TOKEN_LENGTH = 16;

export type Digest = Uint8Array;

export async function digest(text: string): Promise<Digest> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** The token of an `Authorization: Bearer <token>` header, or `undefined`. */
export function bearerToken(header: string | null): string | undefined {
  const match = /^Bearer[ ]+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1];
}

/** Whether `presented` is the token whose digest is `expected`, in time independent of both. */
export async function matches(presented: string, expected: Digest): Promise<boolean> {
  const actual = await digest(presented);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  return difference === 0;
}

// Owner: transport. A piece's two ids for Google (features/channel-google-chat.md "Answers": idempotent).
/**
 * From a piece's key (`${answerKey}#${index}`, stable across retries and restarts), its SHA-256 hash
 * (WebCrypto) gives:
 * - `requestId`: a UUID made of the hash's first 16 bytes (version 4 and variant bits set, as Google
 *   recommends a UUID): a quick repeat returns the first message;
 * - `messageId`: `client-` and the hash's first 56 hexadecimal characters (63 characters, lowercase:
 *   Google's limit): a late repeat, once Google forgot the `requestId`, is refused (`ALREADY_EXISTS`)
 *   and the transport reads that message instead.
 *
 * The placeholder of an answer is created under its piece `#0`'s ids, so the first piece finds it
 * with no record (placeholder.ts).
 */

/** A piece's ids. */
export interface PieceIds {
  requestId: string;
  messageId: string;
}

/** The ids of the piece whose key is `pieceKey`. Pure: the same key, the same ids, everywhere. */
export async function pieceIds(pieceKey: string): Promise<PieceIds> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pieceKey)));
  const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const uuid = hash.slice(0, 16);
  uuid[6] = ((uuid[6] ?? 0) & 0x0f) | 0x40;
  uuid[8] = ((uuid[8] ?? 0) & 0x3f) | 0x80;
  const u = hex(uuid);
  return {
    requestId: `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20, 32)}`,
    messageId: `client-${hex(hash).slice(0, 56)}`,
  };
}

/** The name of the message created in `space` under `messageId`: `<space>/messages/<messageId>`. */
export function messageNameOf(space: string, messageId: string): string {
  return `${space}/messages/${messageId}`;
}

/** The answer's key of a piece's key (`${answerKey}#${index}`), and its index. */
export function pieceOf(pieceKey: string): { answerKey: string; index: number } {
  const at = pieceKey.lastIndexOf("#");
  const index = at < 0 ? Number.NaN : Number(pieceKey.slice(at + 1));
  if (!Number.isInteger(index) || index < 0) throw new Error(`channel-google-chat: "${pieceKey}" is not a piece's key (<answer key>#<index>)`);
  return { answerKey: pieceKey.slice(0, at), index };
}

/** The key of an answer's piece `index`: what `startAnswerDelivery` gives it. */
export const pieceKeyOf = (answerKey: string, index: number): string => `${answerKey}#${index}`;

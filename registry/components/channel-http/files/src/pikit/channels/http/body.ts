/**
 * The body of `POST /v1/messages`, checked before anything else runs:
 *
 *   { "conversationId": "c1", "text": "hello", "messageId": "m-1" }
 *
 * - `conversationId` names the client's conversation. It goes in URLs (`/v1/conversations/:id`),
 *   so it is limited to URL-safe characters.
 * - `messageId`, optional, is the message's identity (the request id). The same `messageId` sent
 *   again to the same conversation is a duplicate and does not run again. Without it, each POST is
 *   a new message.
 */

import Type, { type Static } from "typebox";
import Value from "typebox/value";

/** URL-safe characters, 1 to 128 of them. */
export const CONVERSATION_ID = "^[A-Za-z0-9._~-]{1,128}$";
const MESSAGE_ID = "^[A-Za-z0-9._~:-]{1,128}$";

export const MessageBody = Type.Object(
  {
    conversationId: Type.String({ pattern: CONVERSATION_ID }),
    text: Type.String({ minLength: 1 }),
    messageId: Type.Optional(Type.String({ pattern: MESSAGE_ID })),
  },
  { additionalProperties: false },
);
export type MessageBody = Static<typeof MessageBody>;

/** The body, or what is wrong with it (said to the client; it never quotes the body). */
export async function readMessageBody(request: Request): Promise<{ body: MessageBody } | { problem: string }> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { problem: "the body is not JSON" };
  }
  if (Value.Check(MessageBody, parsed)) return { body: parsed };
  const [first] = Value.Errors(MessageBody, parsed);
  return { problem: `${first?.instancePath || "the body"}: ${first?.message ?? "is invalid"}` };
}

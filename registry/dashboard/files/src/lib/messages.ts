/**
 * A transcript's messages in pi-ai's JSON (the runtime's own words, SPEC §5), as the API gives them,
 * and a tool running now: the types `components/pikit/message.tsx` shows and `transcript.ts` folds.
 * Types, `OPERATOR_NOTE` and `imageSrc`.
 */

/**
 * How every message from the dashboard starts, as the agent reads it: admin-api's `OPERATOR_NOTE`
 * (`admin-api.ts`), here too so the shared pieces need no admin client. The kit's tests check they are
 * the same.
 */
export const OPERATOR_NOTE = "[From the operator, in the pikit dashboard";

export type Text = { type: "text"; text: string };
export type Thinking = { type: "thinking"; thinking: string; redacted?: boolean };
/** An image: its bytes inline (base64), or where to read it (a page that serves its images by URL, as channel-web's chat does). */
export type Image = { type: "image"; mimeType: string; data: string } | { type: "image"; url: string; mimeType?: string };
export type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type Message =
  | { role: "system"; content?: unknown; timestamp?: number }
  | { role: "user"; content: string | (Text | Image)[]; timestamp?: number }
  | { role: "assistant"; content: (Text | Thinking | ToolCall)[]; stopReason?: string; errorMessage?: string; timestamp?: number }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: (Text | Image)[]; isError?: boolean; timestamp?: number };

export type UserMessage = Extract<Message, { role: "user" }>;
export type AssistantMessage = Extract<Message, { role: "assistant" }>;
export type ToolResultMessage = Extract<Message, { role: "toolResult" }>;

/** What an `<img>` shows of `image`: its URL, or its bytes as a `data:` URL. */
export const imageSrc = (image: Image): string => ("url" in image ? image.url : `data:${image.mimeType};base64,${image.data}`);

/** A tool running now, from the live events (`transcript.ts`). */
export interface RunningTool {
  callId: string;
  name: string;
  output: string;
}

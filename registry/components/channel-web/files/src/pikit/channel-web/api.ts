/**
 * The chat API's JSON (`/chat/api`, features/channel-web.md): what every route of channel-web answers,
 * typed. The page (`src/chat/`, a project of its own) keeps an identical copy, `src/chat/src/lib/chat-api.ts`:
 * no imports, so it compiles there too. Change both together; the kit's tests check they are the same.
 *
 * Every route but `GET /chat/api/config` and better-auth's (`/chat/api/auth/*`) needs a user's session
 * (the `pikit_chat` cookies, path `/chat/`): without one, `401`. A route that changes something also
 * needs the header `x-pikit-chat: 1` (`CHAT_CLIENT_HEADER`): without it, `400`. An error is a
 * `ChatError` with its status.
 *
 * A conversation is named by its chat id (`ChatConversation.id`, a UUID the server made): the
 * conversation key is `web:<user id>:<chat id>`, built from the session's user. A chat id of another
 * user's is `404`, as one that never existed.
 *
 * | Route | Answer |
 * |---|---|
 * | `GET /chat/api/config` | `ChatConfig` (no session needed) |
 * | `/chat/api/auth/*` | better-auth's own routes (sign in, sign up, OAuth callbacks, links, sessions) |
 * | `GET /chat/api/me` | `ChatMe` |
 * | `GET /chat/api/conversations?limit&cursor` | `ChatPage<ChatConversation>`, newest activity first |
 * | `POST /chat/api/conversations` | `ChatSendRequest` → `201 ChatStartResponse` |
 * | `GET /chat/api/conversations/:id` | `ChatConversation` |
 * | `PATCH /chat/api/conversations/:id` | `ChatRenameRequest` → `200 ChatConversation` |
 * | `DELETE /chat/api/conversations/:id` | `204`: out of the list (nothing of the runtime's is deleted) |
 * | `GET /chat/api/conversations/:id/messages?limit&cursor` | `ChatPage<ChatMessage>`, newest first |
 * | `POST /chat/api/conversations/:id/messages` | `ChatSendRequest` → `202 ChatSendResponse` |
 * | `GET /chat/api/conversations/:id/events` | server-sent events, one `ChatEvent` per `data:` line, `state` first |
 * | `POST /chat/api/conversations/:id/abort` | `200 ChatAbortResponse` |
 */

/** The header every request that changes something carries: `x-pikit-chat: 1`. */
export const CHAT_CLIENT_HEADER = "x-pikit-chat";

/** The prefix of a chat message's request id: `web:<id>`. */
export const CHAT_REQUEST_PREFIX = "web:";

/** The images a user may attach to a message: these types, `MAX_IMAGES` of `MAX_IMAGE_BYTES` at most. */
export const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** On Cloudflare (`ChatConfig.target` `durable`), the images of one message in all (one Durable Object row). */
export const MAX_DURABLE_IMAGE_BYTES = 1024 * 1024;
/** The longest message, in characters. */
export const MAX_TEXT = 32_000;
/** The longest title, in characters. */
export const TITLE_MAX = 60;

/** One way to sign in, as the sign-in page offers it. */
export type ChatSignInMethod =
  /** Email and password (`/chat/api/auth/sign-in/email`, `/sign-up/email`). */
  | { kind: "password" }
  /** A link by email (`/chat/api/auth/sign-in/magic-link`): only when the App can send email. */
  | { kind: "magic-link" }
  /** A built-in provider of better-auth (`/chat/api/auth/sign-in/social`, `{ provider: id }`). */
  | { kind: "social"; id: string; name: string }
  /** Another OAuth2/OIDC platform (`/chat/api/auth/sign-in/oauth2`, `{ providerId: id }`). */
  | { kind: "oidc"; id: string; name: string };

/** What the page needs before anyone signed in. */
export interface ChatConfig {
  /** The assistant's name, as the page titles itself. */
  name: string;
  /** `server` or `durable`: the image limits differ (`MAX_DURABLE_IMAGE_BYTES`). */
  target: string;
  methods: ChatSignInMethod[];
  /**
   * Whether someone with no account may make one: `invite` none (only an operator's invitation),
   * `allowlist` those whose email the operator allows, `open` anyone.
   */
  signUp: "invite" | "allowlist" | "open";
  /** Whether the App sends email: "forgot password" and links by email work. */
  email: boolean;
}

/** The signed-in user. */
export interface ChatUser {
  id: string;
  name: string;
  email: string;
  /** An avatar's URL (a provider's), when there is one. */
  image?: string;
}

export interface ChatMe {
  user: ChatUser;
  /** How this user can sign in: `password`, and the ids of the providers linked (`google`, an OIDC id). */
  methods: string[];
}

/** One page, and the cursor of the next (absent on the last page). */
export interface ChatPage<T> {
  items: T[];
  next?: string;
}

/** One of the user's conversations. */
export interface ChatConversation {
  /** Its chat id: what `:id` is in the routes. */
  id: string;
  /** Its title: the user's, else its first message, cleaned (at most `TITLE_MAX` characters). */
  title: string;
  /** Whether a run is going now. */
  busy: boolean;
  /** Epoch ms of its newest message. */
  lastActivity: number;
  /** Epoch ms it was made. */
  createdAt: number;
}

/** An image attached to a message. */
export interface ChatImage {
  /** One of `IMAGE_TYPES`. */
  mimeType: string;
  /** Its bytes, base64 (standard, padded), without a `data:` prefix. */
  data: string;
}

/** One message of a conversation: the user's, or an answer. */
export interface ChatMessage {
  /** Unique in the conversation: a user's message is its request id; an answer, its own. */
  id: string;
  role: "user" | "assistant";
  /** Markdown, for an answer. */
  text: string;
  images?: ChatImage[];
  /** Epoch ms. */
  at: number;
  /**
   * A user's message only: `pending` until its run ends, then `answered`, `failed` (the run failed:
   * send it again) or `aborted` (stopped).
   */
  state?: "pending" | "answered" | "failed" | "aborted";
}

export interface ChatSendRequest {
  /** May be empty when it has images. At most `MAX_TEXT` characters. */
  text: string;
  images?: ChatImage[];
  /**
   * Its identity: the same one sent again does not run again. `web:` then 1 to 118 of
   * `A-Z a-z 0-9 . _ ~ : -`. Absent, the server makes one.
   */
  requestId?: string;
}

export interface ChatSendResponse {
  requestId: string;
  /** `started`: a run started; `queued`: it waits for the run going; `duplicate`: already there. */
  admission: "started" | "queued" | "duplicate";
}

export interface ChatStartResponse extends ChatSendResponse {
  /** The new conversation's chat id. */
  id: string;
}

export interface ChatRenameRequest {
  /** 1 to `TITLE_MAX` characters. */
  title: string;
}

export interface ChatAbortResponse {
  id: string;
}

/**
 * One live event of a conversation. The first is a `state`. `partial` and `tool` come only while the
 * user has a message not answered yet; `message` says something was stored: read the messages again.
 */
export type ChatEvent =
  /** Whether a run is going. */
  | { type: "state"; busy: boolean }
  /** The answer as written so far (the whole text, not a delta); `""` when a new one starts. */
  | { type: "partial"; text: string }
  /** A tool runs (`running`) or ended (`done`): its name only. */
  | { type: "tool"; name: string; state: "running" | "done" }
  /** A message or an answer was stored. */
  | { type: "message"; id: string };

export interface ChatError {
  /**
   * `unauthorized` (401), `invalid_request` (400), `not_found` (404), `too_large` (413), `denied`
   * (403: the router refused the message, `message` says why), `rejected` (422: a stage refused it),
   * `no_route` (500: no router installed), `unavailable` (503: on Cloudflare an object did not answer).
   */
  error: string;
  message?: string;
}

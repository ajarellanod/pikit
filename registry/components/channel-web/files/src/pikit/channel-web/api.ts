/**
 * The chat API's JSON (`/chat/api`, features/completed/channel-web.md): what every route of channel-web answers,
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
 * A user organizes their conversations in projects (`ChatProject`, their own: another user's project id
 * is `404` too). A conversation's project is fixed when it is made (`ChatStartRequest.project`): the
 * project is the place its conversations share (what the App keeps per space: memory, instructions,
 * files). A project with conversations is not deleted (`409 not_empty`): delete them first.
 *
 * A message whose text is `/name args` for one of `ChatConfig.commands` runs that command in its
 * conversation instead of reaching the agent: the answer says what came of it (`ChatSendResponse.command`),
 * for the page to show apart; nothing of it is in the transcript. The same request id never runs it twice.
 * A first message that is a command makes the conversation (empty, titled `New conversation`): the
 * command ran in it, in its project's space.
 *
 * A conversation reads as the dashboard's does (features/completed/chat-parity.md): a transcript of entries
 * (`ChatTranscriptEntry`, admin-api's `ApiTranscriptEntry`: pi-ai messages) and live events (`ChatEvent`,
 * admin-api's `ApiEvent`), both cut to what the operator lets users see (`ChatConfig.visibility`).
 *
 * | Route | Answer |
 * |---|---|
 * | `GET /chat/api/config` | `ChatConfig` (no session needed) |
 * | `/chat/api/auth/*` | better-auth's own routes (sign in, sign up, OAuth callbacks, links, sessions) |
 * | `GET /chat/api/me` | `ChatMe`: the user, their sign-in methods, and the assistant Routing picks for their new chat (`suggestedAgent`) |
 * | `GET /chat/api/projects` | `ChatPage<ChatProject>`: every project of the user's (at most `MAX_PROJECTS`), by name |
 * | `POST /chat/api/projects` | `ChatProjectRequest` → `201 ChatProject` (`400` past `MAX_PROJECTS`) |
 * | `PATCH /chat/api/projects/:id` | `ChatProjectRequest` → `200 ChatProject` |
 * | `DELETE /chat/api/projects/:id` | `204`; `409 not_empty` while it has conversations (archived ones too; deleted ones not) |
 * | `GET /chat/api/conversations?limit&cursor&archived&q&project` | `ChatPage<ChatConversation>`, newest activity first: those not archived, or with `archived=1` the archived ones; with `q`, only those whose title holds it (any case); with `project`, only that project's (`none`: those of no project) |
 * | `POST /chat/api/conversations` | `ChatStartRequest` → `201 ChatStartResponse` (a command too: the conversation is made, the command ran in it; `429` past `ChatConfig`'s rate; `400` for an `agent` not in `ChatConfig.agents`; `404` for a `project` not the user's) |
 * | `GET /chat/api/conversations/:id` | `ChatConversation` |
 * | `PATCH /chat/api/conversations/:id` | `ChatRenameRequest` → `200 ChatConversation` |
 * | `POST /chat/api/conversations/:id/archive`, `…/unarchive` | `200 ChatConversation`: listed apart, or back in the list (new activity lists an archived one again) |
 * | `DELETE /chat/api/conversations/:id` | `204`: out of the list, gone for the user (nothing of the runtime's is deleted) |
 * | `GET /chat/api/conversations/:id/transcript?limit&cursor` | `ChatPage<ChatTranscriptEntry>`, newest first, at most `PAGE_JSON_MAX` characters of stored JSON (then fewer than `limit`, and `next`) |
 * | `GET /chat/api/conversations/:id/messages/:messageId/images/:n` | the bytes of image `n` of the user's message `messageId` (a user message's image part's `url`), its type, cached privately |
 * | `POST /chat/api/conversations/:id/messages` | `ChatSendRequest` → `202 ChatSendResponse` |
 * | `GET /chat/api/conversations/:id/events` | server-sent events, one `ChatEvent` per `data:` line, a `snapshot` first |
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
/** The most a page of the transcript carries, in characters of its entries' stored JSON: past it a page is shorter than its `limit` (never empty). */
export const PAGE_JSON_MAX = 1024 * 1024;
/** The longest search (`q`), in characters. */
export const SEARCH_MAX = 200;
/** The longest project name, in characters. */
export const PROJECT_NAME_MAX = 60;
/** The most projects a user has. */
export const MAX_PROJECTS = 100;
/** `GET /chat/api/conversations?project=` for the conversations of no project. */
export const NO_PROJECT = "none";

/** One way to sign in, as the sign-in page offers it. */
export type ChatSignInMethod =
  /** Email and password (`/chat/api/auth/sign-in/email`, `/sign-up/email`). */
  | { kind: "password" }
  /** A link by email (`/chat/api/auth/sign-in/magic-link`): only when the App can send email. */
  | { kind: "magic-link" }
  /** A built-in provider of better-auth (`/chat/api/auth/sign-in/social`, `{ provider: id }`). */
  | { kind: "social"; id: string; name: string }
  /** Another OAuth2/OIDC platform: signed in the same way (`/chat/api/auth/sign-in/social`, `{ provider: id }`). */
  | { kind: "oidc"; id: string; name: string };

/**
 * What users see of a conversation, the operator's policy (a config value and a live setting). The
 * server cuts every transcript entry and live event by it when it is read: a change applies to history
 * too. Never shown, whatever it says: system prompts, an operator's messages (`dashboard:` requests) or
 * the runs only they started, another user's anything, usage or cost.
 */
export interface ChatVisibility {
  /** The model's thinking (its `thinking` blocks and deltas). */
  thinking: boolean;
  /**
   * The tools: `none` (no tool call, result or event at all), `names` (a call's name, never its arguments,
   * its output or its result's content), `full` (all of it).
   */
  tools: "none" | "names" | "full";
  /** Whether the page shows the Context panel (the images sent; with `tools: "full"`, what searches and fetches found). */
  context: boolean;
}

/** An assistant a user may pick for a new conversation. */
export interface ChatAgent {
  name: string;
  /** One line: what it is for (a live agent's). */
  description?: string;
}

/** A command a user may type in a chat (`/name args`), as the App registered it. */
export interface ChatCommand {
  name: string;
  /** One line, for a menu. */
  description: string;
  /** What its arguments are, for a menu: `<rule>`. */
  argumentHint?: string;
}

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
  visibility: ChatVisibility;
  /** The assistants a new conversation may be made with (`ChatStartRequest.agent`); empty: no choice, the router decides. */
  agents: ChatAgent[];
  /** The commands users may type in a chat (`/name args`): those the operator allows that the App has. */
  commands: ChatCommand[];
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
  /**
   * The assistant Routing's rules choose for this user's new chat (a dry run of the router: nothing is
   * made), when it is one of `ChatConfig.agents`: the picker starts on it. Absent when there is no
   * choice, when Routing denies the user or names an agent not offered: the picker starts on the first.
   */
  suggestedAgent?: string;
}

/** One page, and the cursor of the next (absent on the last page). */
export interface ChatPage<T> {
  items: T[];
  next?: string;
}

/** One of the user's projects: a place several of their conversations share. */
export interface ChatProject {
  /** What `:id` is in the routes, and `ChatConversation.project`. */
  id: string;
  /** 1 to `PROJECT_NAME_MAX` characters. */
  name: string;
  /** Epoch ms it was made. */
  createdAt: number;
  /** How many of the user's conversations are in it (archived ones too). */
  chats: number;
}

export interface ChatProjectRequest {
  /** 1 to `PROJECT_NAME_MAX` characters. */
  name: string;
}

/** One of the user's conversations. */
export interface ChatConversation {
  /** Its chat id: what `:id` is in the routes. */
  id: string;
  /** Its title: the user's, else its first message, cleaned (at most `TITLE_MAX` characters). */
  title: string;
  /** Whether a run is going now. */
  busy: boolean;
  /** Whether the user archived it: listed apart (`?archived=1`) until new activity lists it again. */
  archived: boolean;
  /** Epoch ms of its newest message. */
  lastActivity: number;
  /** Epoch ms it was made. */
  createdAt: number;
  /** The assistant it was made with, when it is one of `ChatConfig.agents`. */
  agent?: string;
  /** The project it was made in (`ChatProject.id`), for good; absent: none. */
  project?: string;
}

/** An image a message is sent with. */
export interface ChatImage {
  /** One of `IMAGE_TYPES`. */
  mimeType: string;
  /** Its bytes, base64 (standard, padded), without a `data:` prefix. */
  data: string;
}

/**
 * One entry of a conversation's transcript, as admin-api's `ApiTranscriptEntry`: `messages` are pi-ai
 * messages (JSON), cut by `ChatConfig.visibility`.
 *
 * - **A user's message**: its `id` is its request id (`ChatSendResponse.requestId`); one `user` message,
 *   its `content` a text part (when written) then its images, each `{ type: "image", url, mimeType }`
 *   (read its bytes from `url`, with the session; never inline), its `timestamp` when it was sent;
 *   `state` says what became of it. A message sent while a run goes is in the transcript (and announced
 *   live) once that run ended: it is answered after it.
 * - **A run's message** (an answer, a tool round, a tool's result): `<request id of the run>#<its hash>`,
 *   the same id the live events announced it with (`message_end`'s `entry`): merged by id, nothing is
 *   swapped when a run ends. One message each. A run that failed or was stopped keeps what it wrote.
 */
export interface ChatTranscriptEntry {
  id: string;
  kind: "message";
  messages: unknown[];
  /**
   * A user's message only: `pending` until its run ends, then `answered`, `failed` (the run failed: send
   * it again) or `aborted` (stopped).
   */
  state?: "pending" | "answered" | "failed" | "aborted";
}

/**
 * One live event of a conversation, in the dashboard's shapes (admin-api's `ApiEvent`, pi-durable's
 * agent events), cut by `ChatConfig.visibility`. The first is a `snapshot`; a stream that fell behind
 * gets a new one, so a view is rebuilt from the last `snapshot` and the events after it.
 *
 * - `snapshot`: `run` (`{}`) while a run goes; `generation.message`, the answer being written; `tools`,
 *   `{ callId, name, status, output? }` each.
 * - `run_start`, `run_end`: a run starts, ends (any run: whether the assistant is busy).
 * - `message_start` (`message`), `message_update` (`changes`), `message_end` (`entry`: `{ id, kind, model }`,
 *   the transcript's entry, `model` its messages): the answer as it is written, then stored.
 * - `tool_execution_start` (`toolCallId`, `toolName`, `args` with `full`), `tool_execution_update`
 *   (`output`, with `full` only), `tool_execution_end`.
 * - `entry_appended`: with `entry`, an entry of the user's (a message admitted, or one released after
 *   the run it waited behind); without, something stored changed (a run's messages, a message's
 *   state): read the transcript again.
 *
 * Only a run known to answer one of the user's messages streams its messages and tools (by the request
 * ids its inputs name, or the request that started it): an operator's run streams nothing but its
 * `run_start` and `run_end`. Never an entry of the runtime's own (a system prompt, the user's message as
 * the agent read it, an operator's), usage or cost.
 */
export interface ChatEvent {
  type: string;
  [field: string]: unknown;
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

export interface ChatStartRequest extends ChatSendRequest {
  /** The assistant the conversation is made with: one of `ChatConfig.agents` (else `400`). Absent: the router decides. */
  agent?: string;
  /** The project the conversation is made in, for good: one of the user's (`ChatProject.id`, else `404`). Absent: none. */
  project?: string;
}

/** What came of a command typed in a chat: shown to its user, never in the transcript. */
export interface ChatCommandResult {
  /** The command's name, without its slash. */
  name: string;
  /**
   * `ran` (`text`: its note, when it has one), `failed` (`text`: why), or `unfinished`: the same request
   * sent again while it ran, or one that never finished (it runs at most once).
   */
  outcome: "ran" | "failed" | "unfinished";
  text?: string;
}

export interface ChatSendResponse {
  requestId: string;
  /**
   * `started`: a run started; `queued`: it waits for the run going; `duplicate`: already there;
   * `command`: it was a command, which ran (`command` says what came of it).
   */
  admission: "started" | "queued" | "duplicate" | "command";
  /** When the message was a command (`command`, or a `duplicate` of one): what came of it. */
  command?: ChatCommandResult;
}

export interface ChatStartResponse extends ChatSendResponse {
  /** The new conversation's chat id (also when its first message was a command: made, empty). */
  id: string;
}

export interface ChatRenameRequest {
  /** 1 to `TITLE_MAX` characters. */
  title: string;
}

export interface ChatAbortResponse {
  id: string;
}

export interface ChatError {
  /**
   * `unauthorized` (401), `invalid_request` (400), `not_found` (404), `too_large` (413), `rate_limited`
   * (429: too many messages a minute, `retry-after` says when to send again), `not_empty` (409: a project
   * that still has conversations), `denied`
   * (403: the router refused the message, `message` says why), `rejected` (422: a stage refused it),
   * `no_route` (500: no router installed), `unavailable` (503: on Cloudflare an object did not answer).
   */
  error: string;
  message?: string;
}

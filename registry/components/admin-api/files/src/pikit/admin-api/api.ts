/**
 * The admin API's JSON: what every route of admin-api answers, typed. The dashboard (`src/dashboard/`,
 * a project of its own) keeps an identical copy, `src/dashboard/src/lib/admin-api.ts`: no imports, so
 * it compiles there too. Change both together; the kit's tests check they are the same.
 *
 * Every route needs an operator (`admin.auth`): `Authorization: Bearer <PIKIT_ADMIN_TOKEN>` with
 * admin-auth-token, or the session cookie a browser got from `POST /admin/api/session` (then a `POST`
 * also carries `x-pikit-admin: 1`). An error is an `ApiError` with its status.
 *
 * **The dashboard is a channel of its own.** It reads every conversation, and writes only into its own
 * (keys `dashboard:<uuid>`, `POST /admin/api/conversations`) and as follow-ups to another channel's
 * conversation, whose answers it keeps: the request ids of its messages start with `dashboard:`, and a
 * run only they started is never delivered to the conversation's chat.
 *
 * | Route | Answer |
 * |---|---|
 * | `GET /admin/api/app` | `ApiApp`: the composition (`APP_DESCRIPTION`, no secrets) |
 * | `POST /admin/api/session` | the credential once → `200 ApiSession` and a session cookie (a browser's) |
 * | `DELETE /admin/api/session` | `204`: the session cookie cleared |
 * | `GET /admin/api/conversations?limit&cursor` | `ApiPage<ApiConversation>`, the most recently active first |
 * | `POST /admin/api/conversations` | `ApiStartRequest` → `201 ApiStartResponse`: a conversation of the dashboard's own |
 * | `GET /admin/api/conversations/:id` | `ApiConversation` |
 * | `GET /admin/api/conversations/:id/transcript?limit&cursor` | `ApiPage<ApiTranscriptEntry>`, newest first |
 * | `GET /admin/api/conversations/:id/events` | server-sent events, one `ApiEvent` per `data:` line; `snapshot` first |
 * | `POST /admin/api/conversations/:id/messages` | `ApiSendRequest` → `202 ApiSendResponse` |
 * | `POST /admin/api/conversations/:id/abort` | `200 ApiAbortResponse` |
 * | `POST /admin/api/conversations/:id/reset` | `200 ApiResetResponse` |
 * | `GET /admin/api/delivery/pending?limit&cursor` | `ApiPage<ApiPendingPiece>`, oldest stored first (with `outbound.queue`) |
 * | `GET /admin/api/delivery/receipts?after&limit` | `ApiReceiptsPage`, in the order they settled (with `outbound.queue`) |
 */

/** The keys of the dashboard's own conversations: `dashboard:<uuid>`. No other channel makes one. */
export const DASHBOARD_KEY_PREFIX = "dashboard:";

/** Whether `key` is one of the dashboard's own conversations. */
export const isDashboardKey = (key: string | undefined): boolean => key?.startsWith(DASHBOARD_KEY_PREFIX) === true;

/** How every message from the dashboard starts, as the agent reads it (`operatorPrompt`). */
export const OPERATOR_NOTE = "[From the operator, in the pikit dashboard";

/**
 * `text` as the agent reads it, sent from the dashboard to the conversation `key`: a first line says it
 * comes from the operator, and, in another channel's conversation, that its user sees neither it nor
 * the answer.
 */
export function operatorPrompt(key: string, text: string): string {
  const note = isDashboardKey(key) ? `${OPERATOR_NOTE}.]` : `${OPERATOR_NOTE}: the user of this conversation does not see this message or your answer to it.]`;
  return `${note}\n${text}`;
}

/** What a conversation cost: every model call and tool summed (pi-ai's `Usage`). */
export interface ApiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** One conversation of the runtime. */
export interface ApiConversation {
  /**
   * What `:id` is in the routes, opaque (encode it in a path): the runtime's id on a server,
   * `<key>~<the object's id>` on Cloudflare, where each conversation's object numbers its own.
   */
  conversationId: string;
  /**
   * Its conversation key (`telegram:12345`) and agent, once a message reached it or a reset pointed
   * its key to it (a reset's new conversation is its key's current one, talked to at once).
   */
  key?: string;
  agent?: string;
  /** Whether a run is going now. */
  busy: boolean;
  /** Epoch ms of its newest message. */
  lastActivity?: number;
  usage: ApiUsage;
  /**
   * Whether its key points to it now. `false` for a conversation a reset left behind: it can be read,
   * not talked to. Absent when it has no key: no message reached it and no reset pointed a key to it.
   */
  current?: boolean;
}

/** One page, and the cursor of the next (absent on the last page). */
export interface ApiPage<T> {
  items: T[];
  next?: string;
}

/** One entry of a conversation's history: its messages in the runtime's JSON (pi-ai's `Message`). */
export interface ApiTranscriptEntry {
  id: string;
  /** `message`, `pi.reset`, …: the runtime's words. */
  kind: string;
  messages: unknown[];
}

/**
 * One live event of a conversation, in the runtime's JSON. The first is a `snapshot` of what the
 * conversation is now; a client that fell behind gets a new `snapshot`, so a view is rebuilt from the
 * last `snapshot` and the events after it, never from a count of events.
 */
export interface ApiEvent {
  type: string;
  [field: string]: unknown;
}

/**
 * A message from an operator to a conversation: a follow-up (with a run going it waits for it), whose
 * answer stays in the dashboard. The agent reads it after `operatorPrompt`'s first line.
 */
export interface ApiSendRequest {
  text: string;
  /**
   * Its identity: the same one sent again does not run again. `dashboard:` then 1 to 118 of
   * `A-Z a-z 0-9 . _ ~ : -`. Absent, admin-api makes one.
   */
  requestId?: string;
}

export interface ApiSendResponse {
  requestId: string;
  /** `started`: a run started; `queued`: it waits for the run going; `duplicate`: already there. */
  admission: "started" | "queued" | "duplicate";
}

/** A new conversation of the dashboard's own, with its first message. */
export interface ApiStartRequest {
  /** One of the App's agents: the keys of `agent.definition` in `ApiApp.capabilities`. */
  agent: string;
  text: string;
  /** As `ApiSendRequest.requestId`. */
  requestId?: string;
}

export interface ApiStartResponse extends ApiSendResponse {
  conversationId: string;
  /** `dashboard:<uuid>`. */
  key: string;
}

/** A browser's session, opened. */
export interface ApiSession {
  /** The operator's id, as `admin.auth` names it. */
  operator: string;
}

export interface ApiAbortResponse {
  conversationId: string;
}

export interface ApiResetResponse {
  key: string;
  /** The conversation the key pointed to, kept and readable. */
  previousConversationId: string;
  /** The new, empty conversation the key points to now. */
  conversationId: string;
}

/** A piece of an answer not delivered yet (`outbound.queue`'s `pending`). Never its text. */
export interface ApiPendingPiece {
  idempotencyKey: string;
  /** Which of the answer's pieces: 0 is the first. */
  index: number;
  channel: string;
  conversationKey: string;
  /** `queued`: never tried; `sending`: in flight; `retrying`: tried, waiting to go again. */
  state: "queued" | "sending" | "retrying";
  attempts: number;
  /** Epoch ms before which it is not tried again; absent while sending. */
  nextAttemptAt?: number;
  /** Why its last try did not deliver it, short. */
  lastError?: string;
  /** Its next send may repeat one that reached the platform. */
  possibleDuplicate: boolean;
  storedAt: number;
}

/** A piece that settled (`outbound.queue`'s `receipts`), with the cursor to read after it. */
export interface ApiReceipt {
  cursor: string;
  idempotencyKey: string;
  index: number;
  channel: string;
  conversationKey: string;
  attempts: number;
  outcome: { kind: "delivered"; platformMessageId: string; possibleDuplicate: boolean } | { kind: "abandoned"; reason: string };
  /** Epoch ms when it settled. */
  at: number;
}

/** Receipts after a cursor: `next` is the last one's, to read on from; `gap`: some were pruned before this read. */
export interface ApiReceiptsPage {
  items: ApiReceipt[];
  gap: boolean;
  next?: string;
}

/**
 * The composition (`AppDescription`, K13): JSON, no secrets. A config value that looks like one (under a
 * key such as `token`, `secret`, `password`, `apiKey`, or shaped like a credential) is `[redacted]`.
 */
export interface ApiApp {
  version: number;
  target: string;
  components: { name: string; version?: string; provides: string[]; requires: string[]; optional: string[] }[];
  capabilities: Record<string, { providers: string[]; selected?: string; keys?: Record<string, string> }>;
  pipelines: Record<string, unknown[]>;
  config: Record<string, unknown>;
}

export interface ApiError {
  /**
   * `unauthorized`, `not_found`, `not_installed`, `invalid_request`, `invalid_cursor`, `no_agent`,
   * `not_current`, `unknown_agent`; `unavailable` (503) when, on Cloudflare, a conversation's object
   * did not answer.
   */
  error: string;
  message?: string;
}

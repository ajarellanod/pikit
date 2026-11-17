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
 * With a project store installed (`projects`; `ChatConfig.projects` says so), conversations are made in
 * projects (`ChatProject`): each the record of one space, shared by its members (one owner), whose chats,
 * instructions, documents, files, memory and links every member reads and changes, every change in its
 * History with its author, and undone by any member (features/projects.md). A non-member's (and a missing
 * project's) id is `404` on every route, as one that never existed. A conversation's project is fixed when
 * it is made (`ChatStartRequest.project`): it is in the project's space. Its author posts in it while a
 * member, with an agent the project allows (`403` otherwise); every member reads it. A project with
 * conversations is not deleted (`409 not_empty`): it is archived. Without `projects` there are none.
 *
 * A message whose text is `/name args` for one of `ChatConfig.commands` runs that command in its
 * conversation instead of reaching the agent: the answer says what came of it (`ChatSendResponse.command`),
 * for the page to show apart; nothing of it is in the transcript. The same request id never runs it twice.
 * A first message that is a command makes the conversation (empty, titled `New conversation`): the
 * command ran in it, in its project's space.
 *
 * A conversation reads as the dashboard's does (features/completed/chat-parity.md): a transcript of entries
 * (`ChatTranscriptEntry`, admin-api's `ApiTranscriptEntry`: pi-ai messages) and its live state (`ChatLive`,
 * a projection of `agent.observe`'s `ObservedLive`, sent as `ChatEvent`s: whole, then as JSON ops), both
 * cut to what the operator lets users see (`ChatConfig.visibility`).
 *
 * | Route | Answer |
 * |---|---|
 * | `GET /chat/api/config` | `ChatConfig` (no session needed) |
 * | `/chat/api/auth/*` | better-auth's own routes (sign in, sign up, OAuth callbacks, links, sessions) |
 * | `GET /chat/api/me` | `ChatMe`: the user, their sign-in methods, and the assistant Routing picks for their new chat (`suggestedAgent`) |
 * | `GET /chat/api/projects?archived` | `ChatPage<ChatProject>`: the user's projects (a member or the owner), newest change first; with `archived=1` the archived ones |
 * | `POST /chat/api/projects` | `ChatProjectRequest` → `201 ChatProject`, its owner the user (`400` past `MAX_PROJECTS` owned) |
 * | `GET /chat/api/projects/:id` | `ChatProjectOverview`: the project, its counts, the core documents' budget, the latest ten changes |
 * | `PATCH /chat/api/projects/:id` | `ChatProjectUpdate` → `200 ChatProject` (`agents`, `archived`: the owner's, `403` otherwise; `agents` among `ChatConfig.agents`) |
 * | `DELETE /chat/api/projects/:id` | `204` (the owner's); `409 not_empty` while it has conversations (any member's, archived ones too): archive it |
 * | `GET`, `POST /chat/api/projects/:id/members` | `ChatPage<ChatMember>`; `ChatMemberRequest` (an email the App knows) → `201 ChatMember` (any member) |
 * | `DELETE /chat/api/projects/:id/members/:member` | `204`: oneself (leave), or the owner another (`:member` its `memberKey`, URI-encoded) |
 * | `POST /chat/api/projects/:id/owner` | `ChatPrincipal` → `200 ChatProject`: the owner hands the project to a member |
 * | `GET`, `PUT /chat/api/projects/:id/instructions` | `ChatInstructionsRead` (`?version=`); `ChatInstructionsRequest` → `200 ChatInstructions` (`409` behind `ifVersion`) |
 * | `GET /chat/api/projects/:id/instructions/versions` | `ChatPage<ChatVersion>` |
 * | `GET`, `POST /chat/api/projects/:id/documents` | `ChatDocuments`; `ChatDocumentRequest` (text, or a saved file) → `201 ChatDocument` (`400 limit` past the core budget, saying what is left) |
 * | `POST /chat/api/projects/:id/documents/upload?title&mode` | a file's bytes → `201 ChatDocument`: its text (a text type), or converted (`document.convert`); `415` for one it cannot read |
 * | `GET`, `PATCH`, `DELETE /chat/api/projects/:id/documents/:doc` | `ChatDocumentRead` (`?part&version`); `ChatDocumentUpdate` → `ChatDocument`; `204` |
 * | `GET /chat/api/projects/:id/documents/:doc/versions` | `ChatPage<ChatVersion>` |
 * | `GET`, `POST /chat/api/projects/:id/files` | `ChatFiles` (`?trashed=1`: the trash); a file's bytes (`?name&description&id`) → `201 ChatSpaceFile` (needs `space.files`) |
 * | `GET`, `DELETE /chat/api/projects/:id/files/:name` | the bytes (`?version=`), an attachment; `204`: to the trash for 30 days |
 * | `GET /chat/api/projects/:id/files/:name/versions`, `POST …/restore` | `ChatPage<ChatSpaceFile>`; `200 ChatChange`: a trashed name back |
 * | `GET`, `POST /chat/api/projects/:id/memory` | `ChatMemory`; `ChatMemoryRequest` → `201 ChatMemoryItem`, active at once (needs `memory`) |
 * | `PATCH`, `DELETE /chat/api/projects/:id/memory/:item`, `POST …/approve` | new words → `ChatMemoryItem`; `204`; a proposal from before the project → `ChatMemoryItem` |
 * | `GET`, `POST /chat/api/projects/:id/links`, `DELETE …/links/:link` | `ChatPage<ChatLink>`; `ChatLinkRequest` → `201 ChatLink`; `204` |
 * | `GET /chat/api/projects/:id/history?limit&cursor` | `ChatPage<ChatChange>`: the project's, its memory's and its files' logs merged, newest first |
 * | `POST /chat/api/projects/:id/history/:log/:n/restore` | `200 ChatChange`: the state before change `n` of `log` back, through the store that holds it (the owner's for members and the project's own record) |
 * | `GET /chat/api/projects/:id/conversations?limit&cursor` | `ChatPage<ChatProjectConversation>`: every member's chats of the project |
 * | `GET /chat/api/projects/:id/conversations/:chat/transcript?limit&cursor` | `ChatPage<ChatTranscriptEntry>`: a member's chat, read only |
 * | `GET /chat/api/conversations/:id/notices` | `ChatNotices`: what was added to its project from this chat (the logs' entries whose author's conversation is it) |
 * | `GET /chat/api/conversations?limit&cursor&archived&q&project` | `ChatPage<ChatConversation>`, newest activity first: those not archived, or with `archived=1` the archived ones; with `q`, only those whose title holds it (any case); with `project`, only that project's (`none`: those of no project) |
 * | `POST /chat/api/conversations` | `ChatStartRequest` → `201 ChatStartResponse` (a command too: the conversation is made, the command ran in it; `429` past `ChatConfig`'s rate; `400` for an `agent` not in `ChatConfig.agents` or not one the project allows; `404` for a `project` the user is no member of; `403` in an archived one) |
 * | `GET /chat/api/conversations/:id` | `ChatConversation` |
 * | `PATCH /chat/api/conversations/:id` | `ChatRenameRequest` → `200 ChatConversation` |
 * | `POST /chat/api/conversations/:id/archive`, `…/unarchive` | `200 ChatConversation`: listed apart, or back in the list (new activity lists an archived one again) |
 * | `DELETE /chat/api/conversations/:id` | `204`: out of the list, gone for the user (nothing of the runtime's is deleted) |
 * | `GET /chat/api/conversations/:id/transcript?limit&cursor` | `ChatPage<ChatTranscriptEntry>`, newest first, at most `PAGE_JSON_MAX` characters of stored JSON (then fewer than `limit`, and `next`) |
 * | `GET /chat/api/conversations/:id/messages/:messageId/images/:n` | the bytes of image `n` of the user's message `messageId` (a user message's image part's `url`), its type, cached privately |
 * | `POST /chat/api/conversations/:id/messages` | `ChatSendRequest` → `202 ChatSendResponse` (`413` past a message's bounds: its images, its files; `403` in a project's chat once its author is no member, or its agent no longer allowed) |
 * | `GET /chat/api/conversations/:id/events` | server-sent events, one `ChatEvent` per `data:` line, a `live` with `["r", ChatLive]` first |
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
/**
 * The other files a user may attach to a message, of any type (`ChatSendRequest.files`): `MAX_FILES` of
 * `MAX_FILE_BYTES` at most, `MAX_FILES_BYTES` in all. They are written to the conversation's workspace,
 * never stored with the message.
 */
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_BYTES = 25 * 1024 * 1024;
/** On Cloudflare (`ChatConfig.target` `durable`), a message's files in all: they cross to the conversation's object in one call (at most 32 MiB, in base64). */
export const MAX_DURABLE_FILES_BYTES = 20 * 1024 * 1024;
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
/** The longest project description, in characters. */
export const PROJECT_DESCRIPTION_MAX = 500;
/** The most projects a user owns. */
export const MAX_PROJECTS = 100;
/** The largest file a project's page uploads (a saved file, or a document's), in bytes. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** The longest instructions, in characters. */
export const INSTRUCTIONS_MAX = 8_000;
/** The longest memory (a rule, a note), in characters. */
export const MEMORY_TEXT_MAX = 4_000;
/** The logs a project's History merges (`ChatChange.log`): the project's own, its memory's, its files'. */
export const HISTORY_LOGS = ["project", "memory", "files"] as const;
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
  /** Who it is for (`AgentCommand.audience`): `user`, or `operator` when the operator allowed one by name or `all`. */
  audience: "operator" | "user";
  /**
   * The assistants it is for (`AgentCommand.agents`: a prompt template's), among `ChatConfig.agents`
   * only (empty: none of those; an agent users may not pick is never named): the page's "/" menu lists
   * it only in their conversations. Typed in another agent's, it is refused, saying so. Absent: every
   * agent's.
   */
  agents?: string[];
}

/** What the page needs before anyone signed in. */
export interface ChatConfig {
  /** The assistant's name, as the page titles itself. */
  name: string;
  /** `server` or `durable`: the image and file limits differ (`MAX_DURABLE_IMAGE_BYTES`, `MAX_DURABLE_FILES_BYTES`). */
  target: string;
  /** Whether a message may carry other files (`ChatSendRequest.files`): the App keeps them in a workspace (`workspace` or `execution` is installed). */
  files: boolean;
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
  /** Whether conversations are made in projects (`projects` installed), and what their pages show; absent: no projects. */
  projects?: ChatProjectFeatures;
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

/** A channel's identity (`@pikit/contracts`' `Principal`): a user of this chat is `{ channel: "web", id: <user id> }`. `name`: shown, never checked. */
export interface ChatPrincipal {
  channel: string;
  id: string;
  name?: string;
}

/** Who made a change and from where (`@pikit/contracts`' `Author`): a person (from a page, or a command typed in a chat), an agent (in a chat, answering a person), an operator, trusted code. */
export type ChatAuthor =
  | { kind: "person"; principal: ChatPrincipal; conversation?: string }
  | { kind: "agent"; agent: string; conversation: string; for?: ChatPrincipal }
  | { kind: "operator"; id: string }
  | { kind: "component"; name: string };

export type ChatProjectRole = "owner" | "member";

/** What a project's page can show besides its record: what the App installs (`ChatConfig.projects`). */
export interface ChatProjectFeatures {
  /** Files people upload and agents save (`space.files`). */
  files: boolean;
  /** The space's rules, notes and summaries (`memory`). */
  memory: boolean;
  /** Documents from files that are not text (PDF, Office...: `document.convert`). */
  convert: boolean;
}

/** One of the user's projects: the record of a space its members (and their agents) share. */
export interface ChatProject {
  /** What `:id` is in the routes, and `ChatConversation.project`. */
  id: string;
  /** 1 to `PROJECT_NAME_MAX` characters. */
  name: string;
  /** 0 to `PROJECT_DESCRIPTION_MAX` characters. */
  description: string;
  /** The assistants a chat of it may be made with; empty: those the chat offers. The owner's to set. */
  agents: string[];
  owner: ChatPrincipal;
  /** The user's role in it. */
  role: ChatProjectRole;
  /** How many members (the owner included). */
  members: number;
  /** Archived: read only, listed apart (`?archived=1`). */
  archived: boolean;
  /** How many conversations it has, every member's (archived ones too). */
  chats: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChatProjectRequest {
  /** 1 to `PROJECT_NAME_MAX` characters. */
  name: string;
  description?: string;
}

/** A change of a project's record: any member its name and description; the owner its agents and archive. */
export interface ChatProjectUpdate {
  name?: string;
  description?: string;
  agents?: string[];
  archived?: boolean;
}

/** One entry of a log a project's History merges (`@pikit/contracts`' `Change`, and the log it is in). */
export interface ChatChange {
  /** `project` (its record, members, instructions, documents, links), `memory` (rules, notes, summaries) or `files`. */
  log: (typeof HISTORY_LOGS)[number];
  /** Its number in its log: what `POST .../history/:log/:n/restore` takes. */
  n: number;
  at: number;
  by: ChatAuthor;
  action: "added" | "changed" | "removed" | "restored";
  /** `kind`: `project`, `member`, `instructions`, `document`, `link`, `rule`, `note`, `summary`, `file`. */
  item: { kind: string; id: string; title: string };
  version?: number;
  /** For `restored`: the change whose earlier state came back. */
  restores?: number;
  /** Whether its earlier state can still come back (`false` past a year, or redacted). */
  restorable: boolean;
  redacted?: { at: number; by: ChatAuthor };
  /** A chat's notices only (`ChatNotices`): its earlier state was brought back since, by whom and when (an Undo), and not put back again. */
  undone?: { at: number; by: ChatAuthor };
}

/** A project's page: the record, what it holds, and its latest changes. */
export interface ChatProjectOverview {
  project: ChatProject;
  /** Its documents, and the estimated tokens of the core ones (always in an agent's context) against the budget. */
  documents: number;
  coreTokens: number;
  coreBudget: number;
  links: number;
  /** With `space.files`: its files' names and bytes (versions and trash included). */
  files?: { names: number; bytes: number };
  /** With `memory`: its active rules, notes and summaries. */
  memory?: { rules: number; notes: number; summaries: number };
  /** The ten latest changes, newest first (History has them all). */
  recent: ChatChange[];
}

export interface ChatMember {
  principal: ChatPrincipal;
  role: ChatProjectRole;
  /** `manual` (added by someone), or the source a component keeps in step (a Google Chat space). */
  source: string;
  /** Whether it counts now: a sourced member stops counting when its source was not checked lately. */
  current: boolean;
  /** Whether it is the user. */
  you: boolean;
  by: ChatAuthor;
  at: number;
}

export interface ChatMemberRequest {
  /** An email the App knows (a user of this chat; a person its directory knows). */
  email: string;
}

/** A member as `DELETE .../members/:member` names it: `<channel, URI-encoded>:<id>`, the whole URI-encoded in the path. */
export const memberKey = (principal: { channel: string; id: string }): string => `${encodeURIComponent(principal.channel)}:${principal.id}`;

export interface ChatInstructions {
  text: string;
  version: number;
  by: ChatAuthor;
  at: number;
}

/** The instructions (absent: none written yet). */
export interface ChatInstructionsRead {
  instructions?: ChatInstructions;
}

export interface ChatInstructionsRequest {
  /** At most `INSTRUCTIONS_MAX` characters. */
  text: string;
  /** The version the text was written over (`0`: none yet): a newer one is `409`, the newer kept. */
  ifVersion: number;
}

/** One version of the instructions or of a document. */
export interface ChatVersion {
  version: number;
  by: ChatAuthor;
  at: number;
  chars: number;
  title?: string;
  mode?: "core" | "reference";
}

export interface ChatDocument {
  id: string;
  title: string;
  /** `core`: whole in every request of the project's agents (within the budget); `reference`: found and read when needed. */
  mode: "core" | "reference";
  chars: number;
  tokens: number;
  version: number;
  /** Made from a saved file. */
  source?: { file: string; fileVersion: number };
  by: ChatAuthor;
  at: number;
}

export interface ChatDocuments {
  items: ChatDocument[];
  coreTokens: number;
  coreBudget: number;
}

/** A part of a document's text, 20,000 characters a part. */
export interface ChatDocumentRead {
  document: ChatDocument;
  text: string;
  part: number;
  parts: number;
}

/** A new document: its text given, or a saved file's (converted when it is not text). */
export interface ChatDocumentRequest {
  title: string;
  mode: "core" | "reference";
  text?: string;
  file?: { name: string; version?: number };
}

/** A new version of a document (its title, mode or text), over `ifVersion`. */
export interface ChatDocumentUpdate {
  title?: string;
  mode?: "core" | "reference";
  text?: string;
  ifVersion: number;
}

/** A saved file of the project (its newest version, or one of its versions). */
export interface ChatSpaceFile {
  name: string;
  version: number;
  /** How many versions it has (in a list). */
  versions?: number;
  description: string;
  size: number;
  type?: string;
  by: ChatAuthor;
  createdAt: number;
  trashedAt?: number;
  /** Whether its text is searched by the agents (`indexed`), or only its name and description (`none`). */
  text: "indexed" | "none";
}

export interface ChatFiles {
  items: ChatSpaceFile[];
  usage: { files: number; names: number; bytes: number };
}

export interface ChatMemoryItem {
  id: string;
  /** `note`: what the agents noted (a fact); `rule`: what every agent of the project follows; `summary`: of a quiet chat. */
  kind: "rule" | "note" | "summary";
  /** `pending`: a rule proposed before the space was a project, waiting for a member. */
  status: "active" | "pending";
  text: string;
  createdAt: number;
  updatedAt?: number;
  /** Who kept it, and from where; absent on what was kept before authors were recorded. */
  by?: ChatAuthor;
}

/** The project's memory, oldest first in each. */
export interface ChatMemory {
  rules: ChatMemoryItem[];
  notes: ChatMemoryItem[];
  summaries: ChatMemoryItem[];
  /** Rules proposed before the space was a project: added or discarded by any member. */
  proposed: ChatMemoryItem[];
}

export interface ChatMemoryRequest {
  kind: "rule" | "note";
  /** 1 to `MEMORY_TEXT_MAX` characters. */
  text: string;
}

export interface ChatLink {
  id: string;
  url: string;
  title: string;
  note?: string;
  by: ChatAuthor;
  at: number;
}

export interface ChatLinkRequest {
  url: string;
  title: string;
  note?: string;
}

/** A chat of a project, any member's: who made it (`userId`, `mine`). */
export interface ChatProjectConversation extends ChatConversation {
  userId: string;
  mine: boolean;
}

/** What was added to a chat's project from it (newest first): agents' notes, rules, files and links, a member's commands. */
export interface ChatNotices {
  /** The chat's project; absent: none (then `items` is empty). */
  project?: string;
  items: ChatChange[];
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

/** A file a message is sent with, of any type: written to the conversation's workspace, its name alone kept with the message. */
export interface ChatFile {
  /** Its name, 1 to 255 characters: made safe for its path in the workspace. */
  name: string;
  /** Its type, when the browser knows it. */
  mimeType?: string;
  /** Its bytes, base64 (standard, padded), without a `data:` prefix. */
  data: string;
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
 *   (read its bytes from `url`, with the session; never inline), then its files, each `{ type: "file", name }`
 *   (their bytes are the agent's, in its workspace), its `timestamp` when it was sent;
 *   `state` says what became of it. A message sent while a run goes is in the transcript (and announced
 *   live) once that run ended: it is answered after it.
 * - **A run's message** (an answer, a tool round, a tool's result): `<request id of the run>#<its hash>`,
 *   the same id the live events announced it with (an `entries` event): merged by id, nothing is
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

/** A call of the run's current tool round, as users see it (`ChatLive.tools`). */
export interface ChatLiveTool {
  callId: string;
  /** The tool's name. */
  name: string;
  status: "pending" | "running" | "done";
  /** What it printed so far (a bounded output loses its start): with `tools: "full"` only. */
  output?: string;
}

/**
 * What a conversation shows its user live, now (admin-api's `ObservedLive` as users may see it), cut by
 * `ChatConfig.visibility`. JSON: what `live` events' ops apply to.
 *
 * Only a run known to answer one of the user's messages (one of its requests is theirs) shows its
 * answer, its tools and its failure: an operator's run shows only that the assistant is busy.
 */
export interface ChatLive {
  /** Whether a run goes (any run). */
  busy: boolean;
  /**
   * The answer being written: a pi-ai assistant message (`role`, `content`, `timestamp`, `stopReason`),
   * its blocks cut as the transcript's are (the one it will be stored as).
   */
  partial?: unknown;
  /** The current tool round's calls, in call order (with `tools: "none"`, none); empty outside one. */
  tools: ChatLiveTool[];
  /**
   * Why the user's last run ended without an answer, until a run starts again: the runtime's word
   * (`model_error`, `aborted`, `turn_limit`, …), never its error's text.
   */
  failure?: { reason: string };
}

/**
 * A change to a JSON value: `@pikit/contracts`' `JsonOp` (json-ops.ts, Chord's op vocabulary), a path
 * the keys and indexes from the root. `["r", value]` replaces it whole; `["s", path, value]` sets a member;
 * `["d", path]` removes an object's member; `["a", path, text]` appends to a string; `["t", path, count]`
 * drops a string's first `count` characters; `["p", path, start, deleteCount, items]` splices an array.
 */
export type ChatJsonOp =
  | readonly ["r", unknown]
  | readonly ["s", readonly (string | number)[], unknown]
  | readonly ["d", readonly (string | number)[]]
  | readonly ["a", readonly (string | number)[], string]
  | readonly ["t", readonly (string | number)[], number]
  | readonly ["p", readonly (string | number)[], number, number, readonly unknown[]];

/**
 * One live event of a conversation, in admin-api's shapes (`agent.observe`'s `ObservedEvent`), cut by
 * `ChatConfig.visibility`. A view applies each `live` event's ops in order to the first one's value
 * and never counts events: a stream that fell behind gets the newest state, by ops or a new `r`.
 *
 * - `live`: `ChatLive` changed, `ops` over its last value; the first event is one, `[["r", ChatLive]]`.
 * - `entries`: entries of the user's, oldest first, as the transcript will give them (same id, same
 *   messages: merged by id, nothing is swapped): a message admitted or released after the run it waited
 *   behind, a message a run of the user's wrote (sent before the `live` change that removes the
 *   answer it holds).
 * - `transcript`: something stored changed (a run's messages, a message's state): read it again.
 *
 * Never an entry of the runtime's own (a system prompt, the user's message as the agent read it, an
 * operator's), an operator's run's answer or tools, usage or cost.
 */
export type ChatEvent =
  | { type: "live"; ops: readonly ChatJsonOp[] }
  | { type: "entries"; entries: ChatTranscriptEntry[] }
  | { type: "transcript" };

export interface ChatSendRequest {
  /** May be empty when it has images or files. At most `MAX_TEXT` characters. */
  text: string;
  images?: ChatImage[];
  /**
   * Other files (any type, `MAX_FILES` of `MAX_FILE_BYTES`, `MAX_FILES_BYTES` in all, on `durable`
   * `MAX_DURABLE_FILES_BYTES`): written to the conversation's workspace before the message reaches the
   * agent, whose text names their paths (`attachments/<request id>/<name>`). Without `ChatConfig.files`
   * each is named to the agent as not read.
   */
  files?: ChatFile[];
  /**
   * Its identity: the same one sent again does not run again. `web:` then 1 to 118 of
   * `A-Z a-z 0-9 . _ ~ : -`. Absent, the server makes one.
   */
  requestId?: string;
}

export interface ChatStartRequest extends ChatSendRequest {
  /** The assistant the conversation is made with: one of `ChatConfig.agents` (else `400`). Absent: the router decides. */
  agent?: string;
  /** The project the conversation is made in, for good: one the user is a member of (`ChatProject.id`, else `404`). Absent: none. */
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
   * that still has conversations), `conflict` (409: a change made over a version that is not the newest
   * any more), `forbidden` (403: an owner's act, a project's chat its author may not post in any more),
   * `gone` (410: a change too old to undo), `refused` (400: a credential's shape, never echoed), `limit`
   * (400: past a project's bounds, saying which), `unsupported` (415: a file that cannot be read as text), `denied`
   * (403: the router refused the message, `message` says why), `rejected` (422: a stage refused it),
   * `no_route` (500: no router installed), `unavailable` (503: on Cloudflare an object did not answer).
   */
  error: string;
  message?: string;
}

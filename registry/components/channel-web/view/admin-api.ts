/**
 * The JSON of channel-web's operator routes (`/admin/api/channel-web/*`, behind `admin.auth`): what the
 * dashboard's Users view reads and does. No imports: the view keeps an identical copy.
 *
 * | Route | Answer |
 * |---|---|
 * | `GET /admin/api/channel-web/users?limit&cursor` | `AdminChatUsersPage`, newest first |
 * | `POST /admin/api/channel-web/invitations` | `AdminChatInviteRequest` → `201 AdminChatInvitation` |
 * | `POST /admin/api/channel-web/users/:id/ban` | `200 AdminChatUserState`: banned, every session revoked |
 * | `POST /admin/api/channel-web/users/:id/unban` | `200 AdminChatUserState` |
 * | `POST /admin/api/channel-web/users/:id/password-reset` | `200 AdminChatLink` |
 * | `DELETE /admin/api/channel-web/users/:id` | `204`: the user, their sessions and accounts; their conversations leave the users' list (the runtime keeps them) |
 *
 * Errors are `{ error, message? }`: `unauthorized` (401), `not_found` (404: no such user, or no
 * `admin.auth` installed), `exists` (409: that email has an account in use), `invalid_request` (400).
 * A link is shown once: it is in no log, and the API never gives it again.
 */

/** A user of the chat, as the operator lists them. */
export interface AdminChatUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string;
  /** How they sign in: `password`, and the provider ids linked. */
  methods: string[];
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms they were last seen: a sign-in, or a request at most `sessionCacheSeconds` (at least a minute) after it; kept through a ban or a sign-out. Absent: never. */
  lastSeenAt?: number;
  banned: boolean;
}

export interface AdminChatUsersPage {
  items: AdminChatUser[];
  next?: string;
}

export interface AdminChatInviteRequest {
  email: string;
  name?: string;
}

/** A link the operator hands over: valid until `expiresAt`; `emailed` when the App sent it too (`email.send`). */
export interface AdminChatLink {
  link: string;
  expiresAt: number;
  emailed: boolean;
}

export interface AdminChatInvitation extends AdminChatLink {
  userId: string;
}

export interface AdminChatUserState {
  id: string;
  banned: boolean;
}

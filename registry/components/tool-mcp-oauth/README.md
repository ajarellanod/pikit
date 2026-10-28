# tool-mcp-oauth

OAuth logins for tool-mcp's MCP servers: the servers that want you to log in with a browser (Figma,
Linear, Notion…) instead of a token you paste. You log in once from your machine; the deployed app
keeps the login and refreshes its token, once for every conversation.

- **Provides:** `mcp.auth`, one key per server in its config (pi-mcp's `AuthProvider` for that
  server's URL, `@pikit/pi-adapter/mcp`'s `McpAuth`), which tool-mcp uses for a server whose config
  says `auth: "oauth"`; and `http.route`: the operator's routes below. On Cloudflare the Worker's half
  provides the routes.
- **Requires:** `storage.sql` (the logins, in one owner: storage-sqlite, storage-do), `actor.inbox`
  and `actor.mailbox` (mailbox-local on a server, actors-do on Cloudflare). **Uses, if installed:**
  `admin.auth` (who is an operator; without it, its routes answer nobody), `health` (reports
  `tool-mcp-oauth:<server>` degraded while a server is not logged in). The Worker's half requires
  `actor.mailbox` and uses `admin.auth`.
- **Command:** `pikit tool-mcp-oauth login <server> | status | logout <server>` (`login.ts`).
- **Targets:** `server` and `durable`. The login itself runs on your machine (it listens for the
  browser's redirect on `127.0.0.1`), never in the app.
- **Installs to:** `src/pikit/tool-mcp-oauth/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi), `typebox`.

```sh
pikit add tool-mcp-oauth
pikit up                                   # the routes must be deployed before a login is uploaded
pikit tool-mcp-oauth login figma           # a browser login here; the login goes to the deployed app
```

On Cloudflare `pikit add` puts the default export in the objects' App and the Worker's half
(`tool-mcp-oauth-worker`) in the Worker's.

## Config

A server is named the same in both components, with the same URL: tool-mcp's entry says which tools
and `auth: "oauth"`; this one's says how to log in.

```ts
config: {
  "tool-mcp": {
    servers: {
      figma: { url: "https://mcp.figma.com/mcp", auth: "oauth", tools: ["get_design_context", "get_screenshot"] },
    },
  },
  "tool-mcp-oauth": {
    servers: {
      figma: { url: "https://mcp.figma.com/mcp", clientName: "pikit" },
    },
  },
}
```

Each server:

- `url`: the MCP endpoint, the same as tool-mcp's server of that name. tool-mcp refuses to start
  when the two differ: a token goes only to the URL it was obtained for.
- `clientName` (optional, `"pikit"` by default): the `client_name` the login registers with
  (dynamic client registration). See "Client name".

**Two accounts of one service** are two server names with the same URL (`figma-design`,
`figma-marketing`): each has its own login, and their tokens never mix.

## Logging in

`pikit tool-mcp-oauth login <server>` runs on your machine, in the project:

1. It asks the app's route first (`GET /admin/api/tool-mcp-oauth`): an app that cannot be reached
   or refuses `PIKIT_ADMIN_TOKEN` stops it before a browser opens.
2. It listens on `127.0.0.1` for the browser's redirect (`/callback`, a free port; `--port <n>` to
   choose one, for example to forward it over SSH).
3. Pi's MCP OAuth flow (pi-mcp's `authorizeMcp`) discovers the server's authorization server,
   registers a client for that redirect with your `clientName`, and builds the authorization URL
   with PKCE (S256) and a random `state`. The URL is printed, and opened at a terminal.
4. You approve in the browser; it comes back with a code, which the flow exchanges, with the PKCE
   verifier, for tokens.
5. The login (client, tokens, their expiry, the authorization server's metadata) is uploaded to
   `PUT /admin/api/tool-mcp-oauth/<server>` with `PIKIT_ADMIN_TOKEN`. **Nothing is kept on your
   machine**: a second copy that refreshed would revoke the app's refresh token (they rotate).

The app it talks to: `--url <origin>`, else `PIKIT_PUBLIC_URL` (the environment or `.env`), else
this machine's (`pikit dev`: `http://127.0.0.1:8787` with deployment-cloudflare, else server-bun's
port). On a server, `pikit dev` and the command against it is the whole local setup.

`pikit tool-mcp-oauth status` lists each server: logged in (until when the token is valid) or why
not. `pikit tool-mcp-oauth logout <server>` drops the app's login.

### Client name

Some servers register only the clients of their own catalogue, and refuse any other `client_name`
at registration (`403`); the login then fails saying so. **Figma's remote MCP**
(`https://mcp.figma.com/mcp`) is one: as measured by its owner on another platform, `"Codex"`
registers and `"pi"`, `"claude"` or a lowercase `"codex"` are refused (the match is exact). Setting
`clientName` to another vendor's listed client makes your app present itself as that client (the
consent screen shows its name): whether that is allowed is for Figma's terms, and the vendor's, to
say, and Figma may stop it at any time. The way it offers is its MCP catalogue (a waitlist). Choose
per deployment; pikit sends what you configure and nothing else.

## How it works

- **One owner.** The logins are one actor's, `tool-mcp-oauth` (on a server the app itself; on
  Cloudflare one Durable Object of the conversations' class, never a conversation), in its
  `storage.sql` (table `tool_mcp_oauth`), one row per server name. Every app reaches it through
  `actor.mailbox`.
- **Kept until a minute before expiry.** A conversation asks the owner for the token once (on
  Cloudflare a subrequest), and keeps it until a minute before it expires (until a 401, when the
  server gave no expiry). The owner refreshes a token that expires within a minute before serving it.
- **One refresh, by the owner.** After a 401 the conversation asks the owner to refresh, naming the
  token the server refused. The owner refreshes only when that token is still the current one, one
  refresh per server at a time; everyone refused the same token meanwhile gets the new one. Within
  one conversation, concurrent 401s make one call. Refresh tokens rotate: a second refresher would
  revoke the first one's tokens.
- **A refused refresh ends the login, once.** When the authorization server refuses a refresh
  (`invalid_grant` and any OAuth error but `server_error`), the owner drops the tokens and keeps why;
  the call fails with "log in again: `pikit tool-mcp-oauth login <server>`", and every later call is
  refused at once, with no request to either server, until a new login. A refresh that could not be
  made (the authorization server down, a timeout, `server_error`) keeps the login; that call fails
  saying "try again", and the next 401 tries again.
- **Not logged in is not down.** A server with no usable login fails only its tools' calls, with
  that message; the app starts and answers (tool-mcp's exception to its "a server it cannot list
  stops the start" rule), and `health` reports `tool-mcp-oauth:<server>` degraded. On a server the
  app reports each server's state at start; on Cloudflare each conversation reports what it met.
- **One URL per login.** A login carries the URL it was made for: an upload for another URL than
  the config's is refused (`400`), and one whose server moved to another URL in config is not
  served (log in again).

## API

Every route asks `admin.auth` first (`401` otherwise). JSON; an error is `{ error, message? }`. No
route ever answers a token: an operator replaces or deletes a login, never reads it back.

| Route | Answers |
|---|---|
| `GET /admin/api/tool-mcp-oauth` | `{ servers: [{ server, url, loggedIn, expiresAt?, reason? }] }`: every server in config |
| `PUT /admin/api/tool-mcp-oauth/<server>` | the body is a login, `{ url, clientInformation, tokens, tokensExpireAt?, discovery }` (what `login` uploads) → the server's status; `400 invalid_request` for a server not in config, a login for another URL, or a body of another shape |
| `DELETE /admin/api/tool-mcp-oauth/<server>` | `{ deleted }` |

## Security

- **Operators only.** The routes ask `admin.auth`; the owner is reached only by the app's own
  components (`actor.mailbox`).
- **Never logged, never answered.** No log line, tool error, route answer or health reason holds an
  access token, a refresh token or a client secret; an error text the authorization server wrote is
  scrubbed of them. The model sees only "log in again" or "try again". A refused upload says what
  is wrong with its shape, never what it held.
- **At rest.** In the clear in the owner's storage (the SQLite file on a server, the object's
  SQLite on Cloudflare), as credentials-do and credentials-file keep model logins: only the app's
  code reads it.
- **The lock is the owner's memory.** An owner evicted or redeployed in the middle of a refresh
  forgets it; if the authorization server rotated the refresh token in an answer that never arrived,
  the next refresh is refused, and the server needs a new login.

## Guarantees

`tool-mcp-oauth.test.ts`, with a double of Cloudflare's objects (each app is one object, a call
reaches the app of its key) and one app as every key's actor (a server), against a local fake of an
MCP server and its authorization server (`fake-oauth.test-support.ts`: dynamic registration, PKCE,
rotating refresh tokens, only the latest access token accepted):
- the login: registration sends the configured `client_name`; a refused name fails saying how to
  choose another and uploads nothing; the code is exchanged with a verifier that matches its
  challenge; the uploaded login serves a conversation; nothing printed holds a token; usage, a
  server not in config, and an app that refuses the operator token stop it before any browser;
- a token used and kept (one call to the owner for several requests), refreshed after a 401 with the
  stored refresh token, the rotated pair stored and served by a restarted owner;
- five conversations refused at once: one refresh; five concurrent 401s in one conversation: one
  more; a conversation refused its old token after the owner restarted: no refresh;
- `invalid_grant`: one "log in again" error naming the command, one request to the authorization
  server, none after it (nor to the MCP server), health degraded, then up after a new login;
- a refresh that could not be made (`server_error`): "try again", the login kept, the next call
  refreshes; a token expiring within a minute refreshed by the owner before it is served;
- a login used only for its URL: an upload for another URL refused, a config moved to another URL
  asking for a new login (nothing sent there), two server names on one URL never sharing one;
- the routes: `401` without an operator, `400` for a server not in config or a body of another
  shape (not echoed), the list, a logout; no token or client secret in the list, the errors, the
  logs, the health reasons or the command's output;
- only the owner's key is answered: a call that reached another actor's app (every app registers the
  answers) is refused, and that actor's storage holds no login (checked against answers without the
  key check);
- on a server (the app is the owner): an app with a server not logged in starts, reports it
  degraded, refuses its token with the command to run; the command against the app's own routes
  logs it in.

tool-mcp's tests cover its side with a stand-in `mcp.auth`: the start that does not stop for a
server not logged in, its tools failing with the message and described after the login, a refresh
after a 401 naming the rejected token, and the starts refused (no `mcp.auth`, one for another URL).

In the pikit repository, the workerd lane (`tests/workerd/test/tool-mcp-oauth.workerd.ts`) runs
the owner and two conversations as real Durable Objects, each conversation calling the fake MCP
server through `mcp.auth` behind workerd's real `fetch`: the login made as the command makes it
(pi-mcp's `authorizeMcp`, the client registered with its `clientName`) and uploaded through the
Worker's route; both conversations refused at once cause one refresh (checked to fail with the owner
refreshing whatever token was rejected); the owner evicted, its next instance serves the rotated
tokens and refreshes once more; `401` without the operator's token, `400` for a body that is no
login. Not covered: an owner evicted in the middle of a refresh (above: the server then needs a new
login).

## Remove it

`pikit remove tool-mcp-oauth` takes the routes and `mcp.auth` away: tool-mcp then refuses to start
with a server that says `auth: "oauth"`. The logins stay in the owner's table (`tool_mcp_oauth`);
log out first (`pikit tool-mcp-oauth logout <server>`) if they should not.

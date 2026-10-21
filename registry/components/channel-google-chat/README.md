# channel-google-chat

Talk to your agents in Google Chat: spaces, group chats and DMs, through a Chat app of your own
([features/channel-google-chat.md](https://github.com/ajarellanod/pikit/blob/main/features/channel-google-chat.md)).
Every answer goes to its message's thread; each thread is a conversation by default, or a whole chat
is one (a setting). "Thinking…" is written into the answer as the model writes it; tables and code
are drawn as cards, images as image cards; photos and files are read; a quoted message is the
reply's context; the agent's questions (`ask_user`, [tool-ask-user](../tool-ask-user/README.md)) are
asked with buttons and forms.

- **Provides:** `http.route`: `POST /google-chat` (and `POST /google-chat/<name>` per named app), the
  app's endpoint. A stage of the `conversation.describe` pipeline: who a conversation is with, for the
  dashboard (a space's name, the person of a direct message, the space, thread and named app), from
  what its messages carried, kept in its `storage.kv` namespace under `party:<space>` (written only
  when it changed; Google is never asked).
- **Requires:** `secrets`, `conversations.registry`, `agent.runtime`, `agent.submissions`,
  `storage.kv`, `wakeups`. **Uses, if installed:** `outbound.queue` (answers stored before they are
  sent, with a receipt for each; without it, answers survive a restart too, from the runtime's
  record), `settings` (the `conversations` setting, edited
  from the dashboard), `workspace` or `execution` (where files other than images and text go), and on
  Cloudflare `actor.inbox` and `actor.mailbox`. The Worker's half requires `secrets` and
  `actor.mailbox`, and uses `settings`.
- **Targets:** `server` and `durable` (Cloudflare). One code on both: in `start`, `actor.inbox`'s
  `scope` says where it runs.
- **Installs to:** `src/pikit/channel-google-chat/`; its Settings section to the dashboard.
- **npm dependencies:** `typebox`. Google's tokens are checked and signed with WebCrypto, not with
  `googleapis` or `google-auth-library`, which do not run in a Worker.

## On a server, step by step

What follows is everything, in order, from nothing to an app answering in Google Chat on a server of
yours: Docker, a domain on Cloudflare for the public URL, and a Google Workspace account (Chat apps are
not available to personal Gmail accounts).

### 1. The project

```sh
pikit new my-agent --preset base --with channel-google-chat
cd my-agent
```

The `base` preset is the server's composition (run in Docker by `deployment-docker`); `--with
channel-google-chat` answers its channel question with this channel instead of `channel-http`. That
gives what this channel needs, each by a capability:

| Component | Gives | Why |
|---|---|---|
| `secrets-env` | `secrets` | the app's secrets, from `.env` |
| `storage-sqlite` + `storage-kv-sql` | `storage.sql`, `storage.kv` | the delivery cursor, the threads of whole chats' answers, the placeholders, the questions |
| `runtime-pi` | `agent.runtime`, `agent.submissions` | the agent's runs, and the feed answers are delivered from |
| `conversations-kv` | `conversations.registry` | a conversation per thread (or per chat) |
| `router-basic` | a router (`route.resolve`) | every message to the default agent (`router-rules` for an agent per space) |
| `wakeups-timers` | `wakeups` | answer delivery's retries, the start-up sweep (brought by `outbound-durable`) |
| `outbound-durable` | `outbound.queue` | answers stored before they are sent, and a receipt for each (offered by `pikit add`, taken by the preset) |
| `execution-local` | `execution` | the agent's files; files sent in the chat land there without `workspace-local` |
| `server-bun` | `http.route`'s server | serves `POST /google-chat` on port 3000 |
| `deployment-docker` | `pikit up` | the app in Docker |

Then what makes it whole:

```sh
pikit add tool-ask-user workspace-local expose-cloudflare-tunnel
```

- `tool-ask-user` gives the agent `ask_user`, whose questions this channel draws as cards. An agent
  asks only when it names the tool: add `"ask_user"` to its `tools` in
  `src/agents/steward/agent.ts` (`tools: ["read", "write", "edit", "fetch", "websearch", "ask_user"]`).
- `workspace-local` gives `workspace`: the agent's own directory in each space or thread (its chat,
  kept through `/new`), where a PDF or an archive sent in the chat is written for the agent's tools.
- `expose-cloudflare-tunnel` gives `pikit expose`: the public HTTPS URL Google calls.
- `base` already includes the dashboard with `admin-api` and `settings-store` (`settings`): edit
  the `conversations` setting from its Settings, this component's section.

`pikit add` ends with `pikit doctor`; the variables it names are set in step 4.

### 2. The public URL

Google posts every event to an HTTPS URL that must not change. `pikit expose` makes one with a
Cloudflare Tunnel ([expose-cloudflare-tunnel](../expose-cloudflare-tunnel/README.md)). It needs:

- `deployment-docker` (the preset has it: its `pikit up` runs the tunnel's `cloudflared` beside the app);
- a domain on your Cloudflare account, and a hostname on it for the bot (`bot.example.com`);
- a Cloudflare API token (*My Profile > API Tokens > Create Token > Custom token*, with **Account >
  Cloudflare Tunnel > Edit** and **Zone > DNS > Edit** on that zone), used while the tunnel is made,
  never stored.

`pikit expose quick` is no substitute: its `trycloudflare.com` URL changes every time, and Google's
endpoint must stay the same. Your own reverse proxy works too: the audience is the URL you give Google,
exactly. Whatever is in front of the app must **never log the `Authorization` header**: Google's token
is not bound to the request's body, so whoever reads one can send the app anything with it until it
expires (an hour).

The endpoint is `${PIKIT_PUBLIC_URL}/google-chat` (`https://bot.example.com/google-chat`), and
`/google-chat/<name>` for a named app (`instances: ["ops"]` in the config). `PIKIT_EXPOSE_PATHS` must
list each one: `pikit configure` proposes the installed channels' paths, `/google-chat` among them.

### 3. The app in Google Cloud

The assistant has a Chat app of its own, in its own Google Cloud project: the app's endpoint is this
channel's, never shared with another service.

1. **A project.** In the [Google Cloud console](https://console.cloud.google.com/), create a project
   for the assistant. Its **project number** (the project's *Dashboard*, or *IAM & Admin > Settings*)
   is `GOOGLE_CHAT_PROJECT_NUMBER`: Google signs every event as
   `service-<number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`.
2. **The Chat API.** *APIs & Services > Library*: search **Google Chat API**, **Enable**.
3. **The app.** *APIs & Services > Google Chat API > Configuration*:
   - *Application info*: the name, an avatar URL and a description, as people will see the app;
   - leave **Build this Chat app as a Workspace add-on** checked (the default): this channel reads
     add-on events, whose token is an ID token for your endpoint from the project's own add-on service
     account. A Chat app that is not an add-on is not supported;
   - *Interactive features*: **on** (without them the app gets no message);
   - *Functionality*: **Join spaces and group conversations**, if the app is to answer there, not in
     DMs only;
   - *Connection settings*: **HTTP endpoint URL**, then *Triggers*: **Use a common HTTP endpoint URL
     for all triggers**, the endpoint of step 2 (`https://bot.example.com/google-chat`). If you fill
     each trigger instead (messages, added, removed, card clicks, commands), give every one the same
     URL. This exact text is `GOOGLE_CHAT_AUDIENCE`: a trailing `/` or `http` instead of `https` is
     another audience, and every event is refused (`401`);
   - *Visibility*: the people and groups of your domain who may find and add the app;
   - **Save**.
4. **A service account**, which the app calls the Chat API as: *IAM & Admin > Service Accounts >
   Create service account* (no role: the `chat.bot` scope is the app's own), then on it *Keys > Add
   key > Create new key > JSON*. The downloaded file, whole, is `GOOGLE_CHAT_SERVICE_ACCOUNT`. Keep it
   secret; deleting the key in the console revokes it.

### 4. The secrets

```sh
pikit configure
```

It runs expose-cloudflare-tunnel's step first (the hostname, the paths, then "Create the Cloudflare
Tunnel now?": yes asks for the API token without echo), then asks for each required variable:
`GOOGLE_CHAT_SERVICE_ACCOUNT` (paste the JSON key's whole text: a paste over several lines is taken
as one value), `GOOGLE_CHAT_PROJECT_NUMBER`, `GOOGLE_CHAT_AUDIENCE` (the endpoint, exactly as in the
console), then the model's credentials. `pikit configure --generate PIKIT_ADMIN_TOKEN` makes the
dashboard's token. Setting the key in `.env` by hand instead, put it on one line:
`GOOGLE_CHAT_SERVICE_ACCOUNT='<the output of jq -c . key.json>'`.

`GOOGLE_CHAT_ALLOWED_SPACES` is optional, and `pikit configure` does not ask for it: the app starts
with none, and tells each space its id (step 5). A named app's are `GOOGLE_CHAT_<NAME>_…`.

### 5. Run it, and allow your spaces

```sh
pikit up
pikit expose status   # the URL answers from outside
```

In Google Chat, find the app (*New chat*, or *Apps > Add apps* in a space) and send it a message. In a
space that is not allowed yet it answers once that it is not allowed there, with the space's id. Add
the ids to `.env`, separated by commas (`GOOGLE_CHAT_ALLOWED_SPACES=spaces/AAA,spaces/BBB`: a DM is
a space too), and run `pikit up` again: `.env` is read when the container starts. `pikit logs` shows
every refusal and failure, never a token or a message's text.

## On Cloudflare

Two Apps (SPEC §4.1, C1): the Worker's half (`export const worker`, `channel-google-chat-worker`)
serves the route, verifies the token, keys the event (reading the `conversations` setting) and hands it
to its conversation's object through `actor.mailbox` (`google-chat.event`, sent and acknowledged `{}`
once it resolves; `google-chat.click`, called, its answer the response). The object (the default
export) admits, answers and draws. The Worker's URL is public already: `GOOGLE_CHAT_AUDIENCE` is
`https://<worker>/google-chat`. The Google Cloud steps are step 3 above.

## Secrets

Per app (`GOOGLE_CHAT_<NAME>_…` for a named one: `GOOGLE_CHAT_OPS_SERVICE_ACCOUNT` for `ops`). A
missing or unusable required one fails the start, naming it.

| Name | What |
|---|---|
| `GOOGLE_CHAT_SERVICE_ACCOUNT` (secret, required) | the app's service account JSON key, whole: the REST API is called as it (an access token from a JWT it signs, RS256, kept until a minute before it expires) |
| `GOOGLE_CHAT_PROJECT_NUMBER` (required) | the project number: every event's token is signed for `service-<number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com` |
| `GOOGLE_CHAT_AUDIENCE` (required) | the endpoint URL exactly as the Chat API's configuration has it: every event's token is for it |
| `GOOGLE_CHAT_ALLOWED_SPACES` (optional) | the spaces answered (`spaces/AAA` or the id), separated by commas; unset or empty: none yet, each space told its id |

## What it does

- **Ingress.** Each request's bearer token is checked before anything is read: an ID token signed by
  Google (RS256, against Google's JWKs, kept as their `Cache-Control` says, fetched again for an
  unknown key at most once a minute; while Google's keys cannot be fetched, at most once a minute, the
  expired ones serve for an hour), `iss` Google's, `aud` the audience exactly, `email` the
  project's add-on service account and verified, `exp` not past (a minute of skew). A refusal is
  `401`; Google's keys unreachable is `500`, so Google sends the event again. The event goes on
  without its tokens.
- **Access.** A space not in `GOOGLE_CHAT_ALLOWED_SPACES` is told once, in the response, that the app
  is not allowed there, with the space's id; nothing is admitted. Approving a space from the chat is
  pairing's ([features/pairing.md](https://github.com/ajarellanod/pikit/blob/main/features/pairing.md)).
- **Messages.** Admitted as `InboundMessage`: its id the Google message's name (a message Google
  delivers again is the runtime's `duplicate`), `conversationId` the space (what `router-rules`
  matches: an agent per space is one rule), `actor.id` the sender's `users/<id>`. The app's mention is
  cut; in a space or group chat the text starts with the sender's display name. `/new` (or its alias
  `/reset`) starts the conversation over, once per message. Acknowledged `{}` once admitted, within 25 s (under Google's
  30); a failure is `500`, and Google sends it again. Google sends a Chat app no event when a message
  is edited or deleted: an edit is not answered.
- **Conversations.** Each thread is a conversation (`googlechat:spaces/AAA:threads/BBB`), unless the
  `conversations` setting says the chat is one (`googlechat:spaces/AAA`). Either way every answer
  goes to the thread of the message it answers. A chat without threads (a meeting's chat, an old
  group chat) is one conversation, answered at its top.
- **Answers.** "Thinking…" is created where the answer goes when its run starts, under the ids of the
  answer's first piece, shows the answer as it is written (`agent.partial`, at most every
  `previewEveryMs`), and becomes the answer; a run with nothing to say deletes it, a failed one says
  so. Markdown is drawn as Google Chat text, tables and code blocks as cards, public images as image
  cards. Pieces of 4096 characters at most, cut further so a message stays under 32,000 bytes. Each
  message is created under a `requestId` and a `messageId` from its piece's key, so a send repeated
  after a crash is the same message. The 32,000 bytes are measured with the question cards drawn on
  the last piece: past them the cards go as a message of their own right after the text (ids from the
  piece's key, `:parts`). An answer whose run an operator's dashboard message led (a user's message
  queued behind it) goes to the thread of the user's message. `429` waits (Google allows one message
  write a second in a space, for every app in it), `5xx` and network errors are tried again,
  `400`/`401`/`403`/`404` from the Chat API are permanent (a `401` is a token Google refused). The token
  endpoint refusing the service account's key (`invalid_grant`: a wrong, deleted or disabled key) is
  transient: the answers wait, logged as errors from the 3rd failure, and go once the secret is fixed
  (with outbound-durable, within its 24 hours).
- **Files.** Images (PNG, JPEG, WebP, GIF) go to the model; text files (`text/*`, JSON, CSV) into the
  text; anything else (PDF, Office, archives) is written to the conversation's workspace under
  `attachments/<message id>/<file name>`, and the text names its path for the agent's tools.
- **Quotes.** A message that quotes another has the quoted one read and put before its text.
- **Questions** (with tool-ask-user). A question with one `confirm` or `select` field is a card of
  buttons; anything else a card whose button opens a dialog with the form (radio buttons, a dropdown,
  checkboxes, text, a date picker). Each action carries the key of the conversation the card was drawn
  in (the action parameter `key`), and every click is keyed by it, never by the `conversations`
  setting of now: a card stays its conversation's when the setting changes. A click whose question
  belongs to another conversation than its key (a forged key) is refused. A click or a submitted form
  is checked, admitted once as a message whose text says the answer (its id the card's message and the
  question's: concurrent and repeated clicks are duplicates, and a message may carry several
  questions, each answered once), and only the question's card is updated to who answered what (a
  form's message is read first, so its other cards stay). A question answered already is drawn
  answered if its piece is sent again.
  Anyone the channel admits in that conversation may answer; a question is open until it is answered
  or its conversation is reset (`/new`): a click after that is told the question was asked in a
  conversation that was reset, and admits nothing.

## Bounds

| What | Bound |
|---|---|
| Files per message | 10 |
| Bytes per file / per message | 10 MB / 25 MB |
| Images per message, in all | 1 MB (Cloudflare's bound on a request's images; the same on a server) |
| Text of text files per message | 50,000 characters |
| A quoted message | 2,000 characters |
| Downloads and quotes before admission | 20 s |
| The hand-off of an event | 25 s (Google waits 30) |
| A call to Google | 15 s |
| A piece | 4096 characters, 32,000 bytes as a message |
| Pieces per run's answer | 20 (a Durable Object's subrequests) |
| Retries of an answer | after 1 s, 5 s, 30 s, then every minute, or Google's `Retry-After` |

## Not read: Drive files

A file shared from Drive (`driveDataRef`) is named in the text as not read, with "attach the file
itself": the app's service account is not shared on the files people post, so it cannot read them;
reading as each user (domain-wide delegation, OAuth per user) would give the app far more than one file.
PDFs and Office files are not turned into text here: they are left in the workspace for the agent's
tools.

## The `conversations` setting

Per app: `default` (`"thread"` or `"chat"`) and `chats`, the chats that differ
(`{ "spaces/AAA": "chat" }`). With `settings` installed it is edited from the dashboard's Settings
(this component's section); its defaults are the config's `conversations`, and without `settings` the
config is the setting. A change applies to the next message: a conversation already going keeps its key.

## Config

```ts
"channel-google-chat": {
  instances: [],                                  // more Chat apps by name: ["ops"] runs googlechat:ops at /google-chat/ops
  conversations: { default: "thread", chats: {} }, // the setting's defaults: { "spaces/AAA": "chat" } makes that chat one conversation
  thinkingText: "Thinking…",
  previewEveryMs: 3000,                           // 0 keeps "Thinking…" until the answer
  apiBase: "https://chat.googleapis.com",         // values, for a test double
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
},
// On Cloudflare, the Worker's half (workerConfig): the same instances, conversations, apiBase and jwksUrl
// (defaults included). `pikit doctor`, and so `pikit dev` and `pikit up`, fails while they differ (doctor.ts).
"channel-google-chat-worker": { instances: [], conversations: { default: "thread", chats: {} } },
```

## Tests

Copied with the component (`src/pikit/channel-google-chat/`), against the fake Google
(`fake-google-chat.test-support.ts`: the REST API, the token endpoint and the signing keys as a `fetch`
double and on a local port, ID tokens signed with a test key pair, event builders):

- `channel-google-chat.test.ts`: the component composed on each target's shape, its secrets, keys,
  setting and event parser, and the fake itself.
- `route.test.ts` and `token.test.ts`: the endpoint and the ID token (a wrong audience, issuer, email,
  signature or key, an expired token), on a server first, then over a mailbox.
- `admission.test.ts`: keys, threads, the setting, access, `/new`, mentions, quotes, attachments.
- `transport.test.ts`: the access token, the API client, markdown to text and cards, pieces, both ids,
  the placeholder, previews and the sweep, each failure classified.
- `questions.test.ts`: cards, dialogs, clicks and answers, a reset closing a question.
- `conformance.test.ts`: the channel conformance suite (`@pikit/contracts/testing`; a question it
  draws reaching Google as its card) and the lifecycle suite, on a server's App and on Cloudflare's two
  halves.
- `doctor.test.ts`: the `pikit doctor` step, both halves' config compared, defaults included.

In the registry, beside `files/`: `server.test.ts`, the server lane (the default export composed as
`pikit add` composes it on a server, over real HTTP: a message answered in its thread, the setting, an
image and a PDF, a question clicked, a restart in the middle of an answer, a refused token; and with
`mailbox-local` installed, `actor.inbox` scope `"all"`, events handled in process as with none). The
workerd lane's `tests/workerd/test/google-chat.workerd.ts` runs the Worker half and a real Durable
Object, with execution-do: a message's PDF written to the workspace in the object's SQLite. What only the real Google Chat can show (a DM's thread, the errors Google gives a repeated id,
the look of cards) is checked live, once: the feature note's "Checked live".

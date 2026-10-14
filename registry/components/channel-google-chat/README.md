# channel-google-chat

Talk to your agents in Google Chat: spaces, group chats and DMs, through a Chat app of your own
([features/channel-google-chat.md](https://github.com/ajarellanod/pikit/blob/main/features/channel-google-chat.md)).
Every answer goes to its message's thread; each thread is a conversation by default, or a whole chat
is one (a setting). "Thinking…" is written into the answer as the model writes it; tables and code
are drawn as cards, images as image cards; photos and files are read; a quoted message is the
reply's context; the agent's questions (`askUser`, [tool-ask-user](../tool-ask-user/README.md)) are
asked with buttons and forms.

- **Provides:** `http.route`: `POST /google-chat` (and `POST /google-chat/<name>` per named app), the
  app's endpoint.
- **Requires:** `secrets`, `conversations.registry`, `agent.runtime`, `agent.submissions`,
  `storage.kv`, `wakeups`. **Uses, if installed:** `outbound.queue` (answers stored before they are
  sent: an answer cut by a restart is sent after it), `settings` (the `conversations` setting, edited
  from the dashboard), `workspace` or `execution` (where files other than images and text go), and on
  Cloudflare `actor.inbox` and `actor.mailbox`. The Worker's half requires `secrets` and
  `actor.mailbox`, and uses `settings`.
- **Targets:** `server` and `durable` (Cloudflare). One code on both: in `start`, `actor.inbox`'s
  `scope` says where it runs.
- **Installs to:** `src/pikit/channel-google-chat/`; its Settings section to the dashboard.
- **npm dependencies:** `typebox`. Google's tokens are checked and signed with WebCrypto, not with
  `googleapis` or `google-auth-library`, which do not run in a Worker.

## On a server

The default export is everything, in the one App: its route verifies Google's token, keys the event
and hands it to the handler in process; answers go by the REST API. `pikit add channel-google-chat`
installs only it. What it runs with:

| Component | Why |
|---|---|
| `server-bun` | serves the route |
| `storage-sqlite` and `storage-kv-sql` | `storage.kv`: the delivery cursor, the threads of whole chats' answers, the placeholders, the questions |
| `wakeups-timers` | answer delivery's retries, the start-up sweep |
| `outbound-durable` | an answer survives a restart (without it, an answer whose send a restart cut is sent again from the runtime's record, as direct delivery says) |
| `workspace-local` (or `execution-local`) | where a PDF or an archive sent in the chat is written for the agent's tools |
| `tool-ask-user` | the agent's questions, drawn as cards (optional) |

Google calls an HTTPS URL. On a server, `pikit expose` (expose-cloudflare-tunnel) gives one: list
`/google-chat` in `PIKIT_EXPOSE_PATHS`, and `GOOGLE_CHAT_AUDIENCE` is the public URL plus the path
(`https://bot.example.com/google-chat`). Your own reverse proxy works too: the audience is whatever URL
you give Google, exactly.

## On Cloudflare

Two Apps (SPEC §4.1, C1): the Worker's half (`export const worker`, `channel-google-chat-worker`)
serves the route, verifies the token, keys the event (reading the `conversations` setting) and hands it
to its conversation's object through `actor.mailbox` (`google-chat.event`, sent and acknowledged `{}`
once it resolves; `google-chat.click`, called, its answer the response). The object (the default
export) admits, answers and draws. The Worker's URL is public already: `GOOGLE_CHAT_AUDIENCE` is
`https://<worker>/google-chat`.

## Setting up the app in Google Cloud

The assistant has a Chat app of its own, in its own Google Cloud project: the app's endpoint is this
channel's, never shared with another service. You need a Google Workspace account (Chat apps are not
available to personal Gmail accounts).

1. **A new project.** In the [Google Cloud console](https://console.cloud.google.com/), create a
   project for the assistant. Its **project number** (the project's dashboard, or *IAM & Admin >
   Settings*) is `GOOGLE_CHAT_PROJECT_NUMBER`.
2. **The Chat API.** *APIs & Services > Library*: enable the **Google Chat API**.
3. **The app.** *Google Chat API > Configuration*:
   - name, avatar URL and description, as people will see the app;
   - leave **Build this Chat app as a Workspace add-on** checked (the default): this channel reads
     add-on events, and the token of each event is then an ID token for your endpoint, from the
     project's own add-on service account. A Chat app that is not an add-on is not supported;
   - *Functionality*: let it join spaces and group conversations, if you want it there;
   - *Connection settings*: **HTTP endpoint URL**, one URL for every trigger: your public URL plus
     `/google-chat` (`/google-chat/<name>` for a named app). This exact text is `GOOGLE_CHAT_AUDIENCE`;
   - *Visibility*: the people and groups of your domain who may find and add the app;
   - save.
4. **A service account**, which the app calls the API as: *IAM & Admin > Service Accounts > Create
   service account* (no role needed: the Chat API's `chat.bot` scope is the app's own), then *Keys >
   Add key > Create new key > JSON*. The whole downloaded file is `GOOGLE_CHAT_SERVICE_ACCOUNT`. Keep
   it secret; delete the key in the console to revoke it.
5. **The secrets** below, then start the app (`pikit up`), and add the app in Google Chat (a DM, or
   *Apps > Add apps* in a space). In a space not allowed yet the app says so, with the space's id: add
   it to `GOOGLE_CHAT_ALLOWED_SPACES`.

## Secrets

Per app (`GOOGLE_CHAT_<NAME>_…` for a named one: `GOOGLE_CHAT_OPS_SERVICE_ACCOUNT` for `ops`). A
missing or unusable one fails the start, naming it.

| Name | What |
|---|---|
| `GOOGLE_CHAT_SERVICE_ACCOUNT` (secret) | the app's service account JSON key, whole: the REST API is called as it (an access token from a JWT it signs, RS256, kept until a minute before it expires) |
| `GOOGLE_CHAT_PROJECT_NUMBER` | the project number: every event's token is signed for `service-<number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com` |
| `GOOGLE_CHAT_AUDIENCE` | the endpoint URL exactly as the Chat API's configuration has it: every event's token is for it |
| `GOOGLE_CHAT_ALLOWED_SPACES` | the spaces answered (`spaces/AAA` or the id), separated by commas; empty: none yet |

## What it does

- **Ingress.** Each request's bearer token is checked before anything is read: an ID token signed by
  Google (RS256, against Google's JWKs, kept as their `Cache-Control` says, fetched again for an
  unknown key at most once a minute), `iss` Google's, `aud` the audience exactly, `email` the
  project's add-on service account and verified, `exp` not past (a minute of skew). A refusal is
  `401`; Google's keys unreachable is `500`, so Google sends the event again. The event goes on
  without its tokens.
- **Access.** A space not in `GOOGLE_CHAT_ALLOWED_SPACES` is told once, in the response, that the app
  is not allowed there, with the space's id; nothing is admitted. Approving a space from the chat is
  pairing's ([features/pairing.md](https://github.com/ajarellanod/pikit/blob/main/features/pairing.md)).
- **Messages.** Admitted as `InboundMessage`: its id the Google message's name (a message Google
  delivers again is the runtime's `duplicate`), `conversationId` the space (what `router-rules`
  matches: an agent per space is one rule), `actor.id` the sender's `users/<id>`. The app's mention is
  cut; in a space or group chat the text starts with the sender's display name. `/new` starts the
  conversation over, once per message. Acknowledged `{}` once admitted, within 25 s (under Google's
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
  after a crash is the same message. `429` waits (Google allows one message write a second in a space,
  for every app in it), `5xx` and network errors are tried again, `400`/`403`/`404` are permanent.
- **Files.** Images (PNG, JPEG, WebP, GIF) go to the model; text files (`text/*`, JSON, CSV) into the
  text; anything else (PDF, Office, archives) is written to the conversation's workspace under
  `attachments/<message id>/<file name>`, and the text names its path for the agent's tools.
- **Quotes.** A message that quotes another has the quoted one read and put before its text.
- **Questions** (with tool-ask-user). A question with one `confirm` or `select` field is a card of
  buttons; anything else a card whose button opens a dialog with the form (radio buttons, a dropdown,
  checkboxes, text, a date picker). Each button carries the conversation's key (the action parameter
  `key`), since a click inside a dialog has no message to key it by. A click or a submitted form is
  checked, admitted once as a message whose text says the answer (one message id per question:
  concurrent and repeated clicks are duplicates), and the card is updated to who answered what.
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
// On Cloudflare, the Worker's half (workerConfig): the same instances, conversations, apiBase and jwksUrl.
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
- `conformance.test.ts`: the channel conformance suite (`@pikit/contracts/testing`) and the lifecycle
  suite, on a server's App and on Cloudflare's two halves.

In the registry, beside `files/`: `server.test.ts`, the server lane (the default export composed as
`pikit add` composes it on a server, over real HTTP: a message answered in its thread, the setting, an
image and a PDF, a question clicked, a restart in the middle of an answer, a refused token). The
workerd lane's `tests/workerd/test/google-chat.workerd.ts` runs the Worker half and a real Durable
Object. What only the real Google Chat can show (a DM's thread, the errors Google gives a repeated id,
the look of cards) is checked live, once: the feature note's "Checked live".

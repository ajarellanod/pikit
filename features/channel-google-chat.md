# Google Chat channel

**Public appeal:** — (OpenClaw has it; it is not what draws the public)

**Specified:** yes: this note, the final version, built in one change: the component, the tool
`askUser`, and the contract changes they bring (images in, parts out, the answer
while it is written). Keys and idempotency were decided in the former SPEC §5.

**Needed by:** nothing required. It is the next channel.

## What it gives
A Google Chat app: an agent per space, every answer in its message's thread, a conversation per
thread (or per chat, a setting), "Thinking…" written
into the answer as the model writes it, markdown drawn as Google Chat text and cards (tables, code,
images), photos and files read by the agent, a quoted message as context, spaces allowed before they
are answered, and questions the agent asks with buttons, selects and dialogs, answered in the chat.

## What it does, and where each piece goes

A channel takes markdown text and draws it its platform's way, so most of it is the component's own.
What another component produces or reads (a question, an image, the answer while it is written) is
a contract, added here with its first producer and its first consumer.

| Capability | Here | Contract change |
|---|---|---|
| Webhook verified by Google's ID token | the channel's own authentication (`inbound.ts`: not a shared contract) | none |
| Every answer in the message's thread; a thread as the conversation, or the whole chat | the key the channel builds, its `conversations` setting ([threads](threads.md)) | none |
| An agent per space | `InboundMessage.conversationId` is the space: one `router-rules` rule | none |
| "Thinking…" placeholder, written as the model writes, edited into the answer | the channel, on `agent.started` and `agent.partial` | **`agent.partial`** |
| Markdown to Google Chat text, tables and code as cards, 4096-character pieces | the transport's `split` and `send` | none |
| Markdown images sent as image cards | the transport's `send` | none |
| Retries, error classification | `DeliveryError` (`transient`, `rate_limited`, `permanent`) | none |
| A message created once, whatever is retried | `ChannelTransport.idempotent`: `requestId` and `messageId` from the piece's key | none |
| Mention of the app stripped; DMs and spaces told apart | the channel, before `admitInbound` | none |
| Edited and deleted messages: Google sends the app no event, nothing is answered | — | none |
| `ADDED_TO_SPACE`: a space is allowed before it is answered | spaces allowed in config; a stranger space is told its id | none |
| The agent stays silent | an answer with no text and no part sends nothing | none |
| Photos read by the model | images downloaded, bounded, passed on | **`InboundMessage.images`** |
| Text files read; other files left in the workspace for the agent's tools | the channel, before dispatch (`beforeDispatch`) | none |
| A quoted message as the reply's context | the channel reads it (`spaces.messages.get`) and quotes it in the text | none |
| Questions: confirm and select cards, dialogs with forms | the tool `askUser`, a `question` part, drawn by the transport | **parts, `draws`, `AgentResult.parts`** |
| A question's answer back to the agent | a click or a form, admitted as a message whose text says it | none (`InboundMessage.replyTo` waits for a reader: below) |

Out of this feature, with why:
- **Questions from Pi's extensions** (`ctx.ui.select`, `confirm`, `input`): pi-durable has no UI API
  for its extensions. They come when it does ([approvals](approvals.md)).
- **Decisions** that wait days with reminders and escalation: [approvals](approvals.md)' own. A
  question here never makes a run wait (below).
- **A scheduled answer's notification** (a mention): no scheduler exists to produce one
  ([scheduler](scheduler.md)).
- **Drive files**: a Chat app's service account is not shared on the files people post, so it cannot
  read them; they are named as not read. Reading as each user (domain-wide delegation, OAuth per
  user) gives the app far more than one file.
- **PDFs and Office files read as text**: they are left in the workspace for the agent's tools, as
  [rich content](rich-content.md) decided; turning them into text is a tool's or a shared stage's.
- **Senders restricted by Workspace domain**: who may talk is the router's or
  [pairing](pairing.md)'s, not a channel's.

## Decisions

**The component.** `channel-google-chat`, kind `channel`, both targets. Several Chat apps are
instances (`googlechat`, `googlechat:ops`), as channel-telegram's accounts are, each with its own
endpoint path and secrets. A server is a first target, not a port: everything works there and is
tested there first.

**One code, both targets**, as settings-store does it. The component never reads the target: in
`start`, `actor.inbox`'s `scope` says where it runs.
- **A server** (`"all"`, or no `actor.inbox`): the default export is everything, in the one App. Its
  route verifies the token, then hands the event to the same handler the object runs on Cloudflare,
  in process: no mailbox, no second App. The CLI installs only the default export on a server, so
  nothing here may live in the Worker's half alone.
- **Cloudflare** (`"one"`, each conversation's Durable Object): the Worker's half
  (`export const worker`, `channel-google-chat-worker`) serves the route, verifies and hands each
  event to its conversation's object through `actor.mailbox`; the object admits, answers and draws.
  The default export registers the routes too, where no server serves them.

It requires `secrets`, `conversations.registry`, `agent.runtime`, `agent.submissions`, `storage.kv`
and `wakeups`, and provides `http.route`; it uses `outbound.queue`, `settings`, `workspace`,
`execution`, and on Cloudflare `actor.inbox` and `actor.mailbox`, when installed. The Worker's half
requires `secrets` and `actor.mailbox`, and uses `settings`.

**On a server**, what it runs with: `server-bun` serving the route; `storage-sqlite` under
`storage.kv`; `wakeups-timers`; `outbound-durable`, so an answer survives a restart (without it an
answer cut by a restart is lost, as `delivery.ts` says of direct delivery); `workspace-local` for
files. Google calls an HTTPS URL: `pikit expose` (expose-cloudflare-tunnel) gives one, or the
operator's own proxy; that URL plus the path is `GOOGLE_CHAT_AUDIENCE`.

**The app.** The assistant has a Chat app of its own, in its own Google Cloud project, never one
shared with another service: the app's endpoint is this channel's. It is built as a Google Workspace
add-on that extends Chat, the Chat API console's default. Its events are add-on event objects
(`chat.messagePayload`, `chat.addedToSpacePayload`, `chat.removedFromSpacePayload`,
`chat.buttonClickedPayload`), and its token is always an ID token for the endpoint URL from the
project's own service account, so both `aud` and `email` name this app. A Chat app that is not an
add-on is not supported: its own `Event` format and other tokens (a shared
`chat@system.gserviceaccount.com` sender, or a JWT for the project number) would be a second
ingress for nothing a user sees.

**Secrets, per instance** (`GOOGLE_CHAT_<NAME>_…` for a named one): the service account's JSON key
(`GOOGLE_CHAT_SERVICE_ACCOUNT`), the project number (`GOOGLE_CHAT_PROJECT_NUMBER`, for the token's
`email`), the endpoint URL as configured (`GOOGLE_CHAT_AUDIENCE`) and the allowed spaces
(`GOOGLE_CHAT_ALLOWED_SPACES`).

**Ingress.**
- `POST <path>`, an `http.route`, the endpoint URL of every trigger. Google's bearer token is
  verified before anything else; a failure answers `401`. It is an OpenID Connect ID token signed by
  Google (RS256), checked with WebCrypto, not with `googleapis` or `google-auth-library`, which do
  not run in a Worker:
  - the signature, against the JWKs at the `jwks_uri` of Google's OpenID discovery document
    (`https://www.googleapis.com/oauth2/v3/certs` today), cached as their `Cache-Control` says;
  - `iss` is `https://accounts.google.com` or `accounts.google.com`;
  - `aud` is the endpoint URL exactly as configured in the Chat API;
  - `email` is the app's service account,
    `service-<project number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`, and `email_verified`
    is true;
  - `exp` has not passed.
- A message, an add, a removal, on a server: the route runs the handler in process, which
  downloads (within a deadline under Google's 30 seconds, a value) and admits, then acknowledges with
  `{}`, an empty JSON object, once the message is admitted (P5). A failure answers `500`, and Google
  may send it again. The answer goes by the REST API.
- The same on Cloudflare: the Worker hands the event to the conversation's object with
  `actor.mailbox.send(key, "google-chat.event", event)`, as channel-telegram-webhook hands
  `telegram.update`, and acknowledges with `{}` once the hand-off resolves; the object downloads,
  admits and answers.
- A button click needs its answer in the response (a dialog to open, a card to update), within
  Google's 30 seconds: on a server the route asks the handler in process; on Cloudflare the Worker
  asks the object with `actor.mailbox.call(key, "google-chat.click", event)`. Either way it
  returns the action the handler answers.

**Identity and deduplication.**
- `InboundMessage.id` is the Google message's `name` (`spaces/AAA/messages/BBB`). Google sends a
  Chat app no event when a message is edited or deleted (only Workspace Events API subscriptions
  see those, through Pub/Sub), so an edit is not answered.
- No [inbound dedup](inbound-dedup.md): Google may deliver an event again after a timeout or a
  non-2xx answer; the redelivered event has the same `name`, the runtime answers `duplicate`,
  nothing runs. Before admission the channel only reads, downloads and writes files under the
  message's own name; nothing it sends to the space depends on a message being new.
- `actor.id` is the sender's `users/<id>` (stable; the email may be absent). In a space shared by
  several people, the message's text says who wrote it (their display name), so the agent knows who
  is talking; trusted identity stays in `actor` (`RUN_REQUESTS`).

**Conversations and routing.**
- `InboundMessage.conversationId` is the space (`spaces/AAA`): what `router-rules` matches, so an agent
  per space is one rule and needs no `thread` field.
- Every answer goes to the thread of the message it answers (`thread.name`,
  `messageReplyOption: REPLY_MESSAGE_OR_FAIL`): a message sent at the top of a chat starts a new
  thread, and the answer opens it. In spaces, DMs and group chats alike: DMs and group chats have
  inline threads too.
- Each thread is a conversation, by default. The `conversations` setting, per instance, says it:
  `default` (`"thread"`) and `chats`, the chats that are one conversation each
  (`{ "spaces/AAA": "chat" }`). An operator edits it from the dashboard's Settings (its section,
  `settings/index.tsx`); its defaults come from the component's config, so without `settings`
  installed the config holds it. A change applies to the next message: a conversation already going
  keeps its key.
- The key is the channel's own (`AdmitOptions.key`, [conversation routing](conversation-routing.md)):
  `googlechat:spaces/AAA:threads/BBB` for a thread, `googlechat:spaces/AAA` for a whole chat. The
  route builds it, reading the setting: on a server in the one App, on Cloudflare in the Worker's
  half (settings-store answers in the Worker's App too).
- In a whole chat the answer still goes to its message's thread: the thread is kept in
  `storage.kv` under the answer's key, since the conversation's key does not hold it.
- A chat whose `spaceThreadingState` is `UNTHREADED_MESSAGES` (a meeting's chat, a group chat from
  before 2022) has no threads: it is one conversation, answered without a thread. The state comes
  from the event's `space`, or from `spaces.get` when it lacks it, kept in `storage.kv`.

**Access.** Spaces are allowed in the channel's secrets. A space not allowed is a stranger: when the
app is added to it (`ADDED_TO_SPACE`), and on each message from it, the app answers once that it is
not allowed there and gives the space's id for the operator (as channel-telegram-webhook tells a
stranger their id), and admits nothing. Approving a space from the chat or the dashboard is
[pairing](pairing.md). `REMOVED_FROM_SPACE` is logged; answers still owed to that space fail
`permanent`. `/new` resets the conversation, as in channel-telegram.

**"Thinking…", written as the model writes, edited into the answer.**
- On `agent.started` for a conversation of the channel (`route(key)`), and not for a dashboard request
  (`isDashboardRequest`), the channel creates the placeholder where the answer goes. Its `messageId`
  is the one piece `#0` of that answer would have (below), so the answer's first piece finds it with
  no record: a resumed run (`resumed: true`) creates the same message again, which Google refuses
  or returns. Its text is a value (`thinkingText`).
- While the run goes, the runtime's `agent.partial` events carry the answer as written so far; the
  channel edits the placeholder with its first 4096 characters, at most once every few seconds (a
  value, `previewEveryMs`; `0` keeps "Thinking…"), since a space takes one message write a second for
  every app in it. A preview lost costs nothing: previews never go through answer delivery.
- The transport's `send` for piece `#0` edits the placeholder (a PATCH: repeating it is harmless),
  and creates the message under the same `messageId` when there is none (the channel was down when
  the run started); the other pieces are created after it. Messages queued behind a run get no
  placeholder of their own: the next run's `agent.started` names the first of them.
- A run with nothing to send (aborted, an empty answer) deletes its placeholder on `agent.settled`;
  a failed run's placeholder becomes the channel's failure text. The channel marks each placeholder
  it creates in `storage.kv`; at start it deletes those whose request is settled
  (`agent.submissions.get`) with nothing left to send, a crash's leftovers.

**Answers.**
- `startAnswerDelivery` in `start`, with the channel's transport, `route`, `text` and `policy`
  ([answer delivery](completed/outbound-delivery.md)). An answer carries the run's text and its parts.
- `split` cuts at 4096 characters (a value) on a paragraph or line, never inside a table or a code
  block. Google documents no limit of characters for `text`, only 32,000 bytes for a message as a
  whole (its text and cards); 4096 characters is a size that has worked in practice, and a piece
  whose message as JSON would pass 32,000 bytes is cut further.
  `send` turns each piece's markdown into Google Chat's text format, tables and code blocks into
  `cardsV2`, and markdown images with a public URL into image cards.
- The transport is `idempotent`. Each create carries two ids from the piece's key: a `requestId`, a
  UUID from its SHA-256 hash (Google recommends a UUID and documents no other format), and a
  `messageId`, `client-` and 56 hexadecimal characters of the same hash (Google: up to 63 lowercase
  letters, digits and hyphens, unique within a space). A quick repeat returns the first message
  (`requestId`); a late one, after Google forgot the request, is refused because the `messageId`
  exists, and the transport reads that message (`spaces.messages.get`) and counts it delivered.
  A repeat must be identical and come from the same service account.
- Failures: `429` is `rate_limited` (with `Retry-After` when given; Google allows one message write
  a second in a space, shared by every app in it, and asks for exponential backoff), network errors
  and `5xx` are `transient` (`maybeSent` after a timeout), `400`, `403` and `404` are `permanent`
  (the app removed, the space gone).
- The REST API is called as the service account: its JSON key from `secrets`, an access token from a
  signed JWT (RS256, WebCrypto) for the `chat.bot` scope, kept in memory until it expires.

**Attachments in.**
- Chat media (`attachmentDataRef`, the `media.download` API, `chat.bot`) is downloaded in the
  object, before admission, bounded by values: how many per message, bytes each, bytes in all.
- Images (`image/png`, `image/jpeg`, `image/webp`, `image/gif`) go to the model as
  `InboundMessage.images` (on Cloudflare 1 MB of images in all, as `AgentRequest.images` says).
- Text files (`text/*`, JSON, CSV) are appended to the message's text, bounded.
- Any other file (PDF, Office, archives) is written to the conversation's workspace
  (`workspace`, else `execution`) under `attachments/<message id>/<file name>`, in `beforeDispatch`
  once the conversation is known, and the text names its path for the agent's tools. With neither
  installed, or past the bound, it is named as not read, with why.
- A Drive file (`driveDataRef`) is named as not read: "attach the file itself".

**Quoted messages.** A message that quotes another (`quotedMessageMetadata`) has the quoted message
read (`spaces.messages.get`, `chat.bot`) and put before its text as a quote, bounded. A quote the
app cannot read is named as unread.

**Questions.**
- The tool `askUser` (component `tool-ask-user`, both targets, `replay: "safe"`) asks one question:
  a title, a description, and fields (`confirm`, `select`, `multiselect`, `text`, `date`, each
  named, with options where they apply). It never waits for the answer: it ends the run
  (`control.terminate`) with the question as a part of the run's answer (`AgentResult.parts`), and
  the answer comes back later as a new message. A run that waits days would hold a Durable Object
  awake for days, and pi-durable has no wait on an outside signal.
- The question is a `question` part (`AppMessageParts`, declared in `@pikit/contracts`' `question.ts`), with an id
  (`<conversation id>:<request id>:<tool call id>`) and a `fallback` text that lists the fields and
  their options. A transport that does not draw it sends the fallback; the answer typed back is an
  ordinary message.
- This transport draws it (`draws: ["question"]`): one `confirm` or `select` field as a card with
  buttons; anything else as a card whose button opens a dialog with the form. The card's message is
  recorded in `storage.kv` under the question's id.
- A click or a submitted form is admitted as a message whose text says it in words ("Answer to
  …: …", the question's id and each field's value) for the model: that text is the whole answer, as
  one typed back to a folded question is. The card is updated to say who answered what (the click's response). A
  question already answered, or unknown, answers the click with that, and admits nothing.
- Anyone the channel admits in that conversation may answer, as anyone there may talk to the agent;
  the answer carries their `actor`. Several questions may be open in a conversation; each is
  answered once. A question stays open until answered or the conversation is reset.

## The contract changes

Each is added with its first producer and first consumer, both in this change, with a test, and
said in `docs/contracts.md`, SPEC, the capability catalogue and the notes it touches (the contract
rules of `AGENTS.md`).

- **`InboundMessage.images?: readonly AgentImage[]`.** `admitInbound` passes them to `dispatch` as
  `AgentRequest.images`; an `inbound.normalize` stage may keep or drop them; whoever builds the
  message bounds them, as `AgentRequest.images` says. Producer: this channel; consumer: the runtime.
- **Parts**, as [rich content](rich-content.md) shaped them: `AppMessageParts` (declaration merging,
  the core declares none), `MessagePart` (`{ type, fallback }` and the declared fields),
  `OutboundMessage.parts`, and `ChannelTransport.draws`. Delivery folds every part a transport does
  not draw into the text as its fallback before splitting; a drawn part goes with the message's
  last piece. Producer: `tool-ask-user`; consumer: this transport.
- **The `question` part** (`question.ts` in `@pikit/contracts`): the question's shape, its one
  check (`questionProblem`), its fallback (`questionPart`), and its answer checked and said in words
  (`answerProblem`, `answerText`). Declared in the contracts, not by `tool-ask-user`: who asks and
  who draws must not know each other ([approvals](approvals.md)); the core still declares no kind.
  Producer: `tool-ask-user`; consumers: this transport and its clicks.
- **`AgentResult.parts`** (and `RunSettlement`'s): the parts the run's tools gave, in order.
  runtime-pi collects what a tool returns as parts; an answer with parts and no text is still delivered.
- **`InboundMessage.replyTo` is not added.** Its only reader would be the model, which reads the
  message's text, and "any stage": nothing in this change reads the field (the channel knows a
  question is answered from its own record of the card, by the click's question id, not from the
  message). A field with no reader is speculative (the contract rules of `AGENTS.md`, 1): it comes
  with the first stage or tool that reads it ([rich content](rich-content.md)'s shape stays).
- **`agent.partial`** (`{ conversation, requestId, text }`): the answer as written so far (the text of
  the response the model is writing now: each model call of a run starts again), emitted by
  runtime-pi from pi-durable's live state, at most once a second per conversation, never after the
  run's end. A notice: one lost costs nothing. Producer:
  runtime-pi; consumer: this channel ([streaming replies](streaming-replies.md)).

## How it is built: work for parallel agents

One branch, one worktree per agent where they write in parallel. The contracts come first, since
every other part builds on their types; then the rest in parallel; then one review of the whole.

1. **Contracts** (one agent, first): the changes above in `@pikit/contracts` and
   `@pikit/pi-adapter`, delivery folding parts, runtime-pi emitting `agent.partial` and collecting
   parts, their tests, `docs/contracts.md`, SPEC, the capability catalogue. Gate: the whole suite.
2. **Then in parallel:**
   - **Ingress**: the route per instance, token verification with a test key pair, event parsing,
     the choice by `actor.inbox`'s scope: in process on a server (its first test), the hand-off and
     the click call through `actor.mailbox` in the Worker's half on Cloudflare; stranger replies.
   - **Admission** (the handler, the same code on both targets): keys and threads, the
     `conversations` setting and its Settings section, access, `/new`, mention stripping, quoted
     messages, attachments (images, text, workspace files), admission.
   - **Transport**: the access token, markdown to text and cards, `split`, both ids, the placeholder
     and its previews, failures, the start-up sweep.
   - **Questions**: `tool-ask-user`, the question part, its cards and dialogs, clicks and answers.
   - **Test harness**: a fake Google Chat API (a `fetch` double: messages, media, spaces, ids
     refused when repeated), the server lane first (the one App, real HTTP), the conformance runs,
     then the workerd lane.
3. **Then:** the component's README (the console steps: a new project, the add-on box left checked,
   the HTTP endpoint URL, the service account), `bun run registry generate` and `validate`, and one
   review of the whole change against this note.

## Tests
- **The server lane, first:** an App composed as `pikit add` composes it on a server (the default
  export only, `server-bun` serving real HTTP, `storage-sqlite`, `wakeups-timers`, `outbound-durable`,
  `workspace-local`, no `actor.*`): a signed request in, admitted, answered by the fake API, a card
  clicked; a restart in the middle of an answer, the answer delivered after it.
- `createChannelConformance` (`@pikit/contracts/testing`) and `createLifecycleConformance`, on the
  server's App, then on both halves of Cloudflare's.
- The transport against the fake API: pieces, cards, both ids (a late repeat refused, read, counted
  delivered), the placeholder found by piece `#0` and created when missing, previews throttled, each
  failure classified.
- The ID token checked with a test key pair: a wrong audience, issuer, email or signature, and an
  expired token, refused with `401`.
- The placeholder's life: started, resumed (no second one), aborted (deleted), failed (the failure
  text), a crash in between (swept at start).
- Attachments: images reach `AgentRequest.images`, text files the text, other files the workspace;
  every bound; a Drive file named.
- Questions: drawn as a card or a dialog; folded to text by a transport that does not draw; a click
  admitted once, its answer in its text; a second click told it is answered; the run ended by `askUser`.
- The contract changes: each with a test in its package; a case of the channel suite that a broken
  provider fails (mutate it, see it fail, restore).
- The `durable` lane in workerd: the Worker verifies, the object admits, answers and draws.

## Checked live, once, with the real app
Before it is called done, with a test project's app, on a server first (`pikit up`, the URL from
`pikit expose`), then on Cloudflare: the events of a DM, a group chat and a threaded
space (whether `space` carries `spaceType` and `spaceThreadingState`); the app answering in a
thread in a DM and in a group chat (Google documents `messageReplyOption` for named spaces only: if
a DM refuses it, DMs are whole chats until it does); a `messageId` repeated (the error Google gives)
and a `requestId` repeated; whether `user.email` and `user.domainId` arrive; a card, a dialog and a
form; an answer of several pieces; a Drive file refused.

## Pi first
Nothing in Pi: channels are pikit's (SPEC P1). The images are Pi's `ImageContent`, as
`AgentRequest.images` already are. The answer as it is written is pi-durable's live state, which
runtime-pi re-emits; pikit builds no streaming of model calls. `askUser` is a pi-durable tool; its
question needs no task engine, since no run waits for it.

## Open questions
- Whether Google lets the app answer in a thread in a DM and a group chat (checked live above). If
  it refuses, those chats are whole chats, answered at the top.

## Moved from the former SPEC
The former SPEC §18, "Higher-level components":

| Component | What it encodes |
|---|---|
| `channel-google-chat` | Google Chat app: JWT-verified webhook ingress, REST transport with message create/patch, cards, threads, media. |

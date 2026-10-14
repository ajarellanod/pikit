# Google Chat channel

**Public appeal:** — (OpenClaw has it; it is not what draws the public)

**Specified:** yes: this note, in two phases. Phase 1 is the component plus one contract field
(`InboundMessage.images`); phase 2 is the [approvals](approvals.md) contract, for questions drawn
as cards and dialogs. Keys and idempotency were decided in the former SPEC §5.

**Needed by:** nothing required. It is the next channel.

## What it gives
A Google Chat app: an agent per space, a conversation per thread or per space, "Thinking…" edited
into the answer, markdown drawn as Google Chat text and cards (tables, code, images), photos and files
read by the agent, spaces allowed before they are answered, and (phase 2) questions with buttons,
selects and dialogs.

## What it does, and where each piece goes

A channel takes markdown text and draws it its platform's way, so almost everything is the
component's own.

| Capability | Here | Contract change |
|---|---|---|
| Webhook verified by Google's ID token | the channel's own authentication (`inbound.ts`: not a shared contract) | none |
| Replies in the message's thread; a thread or the whole space as the conversation | the key the channel builds, a value per space in its config ([threads](threads.md)) | none |
| An agent per space | `InboundMessage.conversationId` is the space: one `router-rules` rule | none |
| "Thinking…" message edited into the answer | sent on `agent.started`, edited by the transport's first piece (below) | none |
| Markdown to Google Chat text, tables and code as cards, pieces under 32,000 bytes | the transport's `split` and `send` | none |
| Markdown images sent as image cards | the transport's `send` | none |
| Retries, error classification | `DeliveryError` (`transient`, `rate_limited`, `permanent`) | none |
| Create with `requestId` (a repeat returns the first message) | `ChannelTransport.idempotent`, a UUID from the piece's key | none |
| Mention of the app stripped; DMs and spaces told apart | the channel, before `admitInbound` | none |
| Edited and deleted messages: Google sends the app no event, nothing is answered | — | none |
| Added to space: a space is allowed before it is answered | spaces allowed in config; a stranger space is told its id | none |
| The agent stays silent | `text(answer)` gives `undefined`, nothing is sent | none |
| Attachments (Chat media and Drive): downloaded, bounded, read by the agent | images to the model; text files in the message; the rest named as not read | **`InboundMessage.images`** |
| Questions: confirm and select cards, dialogs with forms, button clicks back | phase 2 | **[approvals](approvals.md)** |
| Progress shown in "Thinking…" | not in phase 1 ([streaming replies](streaming-replies.md)) | none |
| A scheduled message's notification (a mention) | with the [scheduler](scheduler.md) | none yet |
| A quoted message as the reply's context | with `replyTo` ([rich content](rich-content.md)) | later |

## Decisions (phase 1)

**The component.** `channel-google-chat`, kind `channel`, both targets. Several Chat apps are
instances (`googlechat`, `googlechat:ops`), as channel-telegram's accounts are. It requires
`agent.runtime`, `conversations.registry`, `agent.submissions`, `storage.kv`, `secrets` and
`http.route`; on `durable` also `actor.mailbox`, `actor.inbox` and `wakeups`; `outbound.queue` when
installed.

**The app.** The assistant has a Chat app of its own, in its own Google Cloud project, never one
shared with another service: the app's endpoint is this channel's. It is built as a Google Workspace
add-on that extends Chat, the Chat API console's default. Its events are add-on event objects
(`chat.messagePayload`, `chat.addedToSpacePayload`, `chat.removedFromSpacePayload`,
`chat.buttonClickedPayload`), and its token is always an ID token for the endpoint URL from the
project's own service account, so both `aud` and `email` name this app. A Chat app that is not an
add-on is not supported: its own `Event` format and other tokens (a shared
`chat@system.gserviceaccount.com` sender, or a JWT for the project number) would be a second
ingress for nothing a user sees.

**Ingress.**
- `POST <path>`, an `http.route`, the endpoint URL of every trigger. Google's bearer token is
  verified before anything else; a failure answers `401`. It is an OpenID Connect ID token signed by
  Google (RS256), checked with WebCrypto, not with `googleapis` or `google-auth-library`, which do
  not run in a Worker:
  - the signature, against the JWKs at the `jwks_uri` of Google's OpenID discovery document
    (`https://www.googleapis.com/oauth2/v3/certs` today), cached as their `Cache-Control` says;
  - `iss` is `https://accounts.google.com` or `accounts.google.com`;
  - `aud` is the endpoint URL exactly as configured in the Chat API (a value);
  - `email` is the app's service account,
    `service-<project number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`, and `email_verified`
    is true;
  - `exp` has not passed.
- On `durable` the Worker hands the event to the conversation's object with
  `actor.mailbox.send(key, "google-chat.event", event)`, as channel-telegram-webhook hands
  `telegram.update`; the object admits it.
- The webhook is acknowledged once the message is admitted (P5), with `{}`, an empty JSON object:
  the answer goes by the REST API. Everything before admission (downloads included) fits in
  Google's 30-second window; download limits and timeouts are values.

**Identity and deduplication.**
- `InboundMessage.id` is the Google message's `name` (`spaces/AAA/messages/BBB`). Google sends a
  Chat app no event when a message is edited or deleted (only Workspace Events API subscriptions
  see those, through Pub/Sub), so an edit is not answered.
- No [inbound dedup](inbound-dedup.md): Google may deliver an event again after a timeout or a
  non-2xx answer; the redelivered event has the same `name`, the runtime answers `duplicate`,
  nothing runs, and the channel acknowledges. Before admission the channel only reads and
  downloads; nothing it sends to the space depends on a message being new.
- `actor.id` is the sender's `users/<id>` (stable; the email may be absent). In a space shared by
  several people, the message's text says who wrote it (their display name), so the agent knows who
  is talking; trusted identity stays in `actor` (`RUN_REQUESTS`).

**Conversations and routing.**
- `InboundMessage.conversationId` is the space (`spaces/AAA`): what `router-rules` matches, so an agent
  per space is one rule and needs no `thread` field.
- The key is the channel's own (`AdmitOptions.key`, [conversation routing](conversation-routing.md)):
  `googlechat:spaces/AAA:threads/BBB` when the space's threads are conversations,
  `googlechat:spaces/AAA` when the whole space is one.
- The shape comes from the space, never from thread names. In a space (`spaceType` `SPACE`) whose
  `spaceThreadingState` is `THREADED_MESSAGES` or `GROUPED_MESSAGES`, each thread is a
  conversation. A DM, a group chat and an `UNTHREADED_MESSAGES` space are one conversation each:
  DMs and group chats have inline threads too, and Google does not document the thread a DM's
  messages carry, so going by threads there could make each message a new conversation.
  `threads: "space"` per space in the channel's config makes a threaded space one conversation.
  The space's type and threading state come from the event's `space`, or from `spaces.get` when it
  lacks them, kept in the channel's `storage.kv`.
- In a space, an answer goes to its thread (`messageReplyOption: REPLY_MESSAGE_OR_FAIL`): the key
  holds it, or, for a threaded space made one conversation, the thread of the message it answers,
  kept in `storage.kv`. In a DM, a group chat or an unthreaded space the answer is sent without a
  thread: Google supports `messageReplyOption` only in named spaces.

**Access.** Spaces are allowed in the channel's config. A space not allowed is a stranger: when the
app is added to it (`chat.addedToSpacePayload`), and on each message from it, the app answers once
that it is not allowed there and gives the space's id for the operator (as channel-telegram-webhook
tells a stranger their id), and admits nothing. Approving a space from the chat or the dashboard is
[pairing](pairing.md).
Removal from a space is logged; answers still owed to that space fail `permanent`. `/new` resets
the conversation, as in channel-telegram.

**"Thinking…" edited into the answer.**
- On `agent.started` for a conversation of the channel (`route(key)`), and not for a dashboard request
  (`isDashboardRequest`), the channel creates the placeholder where the answer goes, with Google's
  `requestId` derived from `answerKey(conversation, requestId)`: a resumed run (`resumed: true`)
  sends the same request, and Google returns the placeholder it created the first time, with its
  name. The placeholder's message name is kept in the channel's `storage.kv` under the answer's key.
  Its text is a value (`thinkingText`).
- The transport's `send` for piece `#0` of that answer edits the placeholder (a PATCH: repeating it is
  harmless) instead of creating a message; the other pieces are created after it. Messages queued
  behind a run get no placeholder of their own: the next run's `agent.started` names the first of them.
- A run with nothing to send (aborted, an empty answer) deletes its placeholder on `agent.settled`;
  a failed run's placeholder becomes the channel's failure text (`text(answer)`). A crash between the
  two leaves a mark: at start, the channel deletes the placeholders whose request is settled
  (`agent.submissions.get`) with nothing left to send.

**Answers.**
- `startAnswerDelivery` in `start`, with the channel's transport, `route`, `text` and `policy`
  ([answer delivery](completed/outbound-delivery.md)).
- `split` cuts on a paragraph or line, never inside a table or a code block, so that a piece's
  message as JSON (its text and cards) stays under 32,000 bytes, Google's limit for a message; the
  bound is a value below it. Google documents no limit of characters for `text`.
  `send` turns each piece's markdown into Google Chat's text format, tables and code blocks into
  `cardsV2`, and markdown images with a public URL into image cards.
- The transport is `idempotent`: each create carries a `requestId` derived from the piece's key, a
  UUID made from its SHA-256 hash, so the same key always gives the same id. Google documents
  neither the characters nor the length a `requestId` may have, only that a random UUID is
  recommended, and the keys hold `:`, `/` and `#`. A repeat must be identical and come from the same
  service account; it returns the first message, not a new one.
- Failures: `429` is `rate_limited` (with `Retry-After` when given; Google allows one message write
  a second in a space, shared by every app in it, and asks for exponential backoff), network errors
  and `5xx` are `transient` (`maybeSent` after a timeout), `400`, `403` and `404` are `permanent`
  (the app removed, the space gone).
- The REST API is called as a service account: its JSON key from `secrets`, an access token from a
  signed JWT (RS256, WebCrypto) for the `chat.bot` scope (`drive.readonly` too, for Drive files), kept
  in memory until it expires.

**Attachments in.**
- Chat media (`attachmentDataRef`, the `media.download` API) and Drive files (`driveDataRef`, the
  Drive API) are downloaded before admission, bounded by values: how many per message, bytes each,
  bytes in all (on Cloudflare 1 MB of images in all, `AgentRequest.images`).
- Images (`image/png`, `image/jpeg`, `image/webp`, `image/gif`) go to the model as
  `InboundMessage.images`. Text files (`text/*`, JSON, CSV) are appended to the message's text,
  bounded. Any other file (PDF, Office) is named in the text as not read, with why, until files reach
  the workspace ([rich content](rich-content.md)). A Drive file the service account cannot read is
  told the same way.

## The contract change of phase 1: `InboundMessage.images`

`AgentRequest.images` exists, but its only producer is the dashboard: `admitInbound` builds the
request from the `InboundMessage`, which has no images, so no channel can give the model a photo. No
component can add that from outside: `admitInbound` is the kit's code. So:

- `InboundMessage.images?: readonly AgentImage[]`, optional, added with this channel, its first
  producer (`inbound.ts`: "a field is added, optional, with the component that produces it").
- `admitInbound` passes them to `dispatch` as `AgentRequest.images`. An `inbound.normalize` stage may
  read them and keep or drop them (a filter); `id`, `channel` and `conversationId` stay as they are.
- Whoever builds the message bounds them (the channel's values), as `AgentRequest.images` says.
- A test of `admitInbound` shows they reach the request, and `docs/contracts.md`, SPEC and the
  [rich content](rich-content.md) note say it in the same change (the contract rules of `AGENTS.md`).

Generic attachments (`InboundMessage.attachments`, `storage.blob`, files in the workspace) stay
[rich content](rich-content.md)'s, for when a file must be kept rather than read once.

## Phase 2: questions in cards and dialogs

A question is drawn as a confirm card, an inline select card, or a card whose button opens a dialog
with a form, and the answer comes back as a button click (`chat.buttonClickedPayload`). Here that
is the [approvals](approvals.md) contract, because three parties that must not know each other meet in
it: who asks (`askUser`, a Pi extension, a decision), who draws (each channel), and who waits for the
answer (the run, durably, with a deadline). What is asked is shared vocabulary, so it belongs
in `@pikit/contracts`; how it is drawn is each channel's (`draws`), and a channel that draws nothing
sends the question as text, whose answer comes back as an ordinary message.

Phase 2 starts by settling approvals' open questions: Pi's `select`, `confirm` and `input`, or a
form of several fields (`select`, `multiselect`, `text`, `confirm`, `date`); the deadline; and how a
durable run waits. Then this channel draws them (cards, dialogs) and turns the click into the
answer.

## Tests
- `createChannelConformance` (`@pikit/contracts/testing`), and `createLifecycleConformance`.
- The transport against a fake Google Chat API (a `fetch` double): pieces, cards, the placeholder
  edited, each failure classified.
- The ID token checked with a test key pair: a wrong audience, issuer, email or signature, and an
  expired token, refused with `401`.
- The placeholder's life: started, resumed (no second one), aborted (deleted), failed (the failure
  text), a crash in between (swept at start).
- Attachments: images reach `AgentRequest.images`, text files the text, others named; every bound.
- The `durable` lane in workerd: the Worker verifies, the object admits and answers.

## Pi first
Nothing in Pi: channels are pikit's (SPEC P1). The images are Pi's `ImageContent`, as
`AgentRequest.images` already are.

## Open questions
- Threads in DMs and group chats, to check live (Google's documentation does not say): the
  `spaceThreadingState` they report, whether the event's `space` carries `spaceType` and
  `spaceThreadingState`, and the `thread` of a message replied inline in a DM, and whether the app
  can answer in it.
- How long Google remembers a `requestId`: its documentation gives no window. A run resumed after
  it would post a second placeholder, a retried piece a second message. Check a repeat after an
  hour and after a day.
- Drive attachments: whether the service account can read a Drive file shared in a space. Google's
  documentation only says to use the Drive API; until checked, an unreadable file is named as not
  read.
- Workspace (domain) restrictions as sender authorization: the sender's email domain, when Google
  gives it.
- PDFs and Office files read as text before files reach the workspace: in the channel, or a stage
  once attachments exist.

## Moved from the former SPEC
The former SPEC §18, "Higher-level components":

| Component | What it encodes |
|---|---|
| `channel-google-chat` | Google Chat app: JWT-verified webhook ingress, REST transport with message create/patch, cards, threads, media. |

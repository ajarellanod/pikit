# Conversation routing: where an answer goes, apart from the key

**Public appeal:** —

**Specified:** decided (below): a conversation is one chat of one channel, and its key is its
channel's, never rewritten. The address proposal that follows is kept for reference only, for the
day that decision changes; it is not to be built. From the architecture audit's finding 6.

**Needed by:** nothing. A new channel builds and reads its own keys, as Telegram's do.

## Decision
- **A conversation belongs to one chat of one channel, for good.** Two chats, or the same person on
  two channels (Telegram and WhatsApp), are two conversations with two sessions; they are never
  merged. What a person shares across channels is the agent's [memory](memory.md) of them, per
  person, not a conversation.
- **The key is its channel's own, and nothing rewrites it.** The channel builds it and alone reads it
  back (`account.ts:11`). Whatever must be in it, the channel puts there itself: a tenant in the
  channel's instance (`telegram:acme:12345`, [multi-tenant isolation](multi-tenant-isolation.md)), a
  thread in the channel's own format ([threads](threads.md)).
- **So answers keep finding their chat by the key**, and the proposal below is not needed: no
  component changes a key, Cloudflare's owner stays `idFromName` of the channel's key (C1, C2), and
  `conversation.resolve` is not planned ([pipeline anchors](pipeline-anchors.md)).
- **An answer no channel claims is logged, never dropped in silence (P5).** Today every channel
  passes over it (below, "What goes wrong"). How it is detected (each channel declaring the instances
  whose keys it reads, or the address) is decided with the next channel; the runtime's log is the
  minimum, `pikit doctor` and the dashboard may say it later.

*The rest of this file is the proposal as written before the decision, kept as the reference for
changing it.*

## What it gives
An answer reaches the chat it answers even when the conversation's key is not the one its channel
built: a tenant prefix, a conversation chosen by a stage, a scheduled prompt in a chat's
conversation. Channels stop parsing keys to find a chat, and the key becomes what its contract now
says it is: an opaque identity (`packages/contracts/src/agent.ts:41-47`).

## How it fits pikit

### Today
- **The channel builds the key and hands it to the inbound path.** `AdmitOptions.key`
  (`packages/contracts/src/inbound.ts:84-85`) goes straight to `conversations.resolve`
  (`inbound.ts:119`); no field of `InboundMessage` feeds it. Telegram's is `<instance>:<chat id>`
  (`registry/components/channel-telegram/files/src/pikit/channel-telegram/account.ts:11,43`), HTTP's
  `http:<id>` (`registry/components/channel-http/files/src/pikit/channel-http/index.ts:80`).
- **Only its channel reads it back, on purpose** ("Only this channel reads its keys back",
  `channel-telegram/account.ts:11`; `OutboundMessage.conversationKey`, "only the channel that made the
  key reads it", `packages/contracts/src/outbound.ts:40-41`). The same `InboundMessage` already carries
  what the key encodes, as fields: `channel` is the instance (`inbound.ts:34-35`; Telegram sets
  `channel: deps.instance`, `channel-telegram/inbound.ts:88`) and `conversationId` the platform's
  conversation (`inbound.ts:36-37`, `channel-telegram/inbound.ts:89`). `admitInbound` already forbids
  a stage to change them (`inbound.ts:104-109`).
- **Where Telegram parses a key** (`chatIn`, `channel-telegram/account.ts:45-50`):
  - answers: `ours` and `find` (`channel-telegram/index.ts:87-96`), `deliver` skips a key it cannot
    parse (`index.ts:104-105`), typing (`index.ts:123-125`); the webhook's object half does the same
    through `findBot` (`channel-telegram-webhook/bot.ts:39-41`; `delivery.ts:153,199,251`,
    `index.ts:118`);
  - outbound: both transports parse `OutboundPiece.conversationKey`
    (`channel-telegram/transport.ts:32`, `channel-telegram-webhook/transport.ts:33`), which the
    channel fills with `answer.conversation.key` (`channel-telegram/index.ts:118`,
    `channel-telegram-webhook/delivery.ts:160,176`);
  - the actor: the Worker half sends each update to `conversationKeyOf(instance, chat)`
    (`channel-telegram-webhook/worker.ts:156`), and the object half refuses a key that is not one of
    its chats (`channel-telegram-webhook/index.ts:88-97`).
- **Where a channel rebuilds a key without a message to admit**: `/new` resets
  `conversationKeyOf(...)` (`channel-telegram/inbound.ts:81`, `channel-telegram-webhook/inbox.ts:53,64`);
  channel-http's `GET` and `reset` routes rebuild `conversationKey(id)` (`channel-http/index.ts:206,218`).
- **Where the key is used opaquely** (no change needed): the registries' maps
  (`conversations-kv/index.ts:63`, `conversations-file/index.ts:57`), the answer lanes
  (`channel-telegram/answers.ts:178`), the outbox's per-conversation order
  (`outbound-durable/queue.ts:164`), log fields (`log-events/fields.ts:15-16`), the answers log's rows
  (`packages/pi-adapter/src/answers.ts`). channel-http matches its answers by session and request, not by
  key (`channel-http/index.ts:164`).
- **What goes wrong if a key is rewritten.** Every channel passes over settlements that are not its
  own, as it must, because the `answers` feed is shared (`channel-telegram/index.ts:104-105`,
  `channel-telegram-webhook/delivery.ts:155`); a skipped settlement counts as handled and the cursor
  moves past it (`channel-telegram/answers.ts:182`, `channel-telegram-webhook/delivery.ts:230`). A
  rewritten key that its channel cannot parse is therefore skipped by every channel, with no error: the
  message is never answered and nothing says so, against P5 (`SPEC.md:34`). `/new` would reset a key
  that has no conversation (`channel-telegram/inbound.ts:81-82` answers "This is already a new
  conversation."). Nothing rewrites keys today.

### The proposal
1. **The key is opaque**, as its contract now says (`agent.ts:41-47`): the registry, the runtime, the
   feeds and the outbox store, compare and log it; only its channel may read it, and the channels
   stop needing to.
2. **A conversation records where its answers go**, as two fields the inbound path already has. In
   `@pikit/contracts` (`agent.ts`), additive and optional:

   ```ts
   /** Where a conversation's answers go, as its channel admitted its first message. */
   export interface ConversationAddress {
     /** `InboundMessage.channel`: the channel instance (`telegram`, `telegram:ops`, `http`). */
     channel: string;
     /** `InboundMessage.conversationId`: the platform's conversation (a chat id). */
     conversationId: string;
   }
   export interface ConversationRef { key: string; agent: string; conversationId: string; address?: ConversationAddress }
   ```

   (`ConversationRef.conversationId` is the pi-durable conversation, renamed from `sessionId` with
   the [move to pi-durable](pi-durable-migration.md); the address's `conversationId` is the
   platform's, as on `InboundMessage`.)

   `RunSettlement`, `SubmissionStatus` and `PendingConversation` carry a `ConversationRef`
   (`submissions.ts:39,42,47`), so they carry the address with no change of their own. A thread adds
   `threadId?` to it with [threads](threads.md).
3. **Set at admission, kept in the pointer.** `admitInbound` passes
   `{ channel, conversationId }` of the normalized message (`inbound.ts:119`) to
   `ConversationRegistry.resolve(key, agent, ctx, address?)`, a trailing optional parameter
   (`conversations.ts:20`). A registry records it in the pointer with the first resolve, fills it into
   a pointer that has none (one write, in the key's line: `conversations-kv/index.ts:66`), never
   changes it otherwise, keeps it across a reset (`...previous`, `conversations-kv/index.ts:129`), and
   returns it from `resolve`, `get` and `reset`. The pointer's schema gains
   `address: Type.Optional(...)` (`conversations-kv/index.ts:43`, `conversations-file/index.ts:35`).
   A pointer is never deleted (`conversations.ts:7`), so whoever holds only a key (a scheduler, an
   admin action) finds where the conversation answers with `get`.
4. **Carried by the runtime and the submissions.** The runtime passes the `ConversationRef` it is given
   through to its events and `CONVERSATION` (`packages/pi-adapter/src/conversation.ts:106,397`). Two
   places copy it field by field and would drop the address: `settlementOf`
   (`packages/pi-adapter/src/result.ts:42`) and the answers log's `settlementOf`
   (`packages/pi-adapter/src/answers.ts`), whose rows keep key, agent and conversation in columns.
   The log gains two nullable columns, and `pending` reads the address from the conversation's
   `pikit.conversation` document, so a run resumed at start (`runtime-pi/resume.ts`, from `pending`)
   still has its address.
5. **Channels match answers on the address.** An answer is the channel's when
   `conversation.address?.channel` is one of its instances; the chat is `address.conversationId`. When
   there is no address (a settlement, pointer or pending row written before), the channel falls back to
   parsing the key as today (`chatIn`). The channel enqueues `conversationKey:
   conversationKeyOf(instance, chat)`, its own address of the chat, instead of `ConversationRef.key`
   (`channel-telegram/index.ts:118`): `OutboundMessage.conversationKey` is already the channel's to
   read (`outbound.ts:40-41`), so the transports and the outbox do not change, and the outbox still
   orders each chat's pieces (`queue.ts:164`).
6. **One address per conversation.** A later message whose address differs from the recorded one
   (only possible once something maps several platform conversations to one key) keeps the recorded
   address, and the registry logs it. A scheduled prompt into a Telegram conversation
   ([scheduler](scheduler.md): "a job reaches an agent through `admitInbound`") is exactly that case, and
   its answer then goes to the chat, which is what the scheduler wants, as long as a chat's message
   created the conversation: one a job created first records the job's address, which no chat channel
   claims. Answering each message where it
   came from is alternative B.

### Tenant and `conversation.resolve`, on a server
- `conversation.resolve` runs in `admitInbound` between `route.resolve` and the registry
  (`pipeline-anchors.md:18`) and may return another key. The address is taken from the message, not
  from the key, so the answer still reaches its chat whatever key the stage chose.
- A tenant is set on the message (`InboundMessage.tenant`, `multi-tenant-isolation.md`) by a stage or
  the channel, and a `conversation.resolve` stage of the tenant component puts it in the key. Storage
  per tenant is that feature's business.
- The channels' commands rebuild the key without a message to admit (`/new`, HTTP's `GET` and
  `reset`, above). They must reach the same conversation, so the key resolution cannot live only
  inside `admitInbound`: `@pikit/contracts` exports it as a function of the message and the channel's
  key (`resolveConversationKey(ctx, message, key)`, running `conversation.resolve`), which
  `admitInbound` and the commands both call. The stage then cannot depend on the route decision, which
  a command does not have (an open question below).

### Tenant and `conversation.resolve`, on Cloudflare
- **The owner is chosen before any pipeline runs.** The Worker half sends the update to the actor
  named by the channel's key (`channel-telegram-webhook/worker.ts:156`), which is the Durable Object
  `idFromName(key)` (`platform-cloudflare/index.ts:361`, SPEC C2 at `SPEC.md:185`); `admitInbound` runs
  in that object (`channel-telegram-webhook/inbox.ts:85`), and each object keeps its own pointers
  (`features/cloudflare-conversation-index.md:17`).
- **Renaming keeps one owner, but not C2's address; merging keeps neither.** A stage that maps each
  channel key to one key of its own (a tenant prefix of a chat that belongs to one tenant) keeps one
  owner: the only object that ever sees the new key is the one the channel key named. But that object
  is `idFromName` of the channel's key, not of the conversation's, so whatever reaches the
  conversation by its own key through `actor.mailbox` (a scheduler fanning out to Durable Objects,
  [scheduler](scheduler.md); an admin action on a key the [conversation index](cloudflare-conversation-index.md)
  lists) gets `idFromName` of that key (`platform-cloudflare/index.ts:361`): another, empty object,
  against C2's "the actor owning `key`" (`SPEC.md:185-191`). A stage that maps two channel keys to one
  key (two chats, or two channels, into one conversation) would create that conversation in two
  objects, each with its own pointer and session: two owners, against C1 (`SPEC.md:164,176`).
- **So any key the stage changes needs the message at `idFromName` of the resolved key**, one of:
  - **(F) Forward from the object** (recommended to try first). The object half resolves the key; when
    it is not the key it was delivered under (the handler gets that key,
    `channel-telegram-webhook/index.ts:88`), it forwards the message with `actor.mailbox` to the owner
    (an object may send to another, `platform-cloudflare/index.ts:26-28`) and resolves when the owner
    holds it, so the channel still acknowledges only once the conversation has the message
    (`packages/contracts/src/actor.ts:16-18`). The owner delivers the answer from its own feed, with its
    own half of the channel, to a chat whose key it never made: that is what the address makes
    possible. Costs: one more subrequest per forwarded message (C4, 50 per invocation, `SPEC.md:209`),
    a generic "admit this message" inbox type instead of the channel's own, and a rule that resolving an
    already resolved key returns it unchanged, or messages bounce.
  - **(W) Resolve in the Worker.** The Worker half computes the resolved key before
    `mailbox.send`. The Worker holds no pointers, so only a stateless mapping works there (or a global
    store, `features/cloudflare-conversation-index.md:19`, a subrequest per message), and every
    channel's Worker half changes at `worker.ts:156`.
- **A tenant's namespace.** Separate Durable Object namespaces per tenant
  (`multi-tenant-isolation.md:22`) are chosen by the mailbox, which today has one `binding`
  (`platform-cloudflare/index.ts:53`) and whose `send(key, type, message, ctx)` has no tenant. A
  context key would carry it without changing the interface (K5, `SPEC.md:70`; the kernel's own test
  uses a `TENANT` key, `packages/core/src/app.test.ts:856`). Whether that is still C2's "the object
  `idFromName(key)`" is an open question.

### Migration of existing channels
- **No key changes.** Keys stay what the channels build, so pointers, sessions, submissions rows,
  outbox rows and the channels' cursors keep matching: nothing is rewritten in storage.
- **Each step deploys alone**, because every reader falls back to the key: contracts (the optional
  field and parameter) → `admitInbound` passes the address → the registries record it → the adapter's
  `settlementOf` copies it → the answers log's columns → the channels read it. A registry that
  ignores the new parameter still satisfies the interface (a function with fewer parameters is
  assignable), so a user's edited copy of `conversations-kv` keeps compiling and behaves as today.
- **channel-telegram and channel-telegram-webhook**: `find`/`ours`/`findBot` read the address first
  and fall back to `chatIn`; `conversationKey` on the outbox is the channel's own. The fallback stays
  at least as long as a settlement without an address can be read: settlements live for the
  provider's retention (`submissions.ts:28`), and pending rows resume with what they stored.
  `worker.ts:156` and the inbox's key check (`channel-telegram-webhook/index.ts:91-97`) do not change
  until (F) or (W) is built.
- **channel-http**: its answers already match by session and request (`channel-http/index.ts:164`);
  only its `GET` and `reset` routes move to `resolveConversationKey` when `conversation.resolve` lands.
- **New channels** read the address from the start and never parse a key.
- **Users' copies (P6).** An edited, not upgraded channel keeps working as long as nothing rewrites
  keys. A component that rewrites keys needs channels that read the address, and nothing today records
  what a component needs of the others' versions: an open question below.

## Alternatives
- **A. Keep the key as the route, with a rule: a rewrite keeps the channel's key as it is and only
  wraps it.** No contract change. But the rule is enforced by nothing, and `chatIn` accepts only digits
  after the instance (`account.ts:49`), so a tenant cannot even be appended without every channel's
  parser changing; merging conversations stays impossible, and each new channel writes its own parser.
- **B. An address per request, not per conversation.** `agent.submissions.admitted` records the
  address with each request, and a settlement answers each of its `requestIds` (`agent.ts:184`) where
  it came from. It makes one conversation fed by several chats possible, which the decision above
  rules out (a person's continuity across channels is [memory](memory.md)'s). But a run answers several requests at once, possibly from different chats, so a channel
  must fan out one answer; the event path (channels without `agent.submissions`) has no record to
  read; and it is a larger change to the submissions contract, which Pi's durable runtime is expected to
  take over (`submissions.ts:13-19`). The proposal's per-conversation address does not prevent it
  later: B adds a field, it removes none.
- **C. A grammar owned by the contracts** (what `agent.ts` used to document: `tenant:channel:id[:thread]`,
  with a parser and a formatter in `@pikit/contracts`). One parser instead of one per channel, but the
  contracts become responsible for escaping every platform's ids, every key changes format (a data
  migration of pointers and sessions), and it reverses the decision that only the channel reads its keys
  (`account.ts:11`).
- **D. Look the address up at delivery** (`conversations.get(key)` for each answer) instead of carrying
  it on the settlement. No change to the runtime or submissions, but a registry read per answer, and a
  channel whose settlement names a key of another object's registry (Cloudflare) cannot read it there.
- **E. Each channel keeps its own map from key to chat** in `storage.kv`. No contract change, but it
  duplicates the pointer in every channel, and a key rewritten after admission is unknown to it.

## Pi first
Nothing in Pi: a Pi session knows no channels. Pi's durable runtime keeps submissions by request id
(`submissions.ts:13-19`); whether its `Submission` can carry caller metadata (which would hold B's
per-request address) is to check before B is built.

## Open questions
Settled by the decision above: the registry's signature, what `conversation.resolve` receives, and
(F) or (W) on Cloudflare (nothing rewrites a key, so none arises); and how a key-rewriting component
would require channels that read the address (there is none). If the decision is ever revisited:
`resolve(key, { agent, address }, ctx)` rather than a trailing parameter (pikit is unreleased, and the
contracts are 0.x, K8), and `conversation.resolve` taking only the message and the key, so the
channels' commands (`/new`, HTTP's `GET` and `reset`) resolve the same key.

Still open:
- How an answer no channel claims is detected and reported (the decision's last point).

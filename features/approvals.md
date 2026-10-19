# Approvals: questions to a person, answered in the chat

**Public appeal:** ⭐ The agent asks a person before a risky action and waits for the answer in the
chat. Hermes has command approval; OpenClaw approves requests from the chat or its CLI.

**Specified:** partly (moved from the former SPEC §18, whose §4.5 named the `approvals` capability,
and from the former SPEC §6.2b, the questions from extensions, which was the `interaction` note and is
merged here: both sections are kept below verbatim). **Built:** approvals of exact actions (below),
on a server.

**Needed by:** nothing required directly. Self-improvement needs a human's approval of every
self-change (SPEC §6); whether that approval is this component or the git host's review is open
below. The dashboard answers approvals only when this exists (SPEC §5).
[Google Chat](channel-google-chat.md) brings its first part: the tool `askUser`, which ends its run
with a `question` part instead of waiting (declared in `@pikit/contracts`' `question.ts`, the
shared vocabulary below), drawn as cards and dialogs, its answer a new message that says it in its text. What stays here: Pi's extensions' questions (pi-durable has no UI API yet) and
decisions that wait days.

## Built: approvals of exact actions
A tool with effects runs only once a person the configuration names approved that exact call, and the
approval is recorded by code, never by the model reading "approved". Three components:

| Component | Provides | Uses | What it is |
|---|---|---|---|
| `approvals-sql` | `approvals` (declared: kind and capability) | `storage.sql`, `actor.mailbox`, `actor.inbox` | the store, its `contract.ts` and its suite (`conformance.ts`) |
| `extension-approvals` | `agent.extension` `approvals`, an `inbound.normalize` stage | `approvals` | `request_approval`, the `beforeTool` claim, the answer recorded |
| `admin-approvals` | `http.route` | `approvals`, `agent.runtime`, `admin.auth`? | `/admin/api/approvals`: list, decide as `dashboard:<operator>` |

- **The contract** (`ApprovalStore`, approvals-sql's `contract.ts`, an identical copy in each user;
  [docs/contracts.md](../docs/contracts.md), "A registry's own contracts"): an approval is one
  immutable action `{ type, payload }` with its hash (canonical JSON, SHA-256), idempotent by key;
  decided once by a `Sender` matching the proposer's `approvers` (`<channel>:<id>`, `<channel>:*`),
  `forbidden` otherwise; expired when read past `expiresAt`; claimed at most once, from the
  conversation that asked, by one claimant (the same claimant again gets it back).
- **The ask** is a `question` part (`approval:<id>`, one `confirm` field), like `askUser`'s: the run
  ends with it, and the answer is a message in `answerText`'s words. Google Chat's buttons write it;
  elsewhere the fallback says the two lines to send. The stage reads it before the model and decides
  as the channel authenticated the sender; who may decide is the store's check.
- **The gate** is `beforeTool`: the call's hash (name and arguments as they run) is claimed for that
  tool task; pi-durable runs the hook again when a task recovers before its intent is committed, and
  the same claimant gets the same approval. `afterTool` settles it.
- **One owner**: the actor `approvals-sql:approvals`, so the same code reaches one Durable Object on
  Cloudflare; not tested there, so the targets are `server`.

Decided while building: `decide` takes no action hash (the action of an id never changes, so a
`moved` outcome could never happen); there is no `get` (nothing reads one approval alone yet); the
claim is scoped to the asking conversation, so one person's approval is never another
conversation's; `settle` is by claimant (the hook's `afterTool` sees the call's original arguments,
not the ones that ran).

Still open, besides the questions below: Cloudflare (a workerd run, and admin routes in the Worker's
App, which has no `storage.sql`); a dashboard view; reminders, escalation and approval by rule or
after a veto window (components on this contract); Pi extensions' `ctx.ui` questions; an approval
claimed by a call that then fails to run (another hook blocks it, a crash after intent) stays
`claimed`; channel-google-chat takes the first answer of anyone it admits, so a stranger's click
spends the card's buttons (the approver then answers in text).

## What it gives
Something the agent cannot decide alone ("allow this `rm -rf`?", "which of these three?", "approve
this spend?") goes to a person where they can answer it, with buttons, a select, a form or plain text,
and the work resumes with the answer, a minute or days later, across restarts and deploys. Three kinds
of asker, one mechanism:

- **`askUser`**, a tool: the agent asks what it needs to go on.
- **Pi's extensions** asking their user (`ctx.ui.select` / `confirm` / `input`, Pi's
  `permission-gate`), answered from the chat, unmodified.
- **Decisions** with a lifecycle: proposed → approved/rejected → executed → verified, with reminders,
  escalation when it stalls, and expiry; approval by rule, or after a veto window, is a component's
  policy.

## Decisions
- **One contract, `approvals`.** A question answered now and a decision answered in days differ only
  in their deadline, a value of each question. The split into `interaction` (an answer now) and
  `approvals` (days) came from runs that waited in the worker's memory and died with it. On pi-durable a
  run waits durably (its tasks, `sleep(until)`, below), and on Cloudflare a wait in memory does not
  survive an evicted Durable Object, so every question waits the same durable way.
- **Not `proposals`.** `proposals` (SPEC §6, `packages/contracts/src/proposals.ts`) is the agent's
  change to itself: a branch an operator reviews in the dashboard or on the git host, deployed when
  approved. What is approved there is a diff, by an operator; here it is a question, by the person in
  the conversation (or a role), in the chat. Whether a self-change's approval is also an `approvals`
  decision is open below.
- **What is asked is shared vocabulary, in `@pikit/contracts`.** Who asks, who draws the question and
  who waits for the answer are components that must not know each other, and the question travels in
  the kit's delivery. A question carries a `fallback` text; a channel draws what it can (`draws`,
  [rich content](rich-content.md)) and sends the rest as text, and a text answer comes back as an
  ordinary message.
- **The askers are components on it**: a tool `askUser`, the adapter's `ui` for Pi's extensions, and
  decision components with their policy. Absent, nothing waits for a person: there is no `askUser`,
  extensions keep a no-op UI (`hasUI: false`), and `permission-gate` blocks.

## How it fits pikit
- Capability `approvals` (`ApprovalStore`), with its suite, declared by its provider `approvals-sql`
  on `storage.sql` (built, above); the kind `approvals` is declared by it too, not the kit's. On
  Cloudflare the same actor would be a Durable Object; whether reminders need Workflows (which the
  former SPEC §9.2 named for "anything that waits > 15 min": an alarm gets 15 minutes of wall clock,
  C4) or the object's `wakeups` is to decide.
- With `approvals` installed, the adapter gives extensions `hasUI: true` and a `ui` backed by it.
- It binds a question to the message that carries it by reading `outbound.queue`'s `receipts` feed
  and `answerKey` (`Feed`, SPEC K3; `packages/contracts/src/outbound.ts`). The answer comes back as
  an `InboundMessage` with `replyTo` to the question's part ([rich content](rich-content.md)).
- A tool that waits for an answer is `replay: "never"`, and the question is keyed by
  `${conversationId}:${runId}:${toolCallId}`.

## Pi first
Pi's durable runtime has durable tasks with phases, waits (`sleep(until)`), memos and an abort
protocol (`pico-v5.md` §5): a run can wait days for an answer with no task engine in pikit. pikit
builds only the surface (where the question goes, how the answer comes back) and the record of
questions across conversations. `pi-durable` 1.0 ships these tasks, and the kit runs on it
(`features/completed/pi-durable-migration.md`, which leaves open how its tasks map onto approvals).

Pi's `ctx.ui.select` / `confirm` / `input` / `notify` are how an extension asks, and Pi's own RPC mode
already answers them from a client (`docs/rpc-extension-ui.md` of `pi-coding-agent`): pikit answers
that API from a chat and adds no question API of its own for extensions (`askUser` is the agent's, a
tool). The dashboard (SPEC §5) is another place to answer: RPC's dialog records
(`extension_ui_request` / `extension_ui_response`) are the shape to follow for its card, as for a
chat. Running unmodified Pi coding-agent extensions was dropped with the move to pi-durable: whether
pi-durable's own extensions have that API is to check.

## Open questions
- Is the approval of a self-change (SPEC §6) an `approvals` decision, or the git host's
  review, with the dashboard as its surface?
- Once Pi's durable tasks exist, do decisions stay in a pikit table, or become Pi's task records
  plus a cross-session index (as `agent.submissions` does for messages)?
- Who may answer: the conversation's actor, or a role ([policy tools](policy-tools.md),
  [pairing](pairing.md))?
- The vocabulary: Pi's `select`, `confirm` and `input`, or a form of several fields (`select`,
  `multiselect`, `text`, `confirm`, `date`), which Google Chat draws as cards and dialogs.
- What the run sees when a deadline passes (`undefined`, as with no UI).
- Several questions in flight in one conversation.

## Moved from the former SPEC
The former SPEC §18, "Higher-level components":

| Component | What it encodes |
|---|---|
| `approvals` | Deterministic decision lifecycle: proposed → approved/rejected → executed → verified, with retries, reminders, stalled escalation, TTL/abandonment, and **delivery-time binding** of a decision to the message/thread where a human can answer it (a decision created by a scheduled job cannot know its answer surface until the result is sent). It binds by reading `outbound.queue`'s receipts (§4.8, §5). |

The former SPEC §6.2b, verbatim (section numbers and S3 are the former SPEC's and ROADMAP's; §18 is
now `features/`). Its separate `interaction` capability and its wait in the worker's memory are
superseded by the decisions above:

**Questions from extensions, in the chat.** `[planned]` (tier B), with the first `interaction-*`
component. Pi's `ctx.ui.select` / `confirm` / `input` / `notify` are how an extension asks its user
something. pikit answers them in the conversation's chat rather than inventing an `askUser` of its
own, so an unmodified extension that asks (Pi's `permission-gate`) works from Telegram:

```ts
interface Interaction {           // capability `interaction`; runtime-pi uses it optionally
  ask(conversation: ConversationRef, question: Question, ctx: Context): Promise<string | undefined>;
  notify(conversation: ConversationRef, text: string, level: "info" | "warning" | "error", ctx: Context): Promise<void>;
}

type Question =
  | { kind: "select"; title: string; options: string[] }
  | { kind: "confirm"; title: string; message: string }
  | { kind: "input"; title: string; placeholder?: string };
```

- With `interaction` installed, the adapter gives extensions `hasUI: true` and a `ui` backed by it.
  Without it they get today's no-op UI (absence, S3), and `permission-gate` blocks as it does now.
- A question wants an answer now: the run waits for it, with a deadline, and the question waits in
  the worker's memory. If the process dies the run dies with it, and the resumed run asks again.
  An answer that may take days is not a question: it is a decision recorded by a component
  (`approvals`, §18) that resumes the work when the answer arrives.
- The question goes out as a message with a `choice` part, and the answer comes back with `replyTo`
  (§5, "Rich content").

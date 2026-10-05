# Interaction: questions from extensions, in the chat

**Public appeal:** —

**Specified:** specified (moved from the former SPEC §6.2b; tier B)

**Needed by:** nothing required.

**Note:** running unmodified Pi coding-agent extensions was dropped with the move to pi-durable,
whose own extensions will replace it. What follows is about those extensions and must be redone for
pi-durable's.

## What it gives
A Pi extension that asks its user something (Pi's `permission-gate`: "allow this `rm -rf`?") gets the
answer from the person in the conversation's chat, unmodified.

## How it fits pikit
- Capability `interaction`, used optionally by `runtime-pi`; provided by an `interaction-*`
  component (the kind `interaction` is new: a naming decision). The contract is below.
- The question goes out as a message with a `choice` part and the answer comes back with `replyTo`
  ([rich content](rich-content.md)).
- Absent: extensions keep a no-op UI (`hasUI: false`), and `permission-gate` blocks.
- An answer that may take days is not a question: it is [approvals](approvals.md).

## Pi first
Pi's `ctx.ui.select` / `confirm` / `input` / `notify` are the API, and Pi's own RPC mode already
answers them from a client (`docs/rpc-extension-ui.md` of `pi-coding-agent`). pikit adds no
`ask_user` tool of its own: it answers Pi's API from a chat. The dashboard (SPEC §5) is a second
place to answer it: RPC's dialog records (`extension_ui_request` / `extension_ui_response`) are the
shape to follow for its card, as they are for a chat.

## Open questions
- The deadline of a question, and what the run sees when it passes (`undefined`, as with no UI).
- Several questions in flight in one conversation.

## Moved from the former SPEC
The former SPEC §6.2b, verbatim (section numbers and S3 are the former SPEC's and ROADMAP's; §18 is
now `features/`):

**Questions from extensions, in the chat.** `[planned]` (tier B), with the first `interaction-*`
component. Pi's `ctx.ui.select` / `confirm` / `input` / `notify` are how an extension asks its user
something. pikit answers them in the conversation's chat rather than inventing an `ask_user` of its
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

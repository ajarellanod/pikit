# Rich content

**Public appeal:** ⭐ Send the agent a photo or a PDF, and get files, images and buttons back.
OpenClaw and Hermes both handle media in chats.

**Specified:** partly (the shape was decided in the former SPEC §5, "Rich content", kept below
verbatim; the code is not built)

**Needed by:** nothing required. [Interaction](interaction.md) and [approvals](approvals.md) draw
their questions as `choice` parts.

## What it gives
Images, files and buttons in both directions, on every channel: drawn where the platform can, as
text where it cannot.

## How it fits pikit
- The contract is the shape below: `OutboundMessage.parts` typed by declaration merging on
  `AppMessageParts`, a `fallback` text per part, `ChannelTransport.draws`, and
  `InboundMessage.replyTo`. What is not built:
  - the first part kinds (`choice`, `image`, `file`), each declared by the component that needs it;
  - `InboundMessage.attachments` and images in `AgentRequest`, added with the first producer
    (`packages/contracts/src/inbound.ts`: "adding one is compatible, removing one is not");
  - storage of media: bytes in `storage.blob` with a reference in the transcript (R2 on Cloudflare,
    where a SQL row is at most 2 MB, C7);
  - a tool that produces a file as a part of the answer.
- Absent: text only, as today; a part folds into its fallback.

## Pi first
Pi's messages carry images (`ImageContent`), and the model sees them. Inbound messages go to Pi as
`custom` messages, so images go inside `content`, since `steer()`'s `images` accepts only user
messages. pikit adds download and upload per platform, and storage. A PDF becomes a file in the workspace, for the agent's tools to read.

## Open questions
- Which component introduces `image` and `file` first, and their size limits.
- How long media is kept, and whether a `/reset` deletes it.
- [Voice](voice.md) notes are attachments too.

## Moved from the former SPEC
The former SPEC §5, verbatim (its code already has `OutboundMessage`, `ChannelTransport` and
`InboundMessage`, without these fields):

**Rich content.** `[decision]` for the shape; `[planned]` for the code, which arrives with the first
component that produces a part (the first channel that draws cards, or the first `interaction-*`,
`features/interaction.md`), since a field is added with its producer. Not a field per platform
feature (`blocks`, `buttons`, `attachments`…), and not an opaque `blocks: unknown`:

```ts
// Declared by the component that introduces a kind of part, as events are (§4.3):
declare module "@pikit/contracts" {
  interface AppMessageParts {
    choice: { prompt: string; options: { id: string; label: string }[] };
  }
}

type MessagePart = {
  [K in keyof AppMessageParts]: { type: K; fallback: string } & AppMessageParts[K];
}[keyof AppMessageParts];

interface OutboundMessage { /* … */ parts?: readonly MessagePart[] }
interface ChannelTransport { /* … */ readonly draws?: readonly string[] }   // the part types it draws
interface InboundMessage { /* … */ replyTo?: { platformMessageId: string; value?: string } }
```

- Every part carries a `fallback` text. A transport draws the types it lists in `draws`; every other
  part is folded into the text as its fallback before the text is split. A message never needs a
  channel that supports it, and no flag says which channels do (S3).
- The core declares no part type. The component that needs one declares it; without that component
  the type does not exist.
- An answer to a drawn part (a button pressed, a quoted reply) arrives as an `InboundMessage` with
  `replyTo`. The receipt of the message it answers (above) says which run sent it.
- What is not built yet (the first part kinds, attachments, media storage) is a feature:
  `features/rich-content.md`.

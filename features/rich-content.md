# Rich content

**Public appeal:** ⭐ Send the agent a photo or a PDF, and get files, images and buttons back.
OpenClaw and Hermes both handle media in chats.

**Specified:** partly (the shape is decided in SPEC §5, "Rich content", and stays there; the code is
not built)

**Needed by:** nothing required. [Interaction](interaction.md) and [approvals](approvals.md) draw
their questions as `choice` parts.

## What it gives
Images, files and buttons in both directions, on every channel: drawn where the platform can, as
text where it cannot.

## How it fits pikit
- The contract is SPEC §5: `OutboundMessage.parts` typed by declaration merging on
  `AppMessageParts`, a `fallback` text per part, `ChannelTransport.draws`, and
  `InboundMessage.replyTo`. What is not built:
  - the first part kinds (`choice`, `image`, `file`), each declared by the component that needs it;
  - `InboundMessage.attachments` and images in `AgentRequest`, added with the first producer (SPEC
    §6.1: "adding a field is compatible, removing one is not");
  - storage of media: bytes in `storage.blob` with a reference in the transcript (R2 on Cloudflare,
    where a SQL row is at most 2 MB, SPEC §9.2);
  - a tool that produces a file as a part of the answer.
- Absent: text only, as today; a part folds into its fallback.

## Pi first
Pi's messages carry images (`ImageContent`), and the model sees them. Inbound messages go to Pi as
`custom` messages, so images go inside `content`, since `steer()`'s `images` accepts only user
messages (SPEC §6.4, costs of the bridges). pikit adds download and upload per platform, and
storage. A PDF becomes a file in the workspace, for the agent's tools to read.

## Open questions
- Which component introduces `image` and `file` first, and their size limits.
- How long media is kept, and whether a `/reset` deletes it.
- [Voice](voice.md) notes are attachments too.

# Channel context: a directory, a prompt and tools per channel

**Public appeal:** — (pi-hive's `isolated_workspace`, a directory per chat space)

**Specified:** the contract is built: `ConversationRef.channel` (`packages/contracts/src/agent.ts`),
recorded by `conversations.registry` and by the runtime, with its conformance case ("a conversation
keeps the channel it was created with") and runtime-pi's test (a run sees it, in `prepare` and after a
restart). Its first user is built too: `workspace-local`'s `per: "channel"` (below). A prompt
and tools per channel need no component (`prepare`); a prompt from files waits for
[agent folders](agent-folders.md).

**Needed by:** nothing required.

## What it gives
An agent that talks on several channels (Telegram, the dashboard, Google Chat) is told apart per
channel, each part optional: its tools work in a directory of the channel's, it gets a few lines of
prompt for that channel (format, who it talks to), and it may have other tools there (no `bash` from
Telegram).

## How it fits pikit
- **The channel is a fact of the conversation, read, never parsed from a key.** A conversation belongs
  to one channel for good ([conversation routing](conversation-routing.md)): `admitInbound` resolves
  the key with `InboundMessage.channel`, admin-api with `dashboard`, tool-delegate's children are
  `delegate`. The registry keeps the first one through resets, and the runtime records it with the
  conversation (`pikit.conversation`), so every run sees it: `CONVERSATION` in a tool, a section or a
  hook, `PrepareContext.conversation` in `prepare`, and the `ConversationRef` a `workspace` provider
  is asked for. An operator's message from the dashboard into a Telegram conversation still runs as
  `telegram`. Settlements do not carry it, and answers never use it: they find their chat by the key.
- **Prompt and tools per channel need no component**: `prepare` already returns them per run.

  ```ts
  defineAgent({
    name: "assistant",
    model: "…",
    tools: ["read", "bash"],
    prepare: (_state, { conversation }) =>
      conversation.channel === "telegram"
        ? { systemPrompt: `${BASE}\nAnswer in short plain text: this is Telegram.`, tools: ["read"] }
        : {},
  });
  ```

  A prompt that is data (edited live, or a file per channel, [agent folders](agent-folders.md)) is an
  agent extension's system prompt section instead: sections run in the conversation's scope, so one
  reads `context.value(CONVERSATION)?.channel` and returns that channel's text.
- **A directory per channel is `workspace-local`'s option** (built), not a new capability:
  `per: "agent"` (the default) or `"channel"`, `<root>/<agent>/<channel>/`, a channel instance's `:`
  written `.` (`telegram:ops` → `telegram.ops/`). A conversation with no channel recorded (a ref made
  by hand, a test) works in the agent's directory. A channel that is not a safe directory name is
  refused, as an agent's is, never cleaned up. `"conversation"` (one directory per conversation,
  pi-hive's per space) would name it by a hash of the key, which hashes the key without reading it.
- **Order, not isolation**: the same caveat as workspace-local's own. `bash` can `cd ..` into another
  channel's directory; isolation is [sandboxed execution](sandboxed-execution.md)'s.
- **Tests** (workspace-local's, built): two channels of one agent get two directories, a conversation
  without a channel gets the agent's, an unsafe channel fails the tool call and creates nothing, a real
  run's later message without a channel writes in its conversation's channel directory, and
  `createWorkspaceConformance` passes with `per: "channel"`.

## Pi first
Pi knows no channels: a Pi session has one working directory. pi-durable's conversation documents
keep the channel (`ConversationDoc`), and its `ExecutionEnv` is what a workspace hands out
(`atCwd`). Nothing else to take from Pi.

## Open questions
- Whether a delegated child (`delegate`) works in its own directory or in its parent's. Today it is a
  conversation of its own channel, so `per: "channel"` gives it `<agent>/delegate/`.
- Per conversation on Cloudflare: `execution-do` is already one environment per Durable Object, so a
  conversation is apart there by construction; the option is the server's.

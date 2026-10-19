# extension-approvals

The tools you list run only with a person's approval of that exact call, recorded by code, never by
the model reading "approved". For the agents that name it (`extensions: ["approvals"]`).

- **Provides:** `agent.extension`, under the key `approvals`; a stage of `inbound.normalize`.
- **Requires:** `approvals` (approvals-sql). It carries an identical copy of `contract.ts`.
- **Targets:** `server` (as approvals-sql); it imports nothing platform-specific.
- **Installs to:** `src/pikit/extension-approvals/`.

## Use it

```ts
export const config = {
  "extension-approvals": {
    tools: ["bash"],                                  // run only with an approval of the exact call
    approvers: ["telegram:12345", "dashboard:*"],     // who may decide, as the channel authenticated them
    expiresInMs: 86_400_000,                          // default: a day to decide and use it
  },
};
// src/agents/<agent>/agent.ts
defineAgent({ name: "ops", model: "…", tools: ["bash"], extensions: ["approvals"] });
```

Name it **last** among extensions whose hooks block or rewrite tool calls (a later hook that blocks a
call it claimed leaves that approval claimed and unexecuted).

## What happens
1. The model calls `bash`: refused, `"bash" needs a person's approval of this exact call. Call
   request_approval with tool "bash" and args {…}`.
2. It calls `request_approval({ tool, args, title, reason })` (only for a listed tool): the action
   `{ type: "tool:bash", payload: args }` is proposed with the configured approvers and expiry,
   idempotent by `<conversation>:<call>` (`replay: "safe"`), and the run ends with a `question` part,
   `approval:<id>`, one `confirm` field "Approve". Its description shows the exact action and the two
   lines to send in a message (`answerText`'s words), for a channel that sends the fallback.
3. The answer comes back as a message (Google Chat's buttons write those lines; elsewhere the person
   types them). Its stage of `inbound.normalize` reads it before the model does and calls `decide` as
   `<channel>:<actor id>`, as the channel authenticated the sender: the store refuses anyone the
   approvers do not name. It adds a note to the text: `[approvals] Recorded: approval <id> is approved,
   decided by telegram:12345.` or `[approvals] Not recorded: <why>.` A redelivered answer changes
   nothing. A store it cannot reach throws: the channel does not acknowledge, the platform redelivers.
4. The model calls `bash` with the same arguments: `beforeTool` hashes the call as it will run and
   claims an approval of it from this conversation, for this tool task (`<conversation>:<task>`).
   pi-durable runs `beforeTool` again when a task recovers before its intent was committed: the same
   claimant gets the same approval. A second call, other arguments or another conversation get none
   and are refused. A store that fails blocks the call.
5. `afterTool` settles it: `executed`, or `failed` with the error's first line. A call interrupted
   after its intent (an `unsafe` tool) is not run again and its approval stays `claimed`.

## Tests
`extension-approvals.test.ts` (copied with it): what setup declares, tools without approvers refused,
answers read (and a title that tries to carry another id). The repository's `app.test.ts` runs it with
runtime-pi, mailbox-local, approvals-sql and the scripted model: refused before approval; a stranger's
yes records nothing; the approver's is recorded, and its redelivery is a duplicate that changes
nothing; after a restart other arguments are refused, the exact call runs once, the same call again is
refused; an approval is not usable from another conversation; a tool not listed cannot be asked for.
Not covered: Cloudflare; a crash between claim and intent (covered by the store's same-claimant case).

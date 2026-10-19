# memory-summaries

Summarizes each conversation that went quiet into the memory of its person
([memory-sql](../memory-sql/README.md), kind `summary`), which
[memory-recall](../memory-recall/README.md)'s section shows: the agent knows what it talked about with
that person before, also after a reset or in a new conversation. Credentials are redacted before
anything is kept.

- **Provides:** nothing (a background worker).
- **Requires:** `storage.sql`, `wakeups`, `agent.submissions`, `agent.observe`, `model.complete`
  (runtime-pi), `memory`.
- **Targets:** `server`.
- **Installs to:** `src/pikit/memory-summaries/` (`contract.ts`, an identical copy of memory-sql's;
  `index.ts`, `memory-summaries.test.ts`).

## Use it

```sh
pikit add memory-summaries
```

```ts
export const config = {
  "memory-summaries": {
    model: "anthropic/claude-haiku-4-5", // provider/modelId: who writes the summaries
    agents: ["assistant"],                // whose conversations: those that name the memory extension
    idleMinutes: 30,                      // how long a conversation stays quiet first (default 30)
  },
};
```

## What it guarantees

- **Nothing depends on an event or on `stop`** (K3, K6). It reads `agent.submissions`' `answers` feed
  from its own cursor, and marks the conversation of each settled run of `agents` due `idleMinutes`
  later, in the same transaction as the cursor (tables `memory_summaries_conversations` and
  `memory_summaries_cursor`). A run settling wakes it at once (`agent.settled`, `agent.failed`), and so
  does `start`; otherwise its one wakeup, `memory-summaries`, is asked for the earliest due time.
- **New activity postpones.** A later run moves the conversation's due time; a request still pending
  (a run going, a message queued) postpones it by `idleMinutes`.
- **Only what is new.** It reads the transcript (`agent.observe`, newest first) back to the last entry
  it summarized, at most 200 entries and the newest 24 000 characters of what the person and the
  assistant said (no tool results), and asks the model for at most 6 short lines. Nothing new, nothing
  kept.
- **Once.** The summary's id is `summary:<conversationId>:<newest entry id>` and memory's `remember`
  is idempotent by id: a wakeup that runs again, or a crash between keeping it and recording it, keeps
  it once.
- **No credentials.** Every word with a known credential's shape (`credentialSettingProblem`'s:
  `sk-…`, a GitHub token, a bot token, a JWT, a URL with a password) is replaced by `[redacted]` in the
  transcript before the model reads it and in its answer before it is kept; an answer that still holds
  one (a private key's block) is not kept. Logs never carry a transcript or a summary.
- **Failures are retried.** A model or store failure is logged, and that conversation is tried again
  `idleMinutes` later; the others go on. Runs pruned from the feed before it read them (a gap) are
  logged once; their conversations are summarized after their next run.
- **Bounded.** At most 10 conversations per run of the wakeup, the rest at once after.

## Tests

- `memory-summaries.test.ts` (copied into your project), with doubles of the runtime's side, an
  in-memory `wakeups` and the test's clock: a quiet conversation summarized once, though the wakeup runs
  again and the App restarts; a restart before it went quiet; a crash after the summary was kept keeps
  it once; a settled run and a pending request postpone; a run settling while a summary is written is
  read at once; a later period summarizes only what is new; credentials redacted in and out, an answer
  still holding one not kept; only the configured agents; a gap logged once.
- `app.test.ts` (in the registry only): runtime-pi, memory-sql, memory-recall, provider-faux
  (`faux/echo` writes the summary) in a real App: a quiet conversation with a credential is summarized,
  redacted, and shown in the next conversation's `memory` section.

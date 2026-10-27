# memory-summaries

Summarizes each conversation that went quiet into the memory of its space
([memory-sql](../memory-sql/README.md), kind `summary`), structured to be found again: every agent
working in the space knows what was talked about there before, in another thread, after a reset or
in a new conversation. [memory-recall](../memory-recall/README.md)'s section shows the newest briefly,
`recall` searches them, `read_memory` reads one whole. Credentials are redacted before anything is
kept.

- **Provides:** nothing (a background worker).
- **Requires:** `storage.sql`, `wakeups`, `agent.submissions`, `agent.observe`, `model.complete`
  (runtime-pi), `memory`, `conversations.registry` (the space each key's conversations belong to).
- **Targets:** `server` and `durable`: it imports nothing platform-specific. On Cloudflare it runs in
  each conversation's Durable Object, over that object's answers feed, transcript, storage and alarm
  (actors-do's `wakeups`), and keeps each summary in the owner's object through `memory`.
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

- **Into its owner's memory.** A summary goes where `memory.ownerOf` says (memory-sql decides): the
  conversation's space, the one `conversations.registry` recorded for its key (none recorded: the key
  is its own space), or the agent's own for an agent memory-sql keeps apart.
- **Made to be found.** The model is asked (`SUMMARY_SYSTEM`) for a Markdown summary in the language
  of the conversation: a title line, `Topics:`, `Entities:`, `Keywords:` (exact terms, ids, error
  strings, config keys), then decisions and outcomes, action items, facts for future conversations and
  open questions, parts left out when empty, at most 3500 characters (up to 1500 tokens; whatever is
  longer is cut at the store's 4000). memory-recall shows its first line as the title.
- **Nothing depends on an event or on `stop`** (K3, K6). It reads `agent.submissions`' `answers` feed
  from its own cursor, and marks the conversation of each settled run of `agents` due `idleMinutes`
  later, in the same transaction as the cursor (tables `memory_summaries_conversations` and
  `memory_summaries_cursor`). A run settling wakes it at once (`agent.settled`, `agent.failed`), and so
  does `start` when there is something to read or due (on Cloudflare every object's App starts it: an
  object with nothing to do asks for no alarm); otherwise its one wakeup, `memory-summaries`, is asked
  for the earliest due time.
- **New activity postpones.** A later run moves the conversation's due time; a request still pending
  (a run going, a message queued) postpones it by `idleMinutes`.
- **Only what is new.** It reads the transcript (`agent.observe`, newest first) back to the last entry
  it summarized, at most 200 entries and the newest 24 000 characters of what the people and the
  assistant said (no tool results). Nothing new, nothing kept.
- **Once.** The summary's id is `summary:<conversationId>:<newest entry id>` and memory's `remember`
  is idempotent by id: a wakeup that runs again, or a crash between keeping it and recording it, keeps
  it once.
- **No credentials.** Every word with a known credential's shape (`credentialSettingProblem`'s:
  `sk-...`, a GitHub token, a bot token, a JWT, a URL with a password) is replaced by `[redacted]` in the
  transcript before the model reads it and in its answer before it is kept; an answer that still holds
  one (a private key's block) is not kept. Logs never carry a transcript or a summary.
- **Failures are retried.** A model or store failure is logged, and that conversation is tried again
  `idleMinutes` later; the others go on. Runs pruned from the feed before it read them (a gap) are
  logged once; their conversations are summarized after their next run.
- **Bounded.** At most 10 conversations per run of the wakeup, the rest at once after.

## Tests

- `memory-summaries.test.ts` (copied into your project), with doubles of the runtime's side, a
  registry of each key's space, an in-memory `wakeups` and the test's clock: a quiet conversation
  summarized once into its space, though the wakeup runs again and the App restarts; a restart before
  it went quiet; a crash after the summary was kept keeps it once; a settled run and a pending request
  postpone; a run settling while a summary is written is read at once; a later period summarizes only
  what is new; credentials redacted in and out, an answer still holding one not kept; only the
  configured agents; a gap logged once; each summary's owner (the recorded space, the key when none,
  an agent kept apart's own); the prompt's structure.
- `app.test.ts` (in the registry only): runtime-pi, conversations-kv, memory-sql, memory-recall,
  provider-faux (`faux/echo` writes the summary) in a real App: a quiet thread with a credential is
  summarized, redacted, and shown in another thread of its space's `memory` section; a thread of
  another space has none.
- The workerd lane (`tests/workerd/test/memory.workerd.ts`): in a thread's Durable Object, a run
  settles, `Date` is moved past `idleMinutes`, and the object's alarm summarizes the thread into the
  space's object.

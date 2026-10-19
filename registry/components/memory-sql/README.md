# memory-sql

What each agent remembers of each person, across that person's conversations and channels: the
store of memory ([features/memory.md](https://github.com/ajarellanod/pikit/blob/main/features/memory.md)). It **declares** the kind `memory` and the capability
`memory` (its contract is `contract.ts`, which every component that uses it carries an identical copy
of), and provides it over `storage.sql`, with **one actor per person**.

- **Provides:** `memory` (declared here).
- **Requires:** `storage.sql`, `actor.mailbox`, `actor.inbox` (on a server: storage-sqlite and
  mailbox-local; on Cloudflare: storage-do and actors-do).
- **Targets:** `server` and `durable`: it imports nothing platform-specific.
- **Installs to:** `src/pikit/memory-sql/` (`contract.ts`, `index.ts`, `conformance.ts`,
  `memory-sql.test.ts`).

It changes nothing an agent does by itself: [memory-recall](../memory-recall/README.md) gives agents
the section and the tools, and [memory-summaries](../memory-summaries/README.md) keeps summaries of
quiet conversations.

## The contract

```ts
type MemoryScope = { agent: string; person: string };              // one agent's memory of one person
type Memory = { id: string; kind: "fact" | "summary"; text: string; createdAt: number };

interface MemoryStore {
  list(scope, kind, limit, ctx): Promise<Memory[]>;     // the newest `limit` of `kind`, oldest first
  remember(scope, memory, ctx): Promise<void>;          // idempotent by id
  forget(scope, id, ctx): Promise<void>;                // an unknown id is fine
  search(scope, query, limit, ctx): Promise<Memory[]>;  // both kinds, text contains query, newest first
}
```

Who the person is, is the caller's: memory-recall and memory-summaries use the conversation's key
(one chat is one person) until keys can be linked.

## What it guarantees

- **Per agent and person.** Every query filters by agent and person. Every operation is
  `mailbox.call("memory:<person>", "memory-sql.<op>", …)`, answered by the person's actor
  (`actor.inbox`'s `answer`), which checks the message on arrival and refuses, as `invalid`, a call
  meant for another person or one that is malformed.
- **Idempotent.** `remember` of an id already kept (in that scope) changes nothing, so a replayed tool
  call or a retried summary keeps one memory.
- **No secrets.** A text with a known credential's shape (`sk-…`, a GitHub token, a bot token, a JWT,
  a private key, a URL with a password, whole or as a word: `credentialSettingProblem` of
  `@pikit/contracts`), an empty text or one over 4000 characters is refused, keeps nothing, and the
  error never echoes it. A card number or an unknown token shape is not recognised.
- **Durable.** Each memory is a committed row of `memory_sql_items` before `remember` resolves; nothing
  is held in memory, so a `kill -9` loses nothing and `stop` is never needed (K6).
- **Search** is SQL `LIKE`, its `%` and `_` taken literally, ASCII case ignored (SQLite's). Full-text
  search (FTS5) is open.

On a server every key's actor is the App itself (mailbox-local), so the table is in the App's one
database. On Cloudflare the person's actor is the Durable Object `memory:<person>` (actors-do), with
the table in its own SQLite: one owner per person, whose writes are ordered, at the cost of one call
between objects per model request (the section) and per tool call. Every object's App creates the
(empty) table at start; only the person's object fills it.

## Tests

- `conformance.ts`: `createMemoryConformance(factory)`, the `memory` suite any provider runs: listed
  by kind, newest `limit`, oldest first; the same id kept once; `forget` of an unknown id; another
  person's or agent's memories never listed, searched or forgotten; search with literal wildcards and
  `limit`; a credential, an empty or a too long text refused and never echoed; a restart keeps
  everything.
- `memory-sql.test.ts`: the suite over `createMemoryMailbox()` and `sqliteStorage()`; what `setup`
  declares; a person's actor refusing another person's call and malformed ones (`invalid`).
- In the registry, `memory-recall/app.test.ts` runs it in a real App with runtime-pi, and the
  workerd lane (`tests/workerd/test/memory.workerd.ts`) runs the suite over storage-do and actors-do,
  each person in their own Durable Object, and the refused call across an RPC.

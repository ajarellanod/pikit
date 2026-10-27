# memory-sql

What the agents of each space remember, and what each person prefers: the store of memory
([features/memory.md](https://github.com/ajarellanod/pikit/blob/main/features/memory.md)). It **declares** the kind `memory` and the capability
`memory` (its contract is `contract.ts`, which every component that uses it carries an identical copy
of), and provides it over `storage.sql`, with **one actor per owner**.

- **Provides:** `memory` (declared here).
- **Requires:** `storage.sql`, `actor.mailbox`, `actor.inbox` (on a server: storage-sqlite and
  mailbox-local; on Cloudflare: storage-do and actors-do).
- **Targets:** `server` and `durable`: it imports nothing platform-specific.
- **Installs to:** `src/pikit/memory-sql/` (`contract.ts`, `index.ts`, `conformance.ts`,
  `memory-sql.test.ts`).

It changes nothing an agent does by itself: [memory-recall](../memory-recall/README.md) gives agents
the section, the tools and the commands `/rules` and `/prefs`, and
[memory-summaries](../memory-summaries/README.md) keeps summaries of quiet conversations.

## Whose memory

A memory belongs to an **owner**:

- **a space** (`{ type: "space", space }`): the place several conversations share (a Google Chat space
  whose threads are each a conversation, a web chat project), `spaceOf(conversation)` of
  `@pikit/contracts`: the channel's space, else the conversation's own key (a private chat is its own
  space); a delegated conversation is in its origin's. Every agent working in that space shares its
  memory: a fact about a client serves them all. The default for every agent.
- **an agent** (`{ type: "agent", agent }`): one agent's own memory across every space it works in,
  for the agents named in `agentScope` (pi-hive's `memory_scope: agent`). Such an agent reads and
  writes only its own, never a space's.
- **a person** (`{ type: "person", channel, id }`): their preferences, as a channel identifies them (a
  request's `Sender`), wherever they write.

`ownerOf(conversation)` gives a conversation's (a space's or an agent's): the one place that policy is
decided, which memory-recall and memory-summaries both ask.

```ts
// pikit.config.ts
export const config = {
  "memory-sql": { agentScope: ["trader"] },   // default []: every agent shares its space's memory
};
```

## The contract

```ts
type MemoryOwner = { type: "space"; space: string } | { type: "agent"; agent: string } | { type: "person"; channel: string; id: string };
type MemoryKind = "fact" | "summary" | "rule" | "preference";
type MemoryStatus = "active" | "pending";
type Memory = { id: string; kind: MemoryKind; status: MemoryStatus; text: string; createdAt: number };
type MemoryMatch = Memory & { snippet: string };
type MemoryFilter = { kinds: readonly MemoryKind[]; status?: MemoryStatus };

interface MemoryStore {
  ownerOf(conversation): MemoryOwner;                   // its space's, or its agent's own
  list(owner, filter, limit, ctx): Promise<Memory[]>;   // the newest `limit` the filter takes, oldest first
  get(owner, id, ctx): Promise<Memory | undefined>;
  remember(owner, memory, ctx): Promise<void>;          // idempotent by id: text and status stay
  approve(owner, id, kind, ctx): Promise<boolean>;      // pending -> active; true when active now
  forget(owner, id, filter, ctx): Promise<boolean>;     // true when one was removed
  search(owner, query, limit, ctx): Promise<MemoryMatch[]>; // facts and summaries, full-text, best first
}
```

A space or an agent keeps `fact`s and `summary`s (data, always `active`) and `rule`s (instructions,
`pending` until a person approves them); a person keeps `preference`s (`pending` or `active`).

## What it guarantees

- **Per owner.** Every query filters by owner. Every operation is
  `mailbox.call(<owner's key>, "memory-sql.<op>", ...)`, answered by that owner's actor
  (`memory:space:<space>`, `memory:agent:<agent>` or `memory:person:<channel>:<id>`, the channel
  URI-encoded so no two owners share a key; `actor.inbox`'s `answer`), which checks the message on
  arrival and refuses, as `invalid`, a call meant for another owner, a kind that owner does not keep,
  a pending fact or summary, or a malformed call.
- **Idempotent.** `remember` of an id already kept (in that owner) changes nothing, text and status:
  a replayed tool call, a retried summary or a command run twice keeps one memory, and a proposal never
  demotes an active rule. `approve` of an active memory leaves it active and answers `true`.
- **No secrets.** A text with a known credential's shape (`sk-...`, a GitHub token, a bot token, a
  JWT, a private key, a URL with a password, whole or as a word: `credentialSettingProblem` of
  `@pikit/contracts`), an empty text or one over 4000 characters is refused for every kind, keeps
  nothing, and the error never echoes it. A card number or an unknown token shape is not recognised.
- **Durable.** Each memory is a committed row of `memory_sql_memories` before its call resolves;
  nothing is held in memory, so a `kill -9` loses nothing and `stop` is never needed (K6).
- **Full-text search.** `search` uses SQLite's FTS5 (`memory_sql_search`, an external-content index of
  the facts and summaries, kept in step by triggers in the statement that changes a row): BM25-ranked,
  any case, diacritics ignored, each match with a snippet (`[matched]` words). The query is cut into
  words (runs of letters and digits), each quoted, tried as all of them, then as the phrase, then as any
  of them: an email, a URL, quotes, `NOT`, `*` or a hyphenated id is never a syntax error; a query with
  no word finds nothing. FTS5 is in both targets' SQLite (node:sqlite under Bun on a server, a Durable
  Object's on Cloudflare), so there is no `LIKE` fallback (a Durable Object refuses long `LIKE`
  patterns anyway).

On a server every key's actor is the App itself (mailbox-local), so the tables are in the App's one
database. On Cloudflare each owner's actor is the Durable Object of its key (actors-do), with the
tables in its own SQLite: one owner per space, agent or person, whose writes are ordered, at the cost
of one call between objects per list in the section (the owner's, and one per person the run answers)
and per tool call. Every object's App creates the (empty) tables at start; only the owner's object
fills them.

## Tests

- `conformance.ts`: `createMemoryConformance(factory)`, the `memory` suite any provider runs:
  `ownerOf` (a thread's space, a private chat's key, a delegated conversation's origin's space, an
  agent kept apart's own); listed by kind and status, newest `limit`, oldest first, and got by id; the
  same id kept once, text and status (a proposal never demotes an active rule, a later active write
  never activates a pending one); `approve` (once, never across kinds); `forget` by filter (an unknown
  id, or one the filter leaves, stays); another owner's memories never listed, got, searched, approved
  or forgotten, even under the same id; each owner only its kinds, a fact or summary only active;
  full-text search (every word in any order and case, then any word, ranked, snippets, diacritics, a
  hyphenated id, rules never found, queries of punctuation and FTS5 operators never failing); a
  credential, an empty or a too long text refused for every kind and never echoed; a restart keeps
  everything, searchable. Each case uses owners of its own, so a provider whose storage outlives a
  case runs it too. Each case was checked against a broken provider (no owner filter in search,
  `DO UPDATE` on remember, approve ignoring the kind, every kind for every owner, rules indexed,
  forget ignoring the filter, pending facts, no credential check, no OR fallback): each fails.
- `memory-sql.test.ts`: the suite over `createMemoryMailbox()` and `sqliteStorage()` (with `trader`
  kept apart); what `setup` declares; an owner's actor refusing another owner's call, a kind its owner
  does not keep and malformed ones (`invalid`); how a query becomes FTS5 queries.
- In the registry, `memory-recall/app.test.ts` runs it in a real App with runtime-pi, and the
  workerd lane (`tests/workerd/test/memory.workerd.ts`) runs the suite over storage-do and actors-do,
  each owner in their own Durable Object (FTS5 included), and the refused call across an RPC.

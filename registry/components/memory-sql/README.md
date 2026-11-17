# memory-sql

What the agents of each space remember, and what each person prefers: the store of memory
([features/memory.md](https://github.com/ajarellanod/pikit/blob/main/features/memory.md)). It **declares** the kind `memory` and the capability
`memory` (its contract is `contract.ts`, which every component that uses it carries an identical copy
of), and provides it over `storage.sql`, with **one actor per owner**.

- **Provides:** `memory` (declared here), in both Apps on Cloudflare: the default export in the
  objects, and its Worker half (`worker`, `memory-sql-worker`) in the Worker's App.
- **Requires:** `storage.sql`, `actor.mailbox`, `actor.inbox` (on a server: storage-sqlite and
  mailbox-local; on Cloudflare: storage-do and actors-do). The Worker half requires `actor.mailbox`
  only.
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
// On Cloudflare, the Worker half's (the same value, so ownerOf answers the same in both Apps):
export const workerConfig = { "memory-sql-worker": { agentScope: ["trader"] } };
```

## The contract

```ts
type MemoryOwner = { type: "space"; space: string } | { type: "agent"; agent: string } | { type: "person"; channel: string; id: string };
type MemoryKind = "fact" | "summary" | "rule" | "preference";
type MemoryStatus = "active" | "pending";
type Memory = { id: string; kind: MemoryKind; status: MemoryStatus; text: string; createdAt: number; updatedAt?: number; by?: Author };
type NewMemory = Omit<Memory, "updatedAt" | "by"> & { by: Author };   // Author: @pikit/contracts' change.ts
type MemoryMatch = Memory & { snippet: string };
type MemoryFilter = { kinds: readonly MemoryKind[]; status?: MemoryStatus };

interface MemoryStore {
  ownerOf(conversation): MemoryOwner;                   // its space's, or its agent's own
  list(owner, filter, limit, ctx): Promise<Memory[]>;   // the newest `limit` the filter takes, oldest first
  get(owner, id, ctx): Promise<Memory | undefined>;
  remember(owner, memory: NewMemory, ctx): Promise<void>; // idempotent by id: text and status stay
  approve(owner, id, kind, by, ctx): Promise<boolean>;  // pending -> active; true when active now
  forget(owner, id, filter, by, ctx): Promise<boolean>; // true when one was removed
  search(owner, query, limit, ctx, filter?): Promise<MemoryMatch[]>; // default facts and summaries, full-text, best first
  replace(owner, id, memory: NewMemory, ctx): Promise<Memory | undefined>; // new words as one change
  changes(owner, page, ctx): Promise<ChangePage>;       // the owner's change log, newest first
  restore(owner, n, by, ctx): Promise<Change>;          // the state before change n, as a new change
  redact(owner, n, by, ctx): Promise<void>;             // operators only
  purge(owner, ctx): Promise<void>;                     // a removed project's space
}
```

A space or an agent keeps `fact`s and `summary`s (data, always `active`) and `rule`s (instructions,
`pending` or `active`: whether a new rule waits for a person is the caller's choice, memory-recall's);
a person keeps `preference`s (`pending` or `active`). `Author` and `Change` are `@pikit/contracts`'
(`change.ts`); the log's item kinds are `note` (a fact), `summary`, `rule` and `preference`
(`MEMORY_CHANGE_KIND`).

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
- **Who and when.** Every write names its author (`Author`), set by the calling component from what
  it authenticated; the owner's actor checks it on arrival with `parseAuthor` (`invalid` otherwise,
  never quoting it) and keeps it on the memory (`by`: its first author; approving does not change
  it, a `replace` makes the replacer the author of the new words). `updatedAt` is when its status or
  words last changed, on the store's clock.
- **A change log per owner, in the same transaction.** Every `remember` that keeps something new,
  `approve` that activates, `forget` that removes, `replace` and `restore` appends one entry
  (`memory_sql_changes`: `n` 1, 2, 3... per owner, its author, the store's time, the item's kind, id
  and title, `changeTitle` of its words) in the transaction that changes the memory: a write that fails
  before its commit leaves neither. A repeat that changes nothing (the same id remembered again, an
  active rule approved, nothing to forget, the same words replaced) appends nothing. No method changes
  or deletes an entry, but these three, never a member's: an operator's `redact(n)` (`forbidden` for
  any other author) blanks its stored states and its title (`(redacted)`), keeping who, when and what,
  and says so (`redacted`); entries past 365 days (`CHANGE_RETENTION_DAYS`) are not restorable and are
  dropped at the owner's next write, their numbers never reused (`memory_sql_logs` keeps the last);
  `purge(owner)` deletes an owner's memories and log for good (a removed project's space).
  `changes(owner, { before?, limit })` pages it newest first.
- **Exact restore.** Each entry keeps the states of the memories it touched, before and after it.
  `restore(n)` puts back exactly the state before `n` (a forgotten memory under its id with its words,
  status, times and first author; an approval undone, pending again; an addition removed; a replace's
  old words back and the new removed) and appends a `restored` entry by the restorer (`restores: n`),
  whose own states make it restorable in turn. A redacted entry or one past retention is `gone`; a
  number never logged `not_found`.
- **`replace(owner, id, memory)`**: new words for a rule or a note as one change: the kept memory has
  `id`'s kind, status and `createdAt` (its place in lists), the new words, the replacer as author and
  `updatedAt` now; under the new id (a rule's id is its words') or the same one (a note's). `undefined`
  for an unknown id; the new id held by another memory is `invalid`.
- **Full-text search.** `search` uses SQLite's FTS5 (`memory_sql_search`, an external-content index of
  every memory, kept in step by triggers in the statement that changes a row), filtered by kind and
  status: by default facts and summaries (`MEMORY_SEARCH_DEFAULT`; nothing of a person's), with a
  filter rules too (projects-context's `project_search` asks for active rules, notes and summaries), or
  a person's preferences. BM25-ranked, any case, diacritics ignored, each match with a snippet
  (`[matched]` words) and its author. The query is cut into words (runs of letters and digits), each
  quoted, tried as all of them, then as the phrase, then as any of them: an email, a URL, quotes,
  `NOT`, `*` or a hyphenated id is never a syntax error; a query with no word finds nothing. FTS5 is in
  both targets' SQLite (node:sqlite under Bun on a server, a Durable Object's on Cloudflare), so there
  is no `LIKE` fallback (a Durable Object refuses long `LIKE` patterns anyway).

On a server every key's actor is the App itself (mailbox-local), so the tables are in the App's one
database. On Cloudflare each owner's actor is the Durable Object of its key (actors-do), with the
tables in its own SQLite: one owner per space, agent or person, whose writes are ordered, at the cost
of one call between objects per list in the section (the owner's, and one per person the run answers)
and per tool call. Every object's App creates the (empty) tables at start; only the owner's object
fills them. The Worker's App has no `storage.sql`: there the Worker half (`memory-sql-worker`, the
export `worker`, which `apps.worker` names) gives `memory` through `actor.mailbox` only, the same calls
to the owners' objects (`memoryOver`), for channel-web's project routes and an admin route.

## Tests

- `conformance.ts`: `createMemoryConformance((clock) => fixture)`, the `memory` suite any provider
  runs, on the case's `ManualClock` (an owner in another App, a Durable Object, reads the same time):
  `ownerOf` (a thread's space, a private chat's key, a delegated conversation's origin's space, an
  agent kept apart's own); listed by kind and status, newest `limit`, oldest first, and got by id, each
  with its author; the same id kept once, text, status and author (a proposal never demotes an active
  rule, a later active write never activates a pending one); `approve` (once, never across kinds, its
  `updatedAt`, the author kept); `forget` by filter (an unknown id, or one the filter leaves, stays);
  another owner's memories and log never listed, got, searched, approved, forgotten, replaced or
  restored, even under the same id; each owner only its kinds, a fact or summary only active, nothing
  refused logged; full-text search by default over facts and summaries (every word in any order and
  case, then any word, ranked, snippets, authors, diacritics, a hyphenated id, rules never found,
  queries of punctuation and FTS5 operators never failing), and with a filter (rules, by status; a
  person's preferences only when asked; a space's search of preferences refused); a credential, an
  empty or a too long text refused for every kind (and in `replace`) and never echoed; every author
  kept exactly (a person, an agent with its conversation and the person it answered, a component, an
  operator); a malformed author refused by every write as `invalid`, never quoted, nothing changed or
  logged; one entry per change (a fact's kind `note`, titles of one line, cut at 120 characters, the
  store's times) and none for a repeat; `changes` paged newest first (`next`), a malformed page
  `invalid`; `replace` (one entry, the old words back with one restore, the new removed; same id in
  place; the same words, an unknown id, a taken id); restore exact (an approval undone pending, a
  restore restored, a forgotten rule back and found again, an addition undone, every restore logged,
  `not_found`); `redact` (`forbidden` for a person, an agent, a component; who, when and what kept,
  titles blanked, `gone`); retention (not restorable past 365 days, `gone`, dropped at the next write,
  numbers never reused); `purge` (another owner's untouched); a restart keeps everything, searchable,
  with its log, restorable. Then `changeLogCases("memory", ...)` from `@pikit/contracts/testing` over a
  space's rules (written as a page writes them: `remember`, `replace` under the same id, `forget`):
  one entry per change with its author, restore exact (addition, change, removal, a restore of a
  restore), earlier entries byte for byte the same after every operation, a repeat appends nothing,
  retention, redaction, and (with the fixture's `failNextCommit`) a write failing before its commit
  leaving neither the memory nor the entry. Each case uses owners of its own, so a provider whose
  storage outlives a case runs it too. Each case was checked against a broken provider (no owner filter
  in search, `DO UPDATE` on remember, approve ignoring the kind, every kind for every owner, rules
  indexed, forget ignoring the filter, pending facts, no credential check, no OR fallback; and for the
  log: the memory written outside the entry's transaction, a restore keeping the restorer as the
  memory's author, a repeat logged, a redaction by anyone, retention ignored, rules found by the
  default search, the status filter ignored, no `updatedAt`, a restore rewriting the restored entry,
  replace keeping the old memory, purge leaving the log, numbers reused after retention, no author
  kept, authors unchecked, a removal logged as the memory's author, a page's `next` off by one): each
  fails.
- `memory-sql.test.ts`: the suite over `createMemoryMailbox()` and a SQLite database in memory whose
  next log entry can be made to fail inside its transaction (with `trader` kept apart); the same suite
  through the Worker half, from an App whose mailbox reaches the owners' App; what `setup` declares
  (both halves); an owner's actor refusing another owner's call, a kind its owner does not keep and
  malformed ones (`invalid`); how a query becomes FTS5 queries.
- In the registry, `memory-recall/app.test.ts` runs it in a real App with runtime-pi, and the
  workerd lane (`tests/workerd/test/memory.workerd.ts`) runs the suite (the log's cases included)
  over storage-do and actors-do, each owner in their own Durable Object (FTS5 included) on the case's
  clock, and again from a Worker's App through the Worker half, and the refused call across an RPC.

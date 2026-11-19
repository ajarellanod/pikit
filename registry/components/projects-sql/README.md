# projects-sql

Projects, the record of a space
([features/projects.md](https://github.com/ajarellanod/pikit/blob/main/features/projects.md)): it
provides `projects` (`ProjectStore`, `@pikit/contracts`' `projects.ts`) over `storage.sql`, with a
**directory actor** and **one actor per project**. Each project is the record of one space, shared by
its members (one owner) and the agents working there: its name and description, its members, its
instructions and documents with every version, its links, and the append-only change log of all of
them, with exact restore by any member. Operators see and operate every project in the dashboard.

- **Provides:** `projects`, `http.route` (`/admin/api/projects*`), and a stage of the
  `conversation.audience` pipeline (who belongs to a project's space, for conversations-directory).
- **Requires:** `storage.sql`, `actor.mailbox`, `actor.inbox`, `wakeups` (on a server:
  storage-sqlite, mailbox-local and wakeups-timers; on Cloudflare: storage-do and actors-do).
- **Optional:** `memory` (memory-sql: a removed project's space memory is purged with it),
  `admin.auth` (without it nobody is an operator: every admin route is `401`).
- **Targets:** `server` and `durable`: it imports nothing platform-specific. On `durable` the Worker's
  App runs the Worker half (`projects-sql-worker`, `component.json`'s `apps.worker`): `projects` over
  the mailbox, its `conversation.audience` stage, and the admin routes.
- **Installs to:** `src/pikit/projects-sql/` (`index.ts`, `project.ts` the project's actor,
  `directory.ts` the directory's, `store.ts` the client, `audience.ts` its `conversation.audience`
  stage, `routes.ts`, `tables.ts`, `worker.ts`, `contract.ts` memory-sql's contract,
  `projects-sql.test.ts`, `audience.test.ts`), and with a dashboard its view to
  `src/dashboard/src/views/projects-sql/`.

It gives agents nothing by itself: projects-context gives them the `<project>` section and the
`project_*` tools, and channel-web the people's pages; both use `projects`.

## Config

```ts
// pikit.config.ts
export const config = {
  "projects-sql": {
    coreTokens: 8000,        // the core documents' budget, in estimated tokens (CORE_TOKENS_DEFAULT)
    staleAfterMs: 1_800_000, // a sourced member counts this long after the sync that last checked it
  },
};
```

## How it works

- **The directory**, actor `projects:index`: one row per project (the project as operators see it)
  and its members by principal, for `create`, `list` and `locate`. It is never an access check: each
  project's actor tells it every new version after its commit (newer versions win), so a list may lag
  a moment behind a project, never let anyone in.
- **One actor per project**, `projects:space:<space>`: its record, members, the instructions and each
  document with every version (text in 20,000-character parts, a row far below an object's 2 MB), the
  FTS5 index of the current instructions, documents (parts of about 1,500 characters) and links, and
  the change log. Keyed by space, so an agent's section reaches its project with no lookup.
- **Every method is a call** (`actor.mailbox.call`), answered by this component's handlers over the
  `storage.sql` of the App the actor runs in: on a server one App and one database for every key; on
  Cloudflare the Durable Object of each key. Refusals cross as the store's codes and are thrown again
  as `ProjectError`. Nothing is held in memory between calls but `locate`'s answers (a project's
  space never changes). A start makes no call to another actor.

## Who belongs to a project's space (`conversation.audience`)

Both halves add `audienceStage("projects", …)` (`audience.ts`, stage id `projects-sql`): for one
person's principals it grants each project's space they are a current member of, `owner` for its
owner, `member` otherwise. The directory (conversations-directory) reads it through `audienceGrants`
to show a project's members its chats.

- **Only a project's own space**, `project:<id>`. A space a project adopted (the admin route's
  `space`, a Google Chat space) is never granted through the project: a Google Chat conversation is
  seen through its platform's membership only (the operator's decision of 2026-11-19).
- **A list** (no space given): the people `list` of those principals, active and archived projects,
  every page; never a removed project, nor a sourced member past `staleAfterMs`. It may lag a moment
  behind a project, as the directory does (a missing grant hides; it never lets in). It stops one
  past `AUDIENCE_MAX`, so the directory refuses it (`limit`) rather than cutting it.
- **The fresh check** (one space given, before opening or acting on a conversation): `roleOf` on the
  project's actor, now, once `locate` confirms the space is its project's own; any other space is
  answered with nothing, without a call. A removed member or project is granted nothing at once.
- **Fail closed**: a store or actor that fails makes the stage grant nothing (logged); the stage never
  touches another stage's grants.

## What it guarantees, and where

| Guarantee | Enforced in |
|---|---|
| One space, one project; a project's space never changes; people never name a space or an id | the project actor's `init` (one row a space: `space_taken`), the directory's `create` (`forbidden`), no write of `space` |
| Every call checked against its caller: a non-member, a removed project and none at all are the same `not_found`, before anything is read; an owner's act by a member `forbidden`; an agent only in its own space, only reads and `addLink` | `access` in `project.ts`, the one check, with `parseCaller` on arrival and `roleOfMembers` |
| Exactly one owner, a manual member, after every change; the owner leaves only after a transfer; sourced members change only by `syncMembers` of their source (components only) and count only while fresh | `removeMember`, `transferOwnership`, `syncMembers`, and `oneOwner` after every restore of members (which rolls back otherwise) |
| Every change is in the log with its author (`authorOf(caller)`), in the same transaction as the item; a repeat logs nothing; entries are never rewritten | every write runs in one `db.transaction` with its entry; authors parsed with `parseAuthor` when read back |
| Restore is exact: the state before `n` comes back (a version restored as a new version with its title, mode, source, text and original author; a link or member as it was; the record), and the state it replaces is logged, so a restore can be restored; the record's and members' changes are the owner's to restore | each entry keeps its `before`; `restore` applies it and appends a `restored` entry |
| `gone` past retention (365 days), after a redaction, or once a version was dropped by the size cap; `redact` operators' only (the title and kept state blanked, and the text the change wrote unless it is current) | `changeOf` (`restorable`), `redact`, `dropOldVersions` |
| `ifVersion` behind is `conflict`, the newer kept | `setInstructions`, `putDocument` |
| Bounds: name, description, instructions, document, 200 documents, 5M characters of documents, 20M with versions (the oldest earlier versions dropped past it), 200 links, 100 projects owned, the core documents within `coreTokens` (the refusal says how many are left) | `project.ts` and the directory's `create`: `limit` |
| No credentials: a name, description, instructions, a document's title or text, a link's URL, title or note with a known credential's shape (also as a URL's part) is `refused`, never echoed | `noCredential` (`credentialSettingProblem`) |
| Search stays in its project and never errs on syntax: all words, the phrase, then any word, each quoted | `search` (`searchAttempts`, as memory-sql's) |
| `context` answers `unchanged` for the version held; every change bumps `Project.version` | `context`, `bump` in the write's transaction |
| Archived projects are read-only (the owner unarchives them) and listed apart | `notArchived`, the directory's `list` |
| A removed project is gone for everyone but operators, recoverable for 30 days, then purged: out of the directory, its space's memory (`memory.purge`), every row | `remove`, `recover`, the `projects-sql.purge` wakeup in the App of the project's actor (each step idempotent; asked again at start) |

The admin routes ask `admin.auth` first and answer `401` before reading anything; then they act as
the operator (`{ kind: "operator", id }`), and the project's actor decides as for anyone:

- `GET /admin/api/projects?archived=&cursor=&limit=`: every project, removed ones too (`removedAt`).
- `POST /admin/api/projects` `{ space?, name, description?, owner: { channel, id }, agents? }`: a new
  project made by the operator, `201` with it. `space` adopts an existing space, keeping its string (a
  Google Chat space's key, `googlechat:spaces/AAA`); without it the project gets a new one. A space
  that has a project already (removed ones too) is `409` `{ error: "space_taken", id }`, naming that
  project, so a script adopting spaces can run twice; a body of another shape is `400`
  `invalid_request`, and the store's `invalid`, `limit` and `refused` are `400` too.
- `GET /admin/api/projects/:id`: `{ project, members, instructions?, documents, links }`.
- `GET /admin/api/projects/:id/history?before=&limit=`; `GET .../documents/:doc?part=&version=`.
- `POST .../history/:n/restore`, `.../history/:n/redact`, `.../archive` `{ archived }`, `.../remove`,
  `.../recover`, `.../members` `{ principal }`, `.../members/remove` `{ principal }`, `.../owner`
  `{ principal }`.

Store refusals map to `403`, `404`, `409`, `410` and `400`, as `{ error, message }`. Operators' acts are
logged with the operator and the project's id, never a name or a text.

## The view

`view/` (the dashboard's Projects): every project, active, archived or removed, with its owner, members,
space and last change; a project's page with its members (add one, make one the owner, remove a manual
one), instructions, documents (read one, part by part), links and History (Restore, Redact, each
behind a confirmation), and Archive, Remove (asks first) and Recover. "New project" makes one as the
operator: a space to adopt (or none: a new one), the owner's channel and id, the agents; a space taken
links to its project. It uses only the base
dashboard's primitives.

## Tests

- `projects-sql.test.ts` (39 tests): `createProjectsConformance` (18 cases, and the change log's 10 over
  documents written by three members, with a repeat, retention, a redaction and a write failing
  before its commit: the fixture's storage fails the next log entry's write) over `sqliteStorage()`,
  an in-memory mailbox and wakeups, and a manual clock; what setup declares (both halves); an actor
  answering only for its space and checking what it is sent; the purge after the tombstone (over a
  restart, `memory.purge` called, the space free again); archived projects; a document's hit naming
  its read part; the admin routes (`401` first, every act; and with no `admin.auth`); `POST /admin/api/projects` (`401`
  before the body is read, an adopted space made with the operator as its log's author, `409`
  `space_taken` with the project's id again and once removed, a new space without one, `400` for each
  bad body and the store's refusals).
- `audience.test.ts` (13 tests): `createConversationAudienceConformance` (6 cases) over the default
  export's App and over the Worker half calling a backend App of the default export through a bridged
  mailbox (failing: the database down; the backend unreachable); and that an adopted space is never
  granted while an archived project's still is. Checked against broken stages: adopted spaces
  granted, archived projects left out, the fresh check granting without a role.
- The workerd lane (`tests/workerd/test/projects.workerd.ts`, 29 tests): the same suite with the
  directory and each project in its own Durable Object, and from the Worker's App the routes, the
  rows in each object, and the purge at the project object's alarm.
- Checked against broken stores (each mutant fails at least one case): a restore that drops the title,
  the entry written outside the item's transaction, a restore that rewrites the restored entry, a
  non-member let in, an agent outside its space or writing people's items, `roleOf` ignoring
  staleness, `ifVersion` ignored, credentials kept, search across projects, the core budget unchecked,
  owner restores open to members, `redact` open to members, `context` never `unchanged`, a repeat
  logged, retention ignored.

Not covered: entries past retention are kept (shown not restorable) rather than dropped; the purge
does not delete the space's files (`space.files.purge`): using `space.files` here would make a
dependency cycle with tool-space-files, which uses `projects`; a crash between the directory's
`create` and its row leaves a project unlisted until its next change.

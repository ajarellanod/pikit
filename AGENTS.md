# Maintenance lessons

- External-registry fixtures must satisfy the complete `ManifestSchema`, including the required `optional.capabilities` and adapter range when depended on, before exercising another validation failure.
- Failed-install rollback tests must explicitly assert the unfinished-operation marker, then compare the other restored files; the marker intentionally survives because `node_modules` is not restored.
- Validation worktree dependency links must remap workspace source directories only, never local `node_modules` directories (otherwise `.bin/vitest` can link to itself).
- For files shared with a background agent, reread the exact current block before editing. Every replacement must be unique; merge overlapping edits and omit speculative/nonexistent matches.
- Reading pi-durable's SQLite from a test: text columns such as `submissions.request_id` and `documents.kind` hold JSON (`'"m1"'`, not `'m1'`). And `createConversation` with `conversations: "root"` returns the root only the first time; a test channel must keep the id it got, or each message lands in a new conversation.
- workerd lane: `evictDurableObject` hangs while an alarm event is still driving a run, and `abortAllDurableObjects()` during an in-flight event crashes the Vitest pool. To evict mid-run, fake `Date` a day ahead (alarms then do not fire on their own), fire each alarm with `runDurableObjectAlarm`, and evict between two alarms.
- The docs and comments write `"typing…"` with U+2026 inside the quotes: an edit's oldText that crosses such a line must copy it exactly (it never ends at `"typing`); for a long header with one, replace by indices in `js_exec` instead.
- In an edit's oldText/newText, write non-ASCII characters literally (`§`, `⭐`, `…`), never as `\u00a7`-style escapes: an escape matches nothing (or lands literally in the file), and a garbled oldText can still match a nearby span loosely and replace it. After any surprising "replaced", reread the block.
- In edit-tool text, write non-ASCII characters (`…`, `→`) literally, never as a doubly escaped `\\u2026`: that lands in the file as the six characters `\u2026`. After editing docs, `rg 'u20[0-9a-f]{2}'` the files.
- pikit is unreleased: never add backward compatibility (aliases, old-format readers, migrations from earlier schemas, "start fresh" handling for old data). Rename and change freely; only provider names (Cloudflare, Docker…) stay as they are, because that is where it deploys.

# Downloaded references

- `/Users/alex/Projects/Personal/pi` — Pi monorepo (`earendil-works/pi`); read `origin/main` (v1.0.3: `packages/durable`, `packages/chord`, `packages/server`) after `git fetch`, the local `main` checkout is stale.
- `/Users/alex/Projects/Personal/shadcn-ui` — shadcn CLI and registry (sparse: `packages/shadcn`, `packages/registry`, `apps/v4/content/docs/registry`), checked at 4.21.1.

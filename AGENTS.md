# Maintenance lessons

- The boundary import scanner treats strings and regexes in tests that contain `import ... from` as actual imports, even inside fixture readers. Avoid putting that phrase in test helper source; use file/path fragments instead.

- External-registry fixtures must satisfy the complete `ManifestSchema`, including the required `optional.capabilities` and adapter range when depended on, before exercising another validation failure.
- Failed-install rollback tests must explicitly assert the unfinished-operation marker, then compare the other restored files; the marker intentionally survives because `node_modules` is not restored.
- Validation worktree dependency links must remap workspace source directories only, never local `node_modules` directories (otherwise `.bin/vitest` can link to itself).
- For files shared with a background agent, reread the exact current block before editing. Every replacement must be unique; merge overlapping edits and omit speculative/nonexistent matches.
- Reading pi-durable's SQLite from a test: text columns such as `submissions.request_id` and `documents.kind` hold JSON (`'"m1"'`, not `'m1'`). And `createConversation` with `conversations: "root"` returns the root only the first time; a test channel must keep the id it got, or each message lands in a new conversation.
- workerd lane: `evictDurableObject` hangs while an alarm event is still driving a run, and `abortAllDurableObjects()` during an in-flight event crashes the Vitest pool. To evict mid-run, fake `Date` a day ahead (alarms then do not fire on their own), fire each alarm with `runDurableObjectAlarm`, and evict between two alarms.
- The docs and comments write `"typing…"` with U+2026 inside the quotes: an edit's oldText that crosses such a line must copy it exactly (it never ends at `"typing`); for a long header with one, replace by indices in `js_exec` instead.
- In an edit's oldText/newText, write non-ASCII characters literally (`§`, `⭐`, `…`), never as `\u00a7`-style escapes: an escape matches nothing (or lands literally in the file), and a garbled oldText can still match a nearby span loosely and replace it. After any surprising "replaced", reread the block.
- In edit-tool text, write non-ASCII characters (`…`, `→`) literally, never as a doubly escaped `\\u2026`: that lands in the file as the six characters `\u2026`. After editing docs, `rg 'u20[0-9a-f]{2}'` the files.
- Twice in one session the edit tool still wrote `\u00a7` as six characters despite the lessons above. For text with `§` or `…`, write the edit from `js_exec` (`String.fromCharCode(0xa7)`, a unique-match check before replacing), then `rg 'u00a7|u20[0-9a-f]{2}'` the files.
- Other agents may work in this same checkout. Touch only files you created or were asked to change, and commit by explicit paths (`git add <your paths>`), never `git add -A` or `git commit -a`: once that swept another agent's draft into a commit.
- Taking over a worktree with changes already staged (a previous agent's `git rm`): a plain `git commit` after `git add <paths>` commits everything staged, and once swept a staged deletion into an unrelated commit. Run `git diff --cached --stat` before every commit, or commit with `git commit <paths>`.
- Working in a separate worktree (`../pikit-<branch>`): give the edit, write and read tools absolute paths into it. A relative path resolves against the session's cwd, the main checkout, where another agent may be working (it once wrote there).
- wrangler behaves differently when it detects an AI agent running it (`detectAgent()`): with no `name` in the config it names the Worker after the project only for an agent, and fails for a person or on CI. Pass `--name` (as `pikit up` does), and reproduce a CI failure with a clean environment: `env -i PATH="$PATH" HOME="$HOME" CI=true <command>`.
- pikit is unreleased: never add backward compatibility (aliases, old-format readers, migrations from earlier schemas, "start fresh" handling for old data). Rename and change freely; only provider names (Cloudflare, Docker…) stay as they are, because that is where it deploys.

- The user's Cloudflare test bot is `/Users/alex/Projects/Personal/pikit-telegram-cloudflare`, deployed as the Worker `pikit-telegram-bot-dash` (its `wrangler.jsonc` says `pikit-telegram-bot`). To ship this checkout's changes there: `bun scripts/template.ts telegram-cloudflare ../pikit-telegram-cloudflare` (regenerates it, packing `vendor/*.tgz` from `packages/`: copying files is not enough for package changes), then `npm ci` and `npx wrangler deploy --name pikit-telegram-bot-dash` there. Never `npm run deploy`: it deploys another Worker name.
- To repair a stray six-character `\u00a7` from `js_exec`, never write it as a string literal there: a `'\\u00a7'` in the code arrives unescaped (it is `§`) and matches nothing. Build it: `String.fromCharCode(92) + "u00a7"`, check the match count, replace, then `grep -c u00a7` the files.

- It happened four more times in the contracts audit, in edit and write text alike (`\u00a7`, `\u2026`): never type a `\u` escape in any tool's text, not even in JSON. Type the character itself (`§`, `…`), or keep the text ASCII ("...", "SPEC 3.3"), and `rg 'u00a7|u20[0-9a-f]{2}'` every file touched before committing.

# Contract rules

When adding or changing a contract in `@pikit/contracts`, a Pi-typed contract in `@pikit/pi-adapter`,
or a registry's own contract:

1. Real usage first. Add a contract, method or field only with the component that produces or
   consumes it. No speculative generality.
2. Right layer. Shared vocabulary in `@pikit/contracts`; Pi's shapes in the adapter; a feature's own
   contract with its defining component; nothing domain-specific in `@pikit/core`. Platform handles
   (`WORKERS_HOST`) live behind their own subpath.
3. Depend on the narrowest contract that states the intent. Never reach for a lower-level capability
   or duplicate config that a contract already carries (execution-do pushes to `proposals.remote()`,
   with its `branchPrefix`, never to `github` with a prefix of its own).
4. Guarantees, not policy. Contracts state observable guarantees; components choose policy. Shared
   helpers implement protocol, with policy passed in.
5. Every stated invariant is enforced in one shared place (the helper, the provider entrypoint) and
   covered by a test. A rule only written in a comment is a bug (the `dashboard:` request ids were
   "never" used by channels until `admitInbound` refused them).
6. Trace the whole flow. Every supported field survives normalization, dispatch, persistence and
   delivery, or the contract says it does not.
7. Prove it. A runner-independent conformance suite checks the public behaviour, with negative cases
   for authorization, approval gates, data loss and duplicates. Fixtures never bypass a guarantee for
   every case (an `override` on every approval hid `checks_failing`). Check a new case catches a
   broken provider (mutate it, see the case fail, restore). Run it on a real provider of each
   supported target (workerd for `durable`).
8. Stability needs two independent providers passing the suite (or SPEC's decision for
   project-provided contracts). One provider on two targets is not two.
   The runtime's contracts are the exception: Pi is their only provider, for good (SPEC §3.3).
   Never plan, propose or design for a second agent runtime.
9. Update exports, the capability catalogue (`packages/cli/src/registry/capabilities.ts`),
   `docs/contracts.md`, SPEC and every affected README in the same change, then `bun run registry
   generate` and `validate`; report what the tests do not cover.

# Downloaded references

- `/Users/alex/Projects/Personal/pi` — Pi monorepo (`earendil-works/pi`); read `origin/main` (v1.1.0: `packages/durable`, `packages/chord`, `packages/server`) after `git fetch`, the local `main` checkout is stale.
- `/Users/alex/Projects/Personal/beautiful-ui` — Beautiful UI (`slev12397/beautiful-ui`, MIT): the primitives and the harness the dashboard's look is ported from (`components/primitives`, `components/atoms`, `components/site/IceCreamHarness.tsx`, `app/globals.css`); live at https://www.beautifului.dev/harness. Its `SidebarNav` icons (`@central-icons-react`) are paid: never install them.
- `/Users/alex/Projects/Personal/comark` — Comark (`comarkdown/comark`, MIT), the dashboard's markdown engine (`comark`, `@comark/react`, pinned 0.7.0): `docs/content/3.rendering/5.react.md`, `packages/comark-react/src/components`. `<Markdown>` is an async (server) component: in the dashboard parse with `parseMarkdown` and render `MarkdownDocument`.
- `/Users/alex/Projects/Personal/shadcn-ui` — shadcn CLI and registry (sparse: `packages/shadcn`, `packages/registry`, `apps/v4/content/docs/registry`), checked at 4.21.1.

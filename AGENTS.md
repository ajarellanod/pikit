# Maintenance lessons

- Bun 1.4.2 on macOS identifies stdin redirected from `/dev/tty` as a terminal but never reads its keystrokes. In `curl | sh` installers, reopen the actual terminal device for Bun. Obtain it with `tty` on a saved stdout descriptor: inside command substitution, stdout is already a pipe, so `$(tty <&1)` does not find the terminal. Test the installer through a pipe in a real PTY, not only the CLI directly.
- Preset loading lives in `packages/cli/src/project/registry-source.ts`; validation is in `packages/cli/src/registry/commands.ts`. There is no `registry/presets.ts` or `src/registry-source.ts`: locate files before reading them.
- When the user asks for no agents, finish the work in the main session; do not launch or resume subagents. Stop any outstanding delegated edits before taking over their files.
- Preset integration tests that repeatedly validate the full registry (all channel/feature combinations and dashboard providers) need an explicit timeout, not Bun's 5-second unit-test default.
- With the dashboard installed, model requests include background conversation titles. E2e tests must distinguish those completions from agent runs, and wait for durable delivery receipts before restarting a Worker.

- Locate guessed documentation/source filenames before reading them: `packages/contracts` and `packages/pi-adapter` have no package-local README; the dashboard's HTTP client is `registry/dashboard/files/src/lib/api.ts`, not `lib/admin.ts`. Generated projects use `src/dashboard/src/lib/api.ts`; list their views instead of assuming `conversations/home.tsx` exists.
- Locate files even when source comments name them: `packages/pi-adapter/src/skills.ts` does not exist (the runtime loader is in `agent.ts`), and the `features/skills-catalog.md` link in `contracts/src/skill.ts` is stale. Use `find` or `rg --files` before reading.
- A listener on TCP 9222 does not prove a CDP endpoint is available: check `/json/version` before attaching agent-browser. Chrome's remote-debugging mode may need browser-use's connection flow instead.
- `wrangler deployments list --json` lists deployments oldest first in the current CLI: select the greatest `created_on`, not element zero, to record the active or rollback version; verify the active version against `/health`.

- The boundary import scanner treats strings and regexes in tests that contain `import ... from` as actual imports, even inside fixture readers. Avoid putting that phrase in test helper source; use file/path fragments instead.

- External-registry fixtures must satisfy the complete `ManifestSchema`, including the required `optional.capabilities` and adapter range when depended on, before exercising another validation failure.
- Failed-install rollback tests must explicitly assert the unfinished-operation marker, then compare the other restored files; the marker intentionally survives because `node_modules` is not restored.
- Validation worktree dependency links must remap workspace source directories only, never local `node_modules` directories (otherwise `.bin/vitest` can link to itself).
- For files shared with a background agent, reread the exact current block before editing. Every replacement must be unique; merge overlapping edits and omit speculative/nonexistent matches.
- Reading pi-durable's SQLite from a test: text columns such as `runtime_pi_submissions.request_id` and `runtime_pi_documents.kind` hold JSON (`'"m1"'`, not `'m1'`). And `createConversation` with `conversations: "root"` returns the root only the first time; a test channel must keep the id it got, or each message lands in a new conversation.
- workerd lane: `evictDurableObject` hangs while an alarm event is still driving a run, and `abortAllDurableObjects()` during an in-flight event crashes the Vitest pool. To evict mid-run, fake `Date` a day ahead (alarms then do not fire on their own), fire each alarm with `runDurableObjectAlarm`, and evict between two alarms.
- The docs and comments write `"typing…"` with U+2026 inside the quotes: an edit's oldText that crosses such a line must copy it exactly (it never ends at `"typing`); for a long header with one, replace by indices in `js_exec` instead.
- In an edit's oldText/newText, write non-ASCII characters literally (`§`, `⭐`, `…`), never as `\u00a7`-style escapes: an escape matches nothing (or lands literally in the file), and a garbled oldText can still match a nearby span loosely and replace it. After any surprising "replaced", reread the block.
- In edit-tool text, write non-ASCII characters (`…`, `→`) literally, never as a doubly escaped `\\u2026`: that lands in the file as the six characters `\u2026`. After editing docs, `rg 'u20[0-9a-f]{2}'` the files.
- Twice in one session the edit tool still wrote `\u00a7` as six characters despite the lessons above. For text with `§` or `…`, write the edit from `js_exec` (`String.fromCharCode(0xa7)`, a unique-match check before replacing), then `rg 'u00a7|u20[0-9a-f]{2}'` the files.
- Other agents may work in this same checkout. Touch only files you created or were asked to change, and commit by explicit paths (`git add <your paths>`), never `git add -A` or `git commit -a`: once that swept another agent's draft into a commit.
- Taking over a worktree with changes already staged (a previous agent's `git rm`): a plain `git commit` after `git add <paths>` commits everything staged, and once swept a staged deletion into an unrelated commit. Run `git diff --cached --stat` before every commit, or commit with `git commit <paths>`.
- Working in a separate worktree (`../pikit-<branch>`): give the edit, write and read tools absolute paths into it. A relative path resolves against the session's cwd, the main checkout, where another agent may be working (it once wrote there).
- wrangler behaves differently when it detects an AI agent running it (`detectAgent()`): with no `name` in the config it names the Worker after the project only for an agent, and fails for a person or on CI. Pass `--name` (as `pikit up` does), and reproduce a CI failure with a clean environment: `env -i PATH="$PATH" HOME="$HOME" CI=true <command>`.
- pikit 0.0.x promises no compatibility: never add backward compatibility (aliases, old-format readers, migrations from earlier schemas, "start fresh" handling for old data). Rename and change freely; only provider names (Cloudflare, Docker…) stay as they are, because that is where it deploys.

- The user's Cloudflare test bot is `/Users/alex/Projects/Personal/pikit-telegram-cloudflare`, deployed as the Worker `pikit-telegram-bot` (the name in its `wrangler.jsonc`; it holds the secrets). To ship this checkout's changes there: `bun scripts/template.ts telegram-cloudflare ../pikit-telegram-cloudflare` (regenerates it, packing `vendor/*.tgz` from `packages/`: copying files is not enough for package changes), then `npm ci` and `npm run deploy` there (waits for `/health`, rolls back a version that does not start, sets the webhook). Never `wrangler deploy --name <another name>`: a new name creates an empty Worker with no secrets (`pikit-telegram-bot-dash` was one, deleted). Before deploying, `npx wrangler secret list --name <name>` shows whether it is the real one.
- When other agents have uncommitted changes in this checkout, regenerate the bot from a clean worktree of the commit to ship (`git worktree add ../pikit-deploy-<sha> <sha>`, `bun install`), not from the working tree: the template copies the registry as it is on disk.
- To repair a stray six-character `\u00a7` from `js_exec`, never write it as a string literal there: a `'\\u00a7'` in the code arrives unescaped (it is `§`) and matches nothing. Build it: `String.fromCharCode(92) + "u00a7"`, check the match count, replace, then `grep -c u00a7` the files.

- It happened four more times in the contracts audit, in edit and write text alike (`\u00a7`, `\u2026`): never type a `\u` escape in any tool's text, not even in JSON. Type the character itself (`§`, `…`), or keep the text ASCII ("...", "SPEC 3.3"), and `rg 'u00a7|u20[0-9a-f]{2}'` every file touched before committing.

- Bun 1.4.2 quirks met in channel-web's security fixes: `new Request(request, { headers })` keeps the request's own headers when the new `Headers` is empty (a dropped header survives): build from `request.url` with method, headers, body (`duplex: "half"`) and signal (`withClientAddress`). And `expect(obj).toMatchObject({ field: expect.stringMatching(...) })` overwrites `obj.field` with the matcher: match a copy (`{ ...obj }`) when the object is used afterwards.

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
   with its `branchPrefix`, never to `repo.github` with a prefix of its own).
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
10. Agent tool names are lowercase snake_case (`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`): a family shares its
    prefix (`delegate_tasks`, `schedule_list`), a lone tool reads verb_noun (`ask_user`). Never
    camelCase (`askUser` and `listSchedules` had to be renamed). `registry validate` refuses any
    other (tool-mcp's server-given names are exempt).

# Downloaded references

- `/Users/alex/Projects/Personal/pi` — Pi monorepo (`earendil-works/pi`); read the pinned tag (`git show v1.3.0:packages/durable/...`; `packages/durable`, `packages/chord`, `packages/codemode`) after `git fetch --tags`, the local `main` checkout is stale.
- `/Users/alex/Projects/Personal/beautiful-ui` — Beautiful UI (`slev12397/beautiful-ui`, MIT): the primitives and the harness the dashboard's look is ported from (`components/primitives`, `components/atoms`, `components/site/IceCreamHarness.tsx`, `app/globals.css`); live at https://www.beautifului.dev/harness. Its `SidebarNav` icons (`@central-icons-react`) are paid: never install them.
- `/Users/alex/Projects/Personal/comark` — Comark (`comarkdown/comark`, MIT), the dashboard's markdown engine (`comark`, `@comark/react`, pinned 0.7.0): `docs/content/3.rendering/5.react.md`, `packages/comark-react/src/components`. `<Markdown>` is an async (server) component: in the dashboard parse with `parseMarkdown` and render `MarkdownDocument`.
- `/Users/alex/Projects/Personal/shadcn-ui` — shadcn CLI and registry (sparse: `packages/shadcn`, `packages/registry`, `apps/v4/content/docs/registry`), checked at 4.21.1.
- `/Users/alex/Projects/Personal/better-auth` — Better Auth (`better-auth/better-auth`, MIT), shallow clone checked out at tag v1.7.7 (detached; `main` differs): `packages/better-auth/src` (`auth/minimal.ts`, `cookies`, `api/routes`, `plugins/admin`, `plugins/generic-oauth`), `packages/core/src` (`db/adapter` = `createAdapterFactory`, `db/get-tables.ts` schema, `social-providers`, `types/init-options.ts`), `docs/content/docs/guides/create-a-db-adapter.mdx`. Researched for channel-web's end-user auth.
- `/Users/alex/Projects/Personal/rivet` — Rivet (`rivet-dev/rivet`, Apache-2.0), shallow clone at `aa8800b` (2.3.27): researched for `features/deployment-rivet.md`. Actor docs in `docs/actors/content/docs` (`limits.mdx`, `lifecycle.mdx`, `sqlite.mdx`, `schedule.mdx`), self-hosting in `self-host/` (`control-plane/{vm,kubernetes}`, `workers/docker-compose`).
- `/Users/alex/Projects/Personal/coss` — coss ui (`cosscom/coss`, **AGPL-3.0**: never copy its code into pikit; port the look only: sizes, radii, borders, shadows, contrast), sparse checkout of `packages/ui/src/components` (`input.tsx`, `button.tsx`, `switch.tsx`, `badge.tsx`, `field.tsx`, `select.tsx`): the reference for the dashboard's and the chat's controls (32px inputs and buttons, `rounded-lg`, outline secondary, a dark primary).
- `/Users/alex/Projects/Personal/gondolin` — Gondolin (`earendil-works/gondolin`, Apache-2.0), checked out at tag v0.13.0 (detached; npm `@earendil-works/gondolin` 0.13.0, execution-gondolin's): `docs/sdk-vm.md`, `docs/vfs.md`, `docs/secrets.md`, `docs/network.md`, `docs/limitations.md`, `host/examples/pi-gondolin.ts`, `guest/image/init` (mount order), `guest/src/sandboxd/main.zig` (exec: no process group, no kill).
- `/Users/alex/Projects/Personal/celld-ref` — celld (`denoland/celld`, Apache-2.0, beta), shallow clone at v0.6.2: `docs/README.md` (operating a fleet, env vars, deploy/poll, shutdown), `docs/guarantees.md`, `crates/celld/deploy.rs` (config keys it accepts, rules, `vars`), `fleet.rs` (`deploy --json`, `diagnose`), `protocol.rs` (`DeployPointer`: what deployment-celld's rollback writes back), `dev.rs` (`.dev.vars`, watch). A local darwin `celld` and `rustfs` for end-to-end checks go in the worktree's `.tools/` (gitignored).

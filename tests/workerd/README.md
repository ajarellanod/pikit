# The workerd lane

The Cloudflare components' suites, run inside workerd (Cloudflare's runtime, locally, no account),
on a real SQLite-backed Durable Object (SPEC §4, C5). `bun test` runs the same components against
doubles; this lane is the proof on the runtime they ship to.

```sh
bun run test:workerd     # from the repository root: `wrangler types`, the typecheck, then the suites
```

It runs offline. It needs Node >= 22 on the `PATH` (Vitest and wrangler run on Node) as well as Bun,
which installs it (`bun install` at the root: this directory is a workspace).

## What runs

| File | Suites |
|---|---|
| `test/storage-do.workerd.ts` | `storage.sql` on `storage-do`; `storage.kv` on `storage-kv-sql` over `storage-do`; the start as `deployment-cloudflare` does it; the SQL limits `storage-do`'s README states |
| `test/submissions-sql.workerd.ts` | `agent.submissions` with its `answers` feed, pruning and restarts, on `submissions-sql` over `storage-do` |
| `test/secrets-cloudflare.workerd.ts` | `secrets` on `secrets-cloudflare`, over the Worker's real `env` |
| `test/deployment-cloudflare.workerd.ts` | `deployment-cloudflare`'s entrypoint: its `Conversation` class (exported by `src/worker.ts`, over the small Apps of `src/deployment.ts`) and its Worker `fetch`: `/health`, `WORKERS_HOST`, `deliver` and the alarm reaching their handlers, eviction, a failed start resetting the object |

Each case of a storage suite runs in a Durable Object of its own (`runInDurableObject` on a new id),
and its components get that object in `WORKERS_HOST` as `deployment-cloudflare`'s entrypoint will
put it (`test/host.ts`): the suites start their own apps, so the host is given with `withWorkersHost`
from `@pikit/contracts/testing`. A test in each file also starts an app with the host in
`app.start`'s context, the entrypoint's own way.

## How

- **Vitest with `@cloudflare/vitest-plugin`** (Cloudflare's Workers integration, formerly
  `@cloudflare/vitest-pool-workers`), `wrangler.jsonc` for the Worker: one class, `TestObject`, in
  `new_sqlite_classes`. Versions are pinned exactly in `package.json`; the plugin pins its wrangler
  and miniflare.
- **Files end in `.workerd.ts`**, not `.test.ts`, so the root `bun test` never picks them up.
- **The components are imported from `registry/`**, as TypeScript source; Vite compiles them.
- **The typecheck** compiles the lane, and every file it imports (components, contracts, kernel),
  against Workers' runtime types from `wrangler types` (`worker-configuration.d.ts`, generated, not
  committed): a component that reached for a Bun or Node global would fail here.

## Adding a suite

A new Cloudflare component, or a neutral one that should run there: add a `test/<name>.workerd.ts`
that runs its conformance suites with `inObject` (for storage) or directly, and a row above.

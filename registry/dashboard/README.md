# The dashboard template

What `pikit new --ui` and `pikit ui on` copy into a project's `src/dashboard/` (SPEC §5): a shadcn/ui
project of its own (Vite, React, Tailwind v4) over the admin API that the `admin-api` component
serves. It is not a component: a project has a UI or not, and `src/dashboard/` is all that says so.
`files/README.md` is the project's guide to it.

## What it needs: `dashboard.json`

The components a project with this dashboard needs are this registry's to say, in
`dashboard.json` beside `files/` (`DashboardManifestSchema`,
[dashboard-manifest.ts](../../packages/cli/src/project/dashboard-manifest.ts)); the CLI keeps no list
of its own:

```json
{
  "components": ["admin-auth-token", "admin-api", "settings-store"],
  "defaultFor": { "admin-auth-token": "admin.auth", "settings-store": "settings" }
}
```

- **`components`**, in the order `pikit ui on` (and `pikit new --ui`, or a preset feature with
  `ui: true`) installs them, providers first: `admin-auth-token` (who is an operator), `admin-api`
  (the API the dashboard reads, and its built files), `settings-store` (the Settings dialog is the
  dashboard's, and the sections of installed components, runtime-pi's Agents and router-basic's
  Routing first, read and write through `settings`).
- **`defaultFor`**: the capability a default stands for. It is installed only when the project's Apps
  lack that capability; another provider of it in every App keeps its place, and one in some Apps
  only, or a composition that cannot be described, is refused rather than guessed. `admin-api` has no
  entry: it is always needed.
- `registry validate` refuses a descriptor of another shape, a component this registry does not
  have or that does not run on every target, and a default that is not one of `components` or does
  not provide its capability. `pikit ui off` removes only what the dashboard installed, from
  `pikit.json`, without reading this file.

## Work on it here

```sh
cd registry/dashboard/files
bun install
bun run dev        # http://localhost:5173/admin/, the API of an app on PIKIT_URL (default http://localhost:3000)
bun run build      # tsc and the static files in dist/ (not committed)
```

The components' views (`view` in a `component.json`) live in their components; they compile with
the template's packages:

```sh
bun scripts/dashboard-build.ts    # builds a copy of the template with every component's view in it
bun scripts/ui-registry.ts generate   # publishes the template's pieces and views, and the components' views, as @pikit items
```

An app to run it against: any project with `admin-api` and `admin-auth-token`, or the sample's
composition (`samples/http/test/sample.ts`) with both added.

## Keep

- `src/lib/admin-api.ts` identical to `registry/components/admin-api/files/src/pikit/admin-api/api.ts`
  (`scripts/dashboard.test.ts` checks it).
- npm packages pinned to exact versions, with `bun.lock` committed: every project builds the same
  dashboard.
- Its look is Beautiful UI's harness (https://www.beautifului.dev/harness; the source is a
  downloaded reference, see `AGENTS.md`): its primitives copied into `src/components/bui/` and fed by
  real data (no demo rows, no scripted timers), its tokens in `src/index.css` with shadcn's variables
  mapped onto them. Primitives copied from shadcn/ui (`bunx shadcn@latest add <name>` here) or
  Beautiful UI are attributed in `NOTICE`.
- Free icon sets only: iconoir for the dashboard's own, lucide inside shadcn's primitives. Never
  Beautiful UI's `@central-icons-react` (paid).
- No inline script and nothing from another origin (the CSP): fonts are bundled
  (`@fontsource-variable/*`), every asset is a file (`assetsInlineLimit: 0`), and the theme is set
  before the first paint by `public/theme.js`.

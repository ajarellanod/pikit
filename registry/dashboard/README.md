# The dashboard template

What `pikit new --ui` and `pikit ui on` copy into a project's `src/dashboard/` (SPEC §5): a shadcn/ui
project of its own (Vite, React, Tailwind v4) over the admin API that the `admin-api` component
serves. It is not a component: a project has a UI or not, and `src/dashboard/` is all that says so.
`files/README.md` is the project's guide to it.

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

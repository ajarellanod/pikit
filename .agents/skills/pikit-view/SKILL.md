---
name: pikit-view
description: Add a view to a pikit project's dashboard (src/dashboard/, a shadcn/ui project), with the admin API routes it reads, for the project alone or as part of a component others can `pikit add`. Use when the user wants to see or operate something of their pikit assistant in the dashboard.
---

# Add a view to the dashboard

The dashboard (SPEC §5) is a project's choice: `src/dashboard/` exists when the project has a UI
(`pikit ui on`). It is a shadcn/ui project of its own (Vite, React, Tailwind v4), served at
`/admin/` by the `admin-api` component, and it reads only the admin API (`/admin/api/*`), every call
with the operator's token. A view is a folder of `src/dashboard/src/views/`, found when the dashboard
is built, and shown only while the capabilities it declares are installed.

## 0. Know what is there

```sh
cat src/dashboard/README.md         # the dashboard's layout: views, primitives, lib
ls src/dashboard/src/views/          # the views it has (each folder is one)
pikit doctor                         # what the App provides: what a view may require
```

The base views are the references: `conversations` (a list, a live page over server-sent events,
actions) and `composition` (one read, tabs). Read `src/dashboard/src/lib/api.ts` (`api`, `post`,
`useApi`, `follow`), `views.ts` (`defineView`) and `router.tsx` (`Link`, `navigate`).

## 1. Decide where it lives

| The view is | It lives in | Its data comes from |
|---|---|---|
| The project's own | `src/dashboard/src/views/<id>/` | admin-api's routes, or a project component's routes (`src/extensions/`) |
| Part of a component others install | the component's `view/` folder (`"view": "view"` in `component.json`) | the component's own routes |

A component's view is copied by `pikit add` to `src/dashboard/src/views/<component name>/` when the
project has a UI (and by `pikit ui on` later), recorded as the component's files: `pikit upgrade`
merges it, `pikit remove` takes it away. Its `id` is the component's name.

## 2. The routes it reads

A view reads only `/admin/api/*`. New data means a new route, in the component that owns the data
(the pattern `health-registry` follows):

```ts
const auth = pikit.useOptional("admin.auth");
pikit.provideKeyed("http.route", "GET /admin/api/<component>/<what>", async (request, ctx) => {
  const verifier = auth.get();
  if (verifier === undefined || (await verifier.verify(request, ctx)) === undefined) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": 'Bearer realm="pikit"' } });
  }
  return Response.json(/* JSON, typed in a file the view can copy */);
});
```

- Under `/admin/api/<component>/…`, so names never clash; answers JSON, errors as `{ error, message? }`.
- Every route asks `admin.auth` first, before reading anything; never a secret, a token or more
  message text than an operator needs.
- It reads contracts and feeds, never another component's internals (P4). Actions go through the
  contract that owns them.
- Test it with doubles, as `admin-api`'s tests do (a request in, the JSON out, `401` without an
  operator).

## 3. The view

```tsx
// view/index.tsx (a component's) or src/dashboard/src/views/<id>/index.tsx (the project's)
import { HeartPulse } from "lucide-react";
import { defineView } from "@/lib/views";
import { HealthPage } from "./health";

export default defineView({
  id: "health-registry",          // the folder's name; a component's view is named after the component
  title: "Health",
  icon: HeartPulse,               // lucide icons only: no paid icon sets
  requires: ["health"],           // capabilities that must be provided for it to show
  order: 20,
  pages: [{ path: "/health-registry", component: HealthPage }],
});
```

- Pages live under `/<id>`; `:name` segments are parameters (`/memory/:person`).
- Read with `useApi<T>("/<component>/<what>", everyMs?)`; act with `post(...)`; follow live data
  with `follow(path, onEvent, signal)` (server-sent events read with `fetch`, so the token goes too).
- Build it from the primitives in `src/components/ui/` and the pieces in `src/components/pikit/`
  (`ErrorNote`, `MessageView`). Need another primitive: `bunx shadcn@latest add <name>` in
  `src/dashboard/`. A component's view may use only primitives the base dashboard ships, or say in its
  README which ones to add.
- Import with `@/…`; relative imports only inside the view's own folder.

## 4. Check it

```sh
cd src/dashboard && bun run typecheck && bun run build    # the view compiles and is found
pikit dev                                                # then open /admin/ and sign in
bun run dev                                              # or hot reload on :5173 against the running app
```

For a component: `pikit registry validate <registry>` checks its `view/index.tsx` defines the view
under the component's name; in the pikit repository, `bun scripts/ui-registry.ts generate` publishes
it as the shadcn item `@pikit/<component>`.

Done means: the routes' tests pass (401 first), the dashboard builds, the view appears only while
its `requires` are provided, and nothing in it shows a secret.

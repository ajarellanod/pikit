# The dashboard

The operator's view of this pikit service (SPEC §5): its conversations, one of them live (the
transcript, the answer being written, the tools running), steer, abort and reset, the cost, and what
the App is made of. It is yours: a shadcn/ui project (Vite, React, Tailwind v4) whose source you
change like any other file of the project.

It talks only to the admin API that `admin-api` serves (`/admin/api/*`, every call with the
operator's token), and admin-api serves its built files under `/admin/`.

## Run it

```sh
bun install
bun run dev        # hot reload on http://localhost:5173/admin/, the API from PIKIT_URL (default http://localhost:3000)
bun run build      # the static files in dist/, which admin-api serves at /admin/
bun run typecheck
```

`pikit up` builds it before it deploys. The token it asks for is `PIKIT_ADMIN_TOKEN` (`pikit configure
--generate PIKIT_ADMIN_TOKEN` writes one); it stays in the browser's localStorage.

## What is where

| Path | What |
|---|---|
| `src/views/<view>/index.tsx` | one view each: its pages and when it shows (below) |
| `src/components/ui/` | shadcn/ui primitives, copied and yours (`shadcn add` puts more here) |
| `src/components/pikit/` | pieces the views share: a transcript message, an error, the sign-in |
| `src/lib/api.ts` | calls to the admin API with the token, `useApi`, live events (`follow`) |
| `src/lib/admin-api.ts` | the API's JSON, typed: an identical copy of `src/pikit/admin-api/api.ts` |
| `src/lib/views.ts` | how views are found and when they show |
| `src/lib/router.tsx` | the pages under `/admin` |
| `src/app.tsx` | sign-in, the sidebar and the page the path names |

## Add a view

A view is a folder of `src/views/`, found when the dashboard is built:

```tsx
// src/views/memory/index.tsx
import { Brain } from "lucide-react";
import { defineView } from "@/lib/views";
import { MemoryPage } from "./memory";

export default defineView({
  id: "memory",                     // the folder's name; its pages live under /memory
  title: "Memory",
  icon: Brain,
  requires: ["memory"],             // shown only while a component provides these capabilities
  pages: [{ path: "/memory", component: MemoryPage }],
});
```

Its data comes from admin routes its component registers through `http.route` (`GET
/admin/api/memory/…`, asking `admin.auth`), read with `useApi` / `api` from `@/lib/api`. A view
never reads anything else: no internals, no other origin.

More primitives: `bunx shadcn@latest add dialog` (from this folder). pikit's own pieces and views are
shadcn items too: `bunx shadcn@latest add @pikit/<item>` (`components.json` names the registry; its
list is `registry/ui/r/registry.json` in the pikit repository). A component with a view installs it
here itself (`pikit add`). The skill `pikit-view` (`.agents/skills/`) teaches an AI agent all of this.

## Notices

The primitives in `src/components/ui/` come from shadcn/ui (MIT): see `NOTICE`.

/**
 * channel-web's view: the chat's users (`users.tsx`), over the component's own routes,
 * `/admin/api/channel-web/*` (`admin-api.ts`, an identical copy of the component's). They answer only
 * with an `admin.auth` installed, so the view shows only then.
 */

import { Group } from "iconoir-react";
import { defineView } from "@/lib/views";
import { BASE, UsersPage } from "./users";

export default defineView({
  id: "channel-web",
  title: "Web users",
  icon: Group,
  requires: ["admin.auth"],
  order: 30,
  pages: [{ path: BASE, component: UsersPage, fill: true }],
});

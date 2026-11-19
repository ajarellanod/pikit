/**
 * projects-sql's Worker half, on `durable`: `projects` for the Worker's App (channel-web's routes, the
 * dashboard's), which has no `storage.sql`, its stage of `conversation.audience` (`audience.ts`), and the
 * admin routes (`routes.ts`). Every operation is the
 * same call to the directory's or the project's object as from any other App (`projectsOver`); those
 * objects run the default export, which answers it.
 *
 * `component.json`'s `apps.worker` names this export (`worker`).
 */

import { defineComponent } from "@pikit/core";
import { audienceStage } from "@pikit/contracts";
import { AUDIENCE_SOURCE, projectsAudience } from "./audience.ts";
import { provideRoutes } from "./routes.ts";
import { projectsOver } from "./store.ts";

export const worker = defineComponent({
  name: "projects-sql-worker",
  setup(pikit) {
    const mailbox = pikit.use("actor.mailbox");
    const store = projectsOver(() => mailbox.get());
    pikit.provide("projects", store);
    pikit.pipeline("conversation.audience", audienceStage(AUDIENCE_SOURCE, projectsAudience(() => store)), { id: "projects-sql" });
    provideRoutes(pikit, () => store);
  },
});

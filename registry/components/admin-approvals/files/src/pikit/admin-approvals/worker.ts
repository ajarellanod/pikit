/**
 * admin-approvals' Worker half, on `durable`: the same routes (`provideRoutes`), served by the Worker's
 * App over approvals-sql's Worker half. Each decision is sent to the asking conversation's object,
 * whose App (the default export) dispatches it.
 *
 * `component.json`'s `apps.worker` names this export (`worker`).
 */

import { defineComponent } from "@pikit/core";
import { provideRoutes } from "./index.ts";

export const worker = defineComponent({
  name: "admin-approvals-worker",
  setup(pikit) {
    provideRoutes(pikit);
  },
});

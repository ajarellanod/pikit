/**
 * approvals-sql's Worker half, on `durable`: `approvals` for the Worker's App (admin-approvals' routes),
 * which has no `storage.sql`. Every operation is the same call to the owner object as from a
 * conversation's object (`approvalsOver`); the owner, which runs the default export, answers it.
 *
 * `component.json`'s `apps.worker` names this export (`worker`).
 */

import { defineComponent } from "@pikit/core";
import { approvalsOver } from "./index.ts";

export const worker = defineComponent({
  name: "approvals-sql-worker",
  setup(pikit) {
    const mailbox = pikit.use("actor.mailbox");
    pikit.provide("approvals", approvalsOver(() => mailbox.get()));
  },
});

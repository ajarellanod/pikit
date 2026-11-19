/**
 * conversations-directory's Worker half, on Cloudflare: `conversations.directory` for the Worker's App
 * (admin-api's and channel-web's routes), which holds no conversation and no `storage.sql`. Every call
 * is the same call to the index object (`conversations-directory:index`) as from a conversation's
 * object, whose App (the default export) answers it; a people viewer's grants are computed here, in the
 * Worker's App, where the membership providers' stages of `conversation.audience` are.
 *
 * `component.json`'s `apps.worker` names this export (`worker`).
 */

import { defineComponent } from "@pikit/core";
import { directoryOver, remoteBackend } from "./client.ts";

export const worker = defineComponent({
  name: "conversations-directory-worker",
  setup(pikit) {
    const mailbox = pikit.use("actor.mailbox");
    const backend = remoteBackend(() => mailbox.get());
    pikit.provide(
      "conversations.directory",
      directoryOver(() => backend),
    );
  },
});

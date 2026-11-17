/**
 * tool-space-files' Worker half, on `durable`: `space.files` for the Worker's App, where channel-web's
 * upload and download routes run (an upload crosses the Worker only, never a conversation's object). Every
 * operation is the same call to the space's object as from a conversation's object (`spaceFilesOver`);
 * the object, which runs the default export, answers it and holds the limits (it gives them with `status`,
 * so this half has no config). The bytes are written and read here: `storage.blob` must be one every App
 * reaches (storage-blob-s3, which is in both Apps), never a conversation object's own.
 *
 * `component.json`'s `apps.worker` names this export (`worker`).
 */

import { defineComponent } from "@pikit/core";
import type { BlobStore } from "@pikit/contracts";
import { spaceFilesOver } from "./files.ts";

export const worker = defineComponent({
  name: "tool-space-files-worker",
  setup(pikit) {
    const mailbox = pikit.use("actor.mailbox");
    const blob = pikit.use("storage.blob");
    const convert = pikit.useOptional("document.convert");
    let blobs: BlobStore | undefined;

    pikit.provide(
      "space.files",
      spaceFilesOver({
        call: (key, type, message, ctx) => mailbox.get().call(key, type, message, ctx),
        blobs: () => {
          if (blobs === undefined) throw new Error("tool-space-files-worker: used while the App is not running");
          return blobs;
        },
        convert: () => convert.get(),
      }),
    );

    return {
      start() {
        blobs = blob.get().namespace("tool-space-files");
      },
      stop() {
        blobs = undefined;
      },
    };
  },
});

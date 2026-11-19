/** conversations-directory's config (its default export's; the Worker half takes none). */

import Type, { type Static } from "typebox";

export const Config = Type.Object({
  /**
   * The model that titles conversations (`provider/modelId`, one of the App's providers), through
   * `model.complete`. Absent: each conversation's agent's model. Read where runs settle: on Cloudflare
   * each conversation's object.
   */
  titleModel: Type.Optional(Type.String({ pattern: "^[^/\\s]+/\\S+$", description: "provider/modelId of the model that titles conversations; absent, each conversation's agent's model" })),
  /** How many conversations the start's backfill found (made before the directory, or whose events were missed) a start titles, the most recently active first. */
  retitleAtStart: Type.Integer({ minimum: 0, default: 20 }),
});

export type ConversationsDirectoryConfig = Static<typeof Config>;

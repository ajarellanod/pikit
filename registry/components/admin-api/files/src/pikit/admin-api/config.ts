/** admin-api's config, the same for both halves (`admin-api`, and `admin-api-worker` on Cloudflare). */

import Type from "typebox";

export const Config = Type.Object({
  /** How often an idle event stream gets a comment, so that nothing between closes it. */
  heartbeatMs: Type.Integer({ minimum: 1000, default: 15_000 }),
});

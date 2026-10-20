/**
 * The service's process: `bun --env-file=.env src/pikit/deployment-local/main.ts`, which systemd or
 * launchd runs in the project's directory (pikit.service, pikit.plist), and `pikit dev` runs with
 * `--watch`. It runs the project's composition root, `pikit.config.ts`, through the entrypoint.
 * Change the deadlines, the logger or where server-bun listens here, in `local`'s and
 * `runEntrypoint`'s options.
 */

// @ts-ignore: in the registry this file has no project around it. Installed at
// `src/pikit/deployment-local/`, the import resolves to the project's root and is type-checked.
import definition from "../../../pikit.config.ts";
import { runEntrypoint } from "./entrypoint.ts";
import { local } from "./local.ts";

const { app, options } = local(definition);
await runEntrypoint(app, options);

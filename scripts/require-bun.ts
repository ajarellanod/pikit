/**
 * Fails fast on a Bun older than pikit supports. Loaded by `bunfig.toml` before every
 * `bun run` and `bun test`, because Bun ignores `engines` in package.json.
 *
 * Why 1.4.0: older Bun never fires an `AbortSignal.timeout()` whose last abort listener was
 * removed (oven-sh/bun#37666). The core's lifecycle deadlines remove their listeners, so on
 * older Bun a stop deadline would hang instead of firing.
 */
const MINIMUM = "1.4.0";

if (!Bun.semver.satisfies(Bun.version, `>=${MINIMUM}`)) {
  throw new Error(`pikit requires Bun >= ${MINIMUM}, found ${Bun.version}. Run \`bun upgrade\`.`);
}

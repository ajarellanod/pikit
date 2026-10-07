# Templates: "Deploy to Cloudflare" buttons

A template is a public repository that a [Deploy to Cloudflare
button](https://developers.cloudflare.com/workers/platform/deploy-buttons/) clones into its user's
GitHub, then builds and deploys with Workers Builds, with no pikit CLI anywhere. pikit makes its
templates itself, from its own `pikit new`, so a template is always a normal pikit project of the
commit it was made from.

| Template | Made from | Published at |
|---|---|---|
| `telegram-cloudflare` | `pikit new pikit-telegram-bot --target durable --preset telegram-cloudflare --ui` | `github.com/ajarellanod/pikit-telegram-cloudflare` |

## Making one

```sh
bun scripts/template.ts telegram-cloudflare ../pikit-telegram-cloudflare [--repo https://github.com/<owner>/<repo>]
```

It needs what `pikit new` needs (Bun >= 1.4, the npm registry) and npm. It:

1. runs this checkout's `pikit new` with the template's target and preset in a staging directory, with
   no terminal, so nothing is asked;
2. adjusts the project (`adjust` in `scripts/template.ts`):
   - `wrangler.jsonc` gets the Worker's `name` (`pikit-telegram-bot`), which the button's setup page
     lets its user change. Workers Builds runs wrangler without `--name`, and `deployment-cloudflare`'s
     commands use that name too, so `pikit up` from a clone deploys the same Worker;
   - `wrangler.jsonc`'s `build.command`, which builds the dashboard before every bundle, runs Bun
     through npx (`npx -y bun@<template's bun>`, the installer's pin): Workers Builds' own Bun
     (1.2.15) cannot read the dashboard's `bun.lock`, and a template cannot set the build's
     `BUN_VERSION`. The dashboard's packages and build (`src/dashboard/node_modules`, `dist`) are left
     out: the build makes them;
   - `.dev.vars.example` lists the secrets the button asks for (no values), and `package.json`'s
     `cloudflare.bindings` describes each one, and the `CONVERSATION` Durable Object, for the setup
     page. pikit's `.env.example` is removed, so there is one list: it also names
     `TELEGRAM_ALLOWED_USERS`, which the button does not ask (the owner logs in with the password
     instead);
   - `package.json` gets a `description` and the `deploy` script, which the button pre-fills as the
     deploy command: `wrangler deploy | node src/pikit/channel-telegram-webhook/setup-webhook.mjs`. No
     `build` script: wrangler bundles;
   - `bun.lock` is replaced by npm's `package-lock.json` (below), and `.gitignore` un-ignores
     `.dev.vars.example` and ignores the project's `/bun.lock` (the dashboard's stays);
   - the README is `templates/<template>/README.md`, with the button's link, the secrets' table
     (from the same descriptions) and the Worker's name filled in;
3. makes the output directory hold exactly those files, keeping its `.git` and `node_modules`.

**Deterministic and idempotent.** The same pikit commit makes the same files, and running it again on
the same directory changes nothing (it says how many files it wrote and deleted). A kit tarball the
directory already has under the same name (the name carries a hash of its files) is kept byte for
byte, and npm starts from the directory's `package-lock.json`, so versions resolved once stay until
`package.json` changes. `pikit.json` records the pikit commit it was made from, so every pikit commit
changes it.

The template's secrets, descriptions, name, `deploy` script and repository are `TEMPLATES` in
`scripts/template.ts`; its README is `templates/<template>/README.md` (`{{DEPLOY_URL}}`, `{{NAME}}`,
`{{SECRETS}}`). Change them there, never in the published repository.

## Decisions

**npm's lockfile, not Bun's.** Workers Builds picks the package manager by lockfile, and runs its own
Bun (1.2.15 by default), older than the 1.4 pikit needs; its detection of the text `bun.lock` is
reported to fall back to npm at times. A pikit project installs with npm as it is: the kit's tarballs
in `vendor/` are `file:` dependencies with `overrides`, which npm supports, and the only native builds
(`just-bash`'s compressors) are optional dependencies, which npm skips when they fail. The build needs only Node and
wrangler. So the template ships `package-lock.json`, the lockfile every build image reads the same
way, and needs no `SKIP_DEPENDENCY_INSTALL` or custom install command. Bun still runs its tests (`bun
test`) and pikit's CLI; `bun.lock` is ignored so it never makes Workers Builds switch. After `pikit add`
in a clone, run `npm install` and commit `package-lock.json`.

**How the owner gets in, without `pikit configure`.** Nobody knows their Telegram user id before
deploying, so the form asks for a password (`TELEGRAM_PASSWORD`) instead of `TELEGRAM_ALLOWED_USERS`:
1. you choose the password in the form; 2. you deploy; 3. you send `/login <password>` to your bot;
4. that chat stays allowed; 5. whoever knows the password can log in too; 6. changing the password
logs everyone out. The template's README says so for its users ("Your bot's password"), and
`channel-telegram-webhook`'s README has the details ("The password").

**How the webhook gets registered, without `pikit up`.** The `deploy` script pipes `wrangler deploy`
into `setup-webhook.mjs`, which reads the workers.dev URL and version from wrangler's output, waits
until `/health` answers from that version, and calls `GET /telegram/setup`: the Worker sets its webhook
with its own secret (the build has none). Besides, each version checks its webhook on its first HTTPS
request (`channel-telegram-webhook`'s README, "Registering the webhook"), and the template's README
tells its user to open `/telegram/setup` if the build did not.

## Checking one

```sh
bun test scripts/template.test.ts                 # the adjustments, offline
PIKIT_E2E=1 bun test scripts/template.test.ts     # and the whole template, as Workers Builds takes it
```

The second makes the template twice (the second run must change nothing), checks that no file names
this machine or looks like a token, then, in a clean copy: `npm ci` with an empty cache, `wrangler
deploy --dry-run` (the bundle's gzip size, under the Free plan's 3 MB), and `wrangler dev` with the
button's secrets in `.dev.vars` against a local fake Telegram and fake OpenRouter. There the `deploy`
script, run by a shell with a fake `wrangler deploy` that prints the local Worker's URL, has the Worker
register its webhook, and the owner, whom nobody listed, logs in with `/login <password>` and is
answered; then the dashboard (built by wrangler's `build.command`) serves its page at `/admin/`, and
its API answers only with the button's `PIKIT_ADMIN_TOKEN` and lists the owner's chat.
Nothing is deployed and every key is a dummy. It needs Node >= 22 and npm.

## Publishing

The first time, by hand: make the template, `git init -b main`, commit, create the public repository
(`ajarellanod/pikit-telegram-cloudflare`) and push. The button's link is
`https://deploy.workers.cloudflare.com/?url=https://github.com/ajarellanod/pikit-telegram-cloudflare`.

Then `.github/workflows/template.yml` can keep it in step with pikit's `main`: on every push there (or
by hand), it runs the end-to-end check above, regenerates the template into a checkout of its
repository and pushes a commit when something changed ("pikit <commit>: regenerate"). It is off: it
runs only once this repository has
- the variable `PIKIT_TEMPLATE_REPO` (`ajarellanod/pikit-telegram-cloudflare`); without it the job is
  skipped and no runner starts;
- the secret `PIKIT_TEMPLATE_TOKEN`: a fine-grained token with "Contents: read and write" on that
  repository only. Without it the job stops at its first step, saying so.

Every user's copy deploys from their own repository: a push to the template changes nobody's bot.

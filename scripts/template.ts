/**
 * `bun scripts/template.ts <template> <outDir> [--repo <url>]`: a "Deploy to Cloudflare" template,
 * made by pikit itself (templates/README.md).
 *
 * 1. `pikit new <name> --target <target> --preset <preset> [--ui]` in a staging directory, with this
 *    checkout's CLI, registry and kit, exactly as a person would (no terminal: nothing is asked);
 * 2. the template's adjustments (`adjust`): the Worker's `name` in `wrangler.jsonc`, and the Bun its
 *    dashboard's build runs with (`pinBun`), the secrets the
 *    button asks for in `.dev.vars.example` and their descriptions in `package.json`'s
 *    `cloudflare.bindings`, the `deploy` script, npm's `package-lock.json` instead of `bun.lock`,
 *    `.gitignore`, and the template's README;
 * 3. `outDir` made equal to the staging directory (`mirror`), keeping its `.git` and `node_modules`.
 *
 * Deterministic and idempotent: the same pikit commit gives the same files, and running it again on
 * `outDir` changes nothing. The kit's tarballs already in `outDir/vendor/` under the same name (same
 * content) are kept byte for byte, and its `package-lock.json` is the starting point of npm's, so
 * versions resolved once stay until `package.json` changes.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { KIT_REPOSITORY } from "../packages/cli/src/paths.ts";

const REPO = join(import.meta.dir, "..");
const MAIN = join(REPO, "packages", "cli", "src", "main.ts");

export interface Secret {
  name: string;
  /** Markdown (the setup page renders `code`, **bold**, __italics__ and [links](…)). */
  description: string;
}

export interface Template {
  preset: string;
  target: string;
  /** Made with the dashboard (`pikit new --ui`). */
  ui: boolean;
  /** The preset's features it is made with (`pikit new --with <feature>`). */
  with: string[];
  /**
   * The Bun the dashboard's build runs with, through npx (`pinBun`): Workers Builds has an older one
   * (1.2.15) than its lockfile needs. The installer's pin (`installer/install.sh`, `BUN_PINNED`).
   */
  bun: string;
  /** The project's name: `package.json`'s, and the Worker's in `wrangler.jsonc`. */
  name: string;
  description: string;
  /** Where the template is published: the Deploy button's `url`. */
  repo: string;
  /** What the button asks for, in order, as the Worker's secrets. */
  secrets: Secret[];
  /** Variables a component declares that the button does not ask for, and why. */
  notAsked: Record<string, string>;
  /** `wrangler.jsonc`'s bindings, described on the setup page. */
  bindings: Record<string, string>;
  /** `package.json`'s `deploy` script: Workers Builds' deploy command. */
  deploy: string;
}

export const TEMPLATES: Record<string, Template> = {
  "telegram-cloudflare": {
    preset: "telegram-cloudflare",
    target: "durable",
    ui: true,
    // Self-improvement, dormant (the group admin-proposals and github-app): connected after deploying,
    // from the dashboard's Settings → GitHub, never in the form.
    with: ["admin-proposals"],
    bun: "1.4.2",
    name: "pikit-telegram-bot",
    description: "An AI agent in Telegram, on Cloudflare: a pikit project.",
    repo: "https://github.com/ajarellanod/pikit-telegram-cloudflare",
    secrets: [
      {
        name: "TELEGRAM_BOT_TOKEN",
        description:
          "Your bot's token. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, choose a name and a username ending in `bot`, and paste the token it answers (two parts separated by `:`).",
      },
      {
        name: "TELEGRAM_WEBHOOK_SECRET",
        description:
          "A random string that Telegram sends with every message, so only Telegram reaches your bot: 16 to 256 letters, digits, `_` or `-`. Run `openssl rand -hex 32`, or type any long random string of those characters. You never need it again.",
      },
      {
        name: "TELEGRAM_PASSWORD",
        description:
          "A password you choose for your bot, **8 characters or more** (the bot does not start with a shorter one). Once deployed, send `/login <password>` to your bot: that chat stays allowed. Whoever knows the password can log in too, so keep it secret; change it to log everyone out.",
      },
      {
        name: "OPENROUTER_API_KEY",
        description:
          "Your [OpenRouter API key](https://openrouter.ai/settings/keys): the model your agent runs on. You pay OpenRouter for its tokens; a credit limit on the key caps it.",
      },
      {
        name: "PIKIT_ADMIN_TOKEN",
        description:
          "The key to your bot's dashboard (`/admin/` on your Worker's URL), where you read every conversation and can talk to the agent: **32 characters or more**. Run `openssl rand -hex 32`, or type any long random string. Keep it secret: whoever has it can read and write every conversation.",
      },
      {
        name: "BRAVE_API_KEY",
        description:
          "Optional: a [Brave Search API key](https://api-dashboard.search.brave.com) for the agent's web search (the free plan works). Without one, the bot works and only web search fails; if the form wants a value, type `none`.",
      },
    ],
    notAsked: {
      TELEGRAM_ALLOWED_USERS: "nobody knows their Telegram user id before deploying: the owner logs in with TELEGRAM_PASSWORD instead",
      GITHUB_TOKEN: "never needed here: GitHub is connected after deploying, from the dashboard's Settings → GitHub (github-app mints its own tokens)",
      PIKIT_MERGE_TOKEN: "never needed here: GitHub is connected after deploying, from the dashboard's Settings → GitHub",
    },
    bindings: {
      CONVERSATION: "One Durable Object per Telegram chat, SQLite-backed: its conversations (pi-durable) and the agent's workspace. Nothing to set.",
    },
    deploy: "node src/pikit/deployment-cloudflare/deploy.mjs src/pikit/channel-telegram-webhook/setup-webhook.mjs",
  },
};

/** The Deploy button's link for a template published at `repo`. */
export function deployUrl(repo: string): string {
  return `https://deploy.workers.cloudflare.com/?url=${repo}`;
}

/** What pikit's `wrangler.jsonc` says of its missing name, which a template's has. */
const NO_NAME = /^\/\/ No "name":.*\n(?:\/\/ .*\n)*?\/\/ .*pass --name too\.\n/m;

/**
 * `wrangler.jsonc` with the Worker's `name`, right after `$schema` (or first), and its header saying
 * so instead of "No name". Its other comments are kept.
 */
export function nameWorker(wrangler: string, name: string): string {
  if ((Bun.JSONC.parse(wrangler) as { name?: unknown }).name !== undefined) throw new Error("wrangler.jsonc already has a name");
  if (!NO_NAME.test(wrangler)) throw new Error('wrangler.jsonc no longer says `No "name"`: update scripts/template.ts\'s nameWorker');
  const header = [
    `// "name" is the Worker's (a Deploy to Cloudflare template's): Workers Builds deploys under it, and`,
    "// `pikit up`, `status`, `logs`, `down` and `dev` use it too, instead of package.json's \"name\".",
  ];
  const lines = wrangler.replace(NO_NAME, `${header.join("\n")}\n`).split("\n");
  const schema = lines.findIndex((line) => /^ {2}"\$schema"/.test(line));
  const at = schema >= 0 ? schema + 1 : lines.findIndex((line) => line.trim() === "{") + 1;
  if (at <= 0) throw new Error("wrangler.jsonc does not start with an object");
  lines.splice(
    at,
    0,
    "  // The Deploy to Cloudflare page may change it.",
    `  "name": ${JSON.stringify(name)},`,
  );
  return lines.join("\n");
}

/** What deployment-cloudflare's `build.command` runs for the dashboard, with the Bun on the PATH. */
const DASHBOARD_BUILD = "cd src/dashboard && bun install --frozen-lockfile && bun run build";

/**
 * `wrangler.jsonc` whose dashboard build runs Bun `version` through npx: Workers Builds has an older
 * Bun (1.2.15), which cannot read the dashboard's `bun.lock`, and a template cannot set the build's
 * `BUN_VERSION`. Node and npx are there.
 */
export function pinBun(wrangler: string, version: string): string {
  if (!wrangler.includes(DASHBOARD_BUILD)) throw new Error("wrangler.jsonc's build.command no longer runs `" + DASHBOARD_BUILD + "`: update scripts/template.ts's pinBun");
  const bun = `npx -y bun@${version}`;
  const pinned = wrangler.replace(DASHBOARD_BUILD, `cd src/dashboard && ${bun} install --frozen-lockfile && ${bun} run build`);
  return pinned.replace(
    /^( {2})"build": \{$/m,
    `$1// A template's: Workers Builds' Bun (1.2.15) cannot read the dashboard's bun.lock, so Bun ${version} runs through npx.\n$1"build": {`,
  );
}

/** `.dev.vars.example`: the secrets the button asks for (dotenv), without a value. */
export function devVarsExample(template: Template): string {
  const header = [
    "# The Worker's secrets. The Deploy to Cloudflare button asks for each of them (package.json's",
    '# "cloudflare.bindings" says what to type), and keeps them in Cloudflare, never in this repository.',
    "# To run it locally (npx wrangler dev), copy this file to .dev.vars, which Git ignores, and fill it in.",
  ];
  const lines = template.secrets.map((secret) => `${secret.name}=`);
  return `${[...header, ...lines].join("\n")}\n`;
}

/** `package.json` with the template's description, `deploy` script and the setup page's descriptions. */
export function templatePackageJson(text: string, template: Template): string {
  const pkg = JSON.parse(text) as Record<string, unknown> & { scripts?: Record<string, string> };
  const { name, version, ...rest } = pkg;
  const bindings: Record<string, { description: string }> = {};
  for (const secret of template.secrets) bindings[secret.name] = { description: secret.description };
  for (const [binding, description] of Object.entries(template.bindings)) bindings[binding] = { description };
  const out = {
    name,
    version,
    description: template.description,
    ...rest,
    scripts: { ...pkg.scripts, deploy: template.deploy },
    cloudflare: { bindings },
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * `.gitignore` that ships `.dev.vars.example` and keeps the project's Bun lockfile out (npm's is the
 * one). The dashboard's own (`src/dashboard/bun.lock`) stays: its build installs from it.
 */
export function templateGitignore(text: string): string {
  return `${text}# A Deploy to Cloudflare template: the secrets' names go in the repository, and npm's lockfile is
# the one Workers Builds installs with (after \`pikit add\` or \`bun install\`, run \`npm install\`).
# The dashboard's bun.lock (src/dashboard/) stays: its build installs from it.
!.dev.vars.example
/bun.lock
/bun.lockb
`;
}

/** The template's README (`templates/<template>/README.md`), filled in. */
export function templateReadme(key: string, template: Template): string {
  const source = readFileSync(join(REPO, "templates", key, "README.md"), "utf8");
  const secrets = [
    "| Secret | What to type |",
    "|---|---|",
    ...template.secrets.map((secret) => `| \`${secret.name}\` | ${secret.description.replaceAll("|", "\\|")} |`),
  ].join("\n");
  return source.replaceAll("{{DEPLOY_URL}}", deployUrl(template.repo)).replaceAll("{{NAME}}", template.name).replaceAll("{{SECRETS}}", secrets);
}

/**
 * The kit's skills (`.agents/skills/`) name where pikit is on the machine that made the project; a
 * template's name it online instead: its repository at the kit's commit (`pikit.json`'s `kit.commit`).
 */
export function portableSkills(projectDir: string, kitRoot: string = REPO): void {
  const dir = join(projectDir, ".agents", "skills");
  if (!existsSync(dir)) return;
  const manifest = join(projectDir, "pikit.json");
  const commit = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")) as { kit?: { commit?: string } }).kit?.commit : undefined;
  const online = commit === undefined ? KIT_REPOSITORY : `${KIT_REPOSITORY}/tree/${commit.replace(/-dirty$/, "")}`;
  for (const file of listFiles(dir)) {
    const path = join(dir, file);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll(kitRoot, online));
  }
}

/** Applies the template's adjustments to a project `pikit new` just made. */
export function adjust(projectDir: string, key: string, template: Template, kitRoot: string = REPO): void {
  const path = (file: string) => join(projectDir, file);
  const edit = (file: string, change: (text: string) => string) => writeFileSync(path(file), change(readFileSync(path(file), "utf8")));
  edit("wrangler.jsonc", (text) => nameWorker(text, template.name));
  if (existsSync(path("src/dashboard/package.json"))) edit("wrangler.jsonc", (text) => pinBun(text, template.bun));
  edit("package.json", (text) => templatePackageJson(text, template));
  edit(".gitignore", templateGitignore);
  // One place the button reads the secrets from: pikit's `.env.example` also lists what it does not ask.
  rmSync(path(".env.example"), { force: true });
  writeFileSync(path(".dev.vars.example"), devVarsExample(template));
  writeFileSync(path("README.md"), templateReadme(key, template));
  rmSync(path("bun.lock"), { force: true });
  rmSync(path("node_modules"), { recursive: true, force: true });
  // The dashboard's packages and build: the build makes them again.
  rmSync(path("src/dashboard/node_modules"), { recursive: true, force: true });
  rmSync(path("src/dashboard/dist"), { recursive: true, force: true });
  portableSkills(projectDir, kitRoot);
}

/** Every file under `dir`, relative, sorted, but for `skip`'s top-level entries. */
export function listFiles(dir: string, skip: readonly string[] = []): string[] {
  const files: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at).sort()) {
      const full = join(at, entry);
      if (at === dir && skip.includes(entry)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else files.push(relative(dir, full));
    }
  };
  walk(dir);
  return files;
}

/** Entries of `outDir` that are not the template's, and survive a run. */
export const KEPT = [".git", "node_modules"];

/**
 * Makes `to` hold exactly `from`'s files, but for `KEPT`: files that differ are written, the others
 * are left untouched, and files `from` does not have are deleted (then empty directories). Returns
 * what changed, relative.
 */
export function mirror(from: string, to: string): { written: string[]; deleted: string[] } {
  mkdirSync(to, { recursive: true });
  const wanted = listFiles(from);
  const written: string[] = [];
  for (const file of wanted) {
    const target = join(to, file);
    const content = readFileSync(join(from, file));
    if (existsSync(target) && statSync(target).isFile() && readFileSync(target).equals(content)) continue;
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    written.push(file);
  }
  const keep = new Set(wanted);
  const deleted = listFiles(to, KEPT).filter((file) => !keep.has(file));
  for (const file of deleted) rmSync(join(to, file));
  const prune = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (dir === to && KEPT.includes(entry)) continue;
      if (!statSync(full).isDirectory()) continue;
      prune(full);
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true });
    }
  };
  prune(to);
  return { written, deleted };
}

async function run(command: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`\`${command.join(" ")}\` failed with code ${code} in ${cwd}:\n${out}${err}`);
  return out;
}

export interface MakeOptions {
  /** Overrides the template's `repo`, the Deploy button's `url`. */
  repo?: string;
  say?: (line: string) => void;
}

/** Makes (or updates) the template `key` in `outDir`. Returns what changed there. */
export async function makeTemplate(key: string, outDir: string, options: MakeOptions = {}): Promise<{ written: string[]; deleted: string[] }> {
  const known = TEMPLATES[key];
  if (known === undefined) throw new Error(`no template "${key}"; there are: ${Object.keys(TEMPLATES).join(", ")}`);
  const template = { ...known, ...(options.repo !== undefined && { repo: options.repo }) };
  const say = options.say ?? (() => {});
  const out = resolve(outDir);
  const staging = mkdtempSync(join(tmpdir(), "pikit-template-"));
  const project = join(staging, template.name);
  try {
    const flags = [...(template.ui ? ["--ui"] : []), ...template.with.flatMap((feature) => ["--with", feature])];
    say(`pikit new ${template.name} --target ${template.target} --preset ${template.preset} ${flags.join(" ")}`.trimEnd());
    await run([process.execPath, MAIN, "new", project, "--target", template.target, "--preset", template.preset, ...flags], staging, { NO_COLOR: "1" });
    adjust(project, key, template);

    // The kit's tarballs `outDir` has under the same name have the same files: keep their bytes, which
    // its package-lock.json's integrity names. And npm starts from that lockfile.
    for (const tarball of readdirSync(join(project, "vendor"))) {
      const previous = join(out, "vendor", tarball);
      if (existsSync(previous)) cpSync(previous, join(project, "vendor", tarball));
    }
    if (existsSync(join(out, "package-lock.json"))) cpSync(join(out, "package-lock.json"), join(project, "package-lock.json"));
    say("npm install --package-lock-only");
    await run(["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], project, { NO_COLOR: "1" });

    const changed = mirror(project, out);
    say(`${out}: ${changed.written.length} file(s) written, ${changed.deleted.length} deleted`);
    return changed;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const repoAt = args.indexOf("--repo");
  const repo = repoAt >= 0 ? args.splice(repoAt, 2)[1] : undefined;
  const [key, outDir] = args;
  if (key === undefined || outDir === undefined || args.length !== 2 || (repoAt >= 0 && repo === undefined)) {
    console.error(`usage: bun scripts/template.ts <${Object.keys(TEMPLATES).join("|")}> <outDir> [--repo <url>]`);
    process.exit(2);
  }
  try {
    await makeTemplate(key, outDir, { ...(repo !== undefined && { repo }), say: (line) => console.log(`→ ${line}`) });
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

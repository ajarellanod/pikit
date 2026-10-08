/**
 * `scripts/template.ts`, the "Deploy to Cloudflare" template pikit makes of itself.
 *
 * The adjustments and the mirror run offline, on the registry's own files. With `PIKIT_E2E=1`, the
 * whole template is made twice (the second run changes nothing), then checked as Workers Builds would
 * take it, in a clean copy: `npm ci` from scratch (only the npm registry is reached), `wrangler deploy
 * --dry-run`, and `wrangler dev` with the button's secrets in `.dev.vars` against a local fake Telegram
 * and fake OpenRouter: the `deploy` script, run with a fake `wrangler deploy` that answers the local
 * Worker's URL, has the Worker register its webhook, and the owner logs in with the password and is answered.
 * Nothing is deployed, and every key is a dummy. Slow, and needs Node (wrangler runs on it) and npm:
 *
 *   PIKIT_E2E=1 bun test scripts/template.test.ts
 */

import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UI_COMPONENTS } from "../packages/cli/src/commands/ui.ts";
import { DEFAULT_REGISTRY } from "../packages/cli/src/paths.ts";
import { setConfigEntry } from "../packages/cli/src/project/config-file.ts";
import { withOffers } from "../packages/cli/src/project/offers.ts";
import { openRegistry } from "../packages/cli/src/project/registry-source.ts";
import { startFakeTelegram } from "../registry/components/channel-telegram-webhook/files/src/pikit/channel-telegram-webhook/fake-telegram.test-support.ts";
import { startFakeOpenRouter } from "../registry/components/provider-openrouter/files/src/pikit/provider-openrouter/fake-openrouter.test-support.ts";
import {
  adjust,
  deployUrl,
  devVarsExample,
  listFiles,
  makeTemplate,
  mirror,
  nameWorker,
  pinBun,
  TEMPLATES,
  templateGitignore,
  templatePackageJson,
  templateReadme,
} from "./template.ts";

const E2E = process.env.PIKIT_E2E === "1";
const KEY = "telegram-cloudflare";
const TEMPLATE = TEMPLATES[KEY] as NonNullable<(typeof TEMPLATES)[string]>;
const REGISTRY = join(import.meta.dir, "..", "registry");
const WRANGLER = readFileSync(join(REGISTRY, "components", "deployment-cloudflare", "files", "wrangler.jsonc"), "utf8");

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-template-test-"));
  dirs.push(dir);
  return dir;
}

/** Telegram bot tokens and OpenRouter, Brave and Cloudflare keys, as they look. */
/**
 * Dummies the components' tests need shaped as real ones, removed before `TOKEN_PATTERNS` look: a
 * Telegram token admin-api's test checks is redacted from `/admin/api/app`.
 */
const KNOWN_DUMMIES = ["123456789:AAEabcdefghijklmnopqrstuvwxyz012345"];
const TOKEN_PATTERNS = [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, /sk-or-v1-[0-9a-f]{20,}/, /\bBSA[A-Za-z0-9_-]{20,}/, /\bsk-[A-Za-z0-9]{32,}/, /CLOUDFLARE_API_TOKEN=[A-Za-z0-9_-]{30,}/];

test("wrangler.jsonc: pikit's names no Worker; the template's names it, keeping the rest and its comments", () => {
  expect((Bun.JSONC.parse(WRANGLER) as { name?: string }).name).toBeUndefined();
  const named = nameWorker(WRANGLER, TEMPLATE.name);
  const parsed = Bun.JSONC.parse(named) as Record<string, unknown>;
  expect(parsed.name).toBe("pikit-telegram-bot");
  const { name: _, ...rest } = parsed;
  expect(rest).toEqual(Bun.JSONC.parse(WRANGLER) as Record<string, unknown>);
  // The header no longer says "No name", and every other comment stays.
  expect(named).not.toContain('No "name"');
  const noName = WRANGLER.slice(WRANGLER.indexOf('// No "name"'), WRANGLER.indexOf("pass --name too.") + "pass --name too.".length);
  const comments = WRANGLER.split("\n").filter((line) => line.trim().startsWith("//") && !noName.includes(line));
  expect(comments.length).toBeGreaterThan(10);
  for (const line of comments) expect(named.split("\n")).toContain(line);
  expect(() => nameWorker(named, "again")).toThrow(/already has a name/);
  expect(() => nameWorker(WRANGLER.replace('// No "name"', "// Nameless"), "x")).toThrow(/update scripts\/template.ts/);
});

test("the dashboard's build runs the installer's Bun through npx, the rest of wrangler.jsonc as it was", () => {
  const installer = readFileSync(join(import.meta.dir, "..", "installer", "install.sh"), "utf8");
  expect(TEMPLATE.bun).toBe(/BUN_PINNED="\$\{PIKIT_BUN_VERSION:-([^}]+)\}"/.exec(installer)?.[1] as string);
  const pinned = pinBun(WRANGLER, "1.4.2");
  const build = (Bun.JSONC.parse(pinned) as { build: { command: string } }).build.command;
  expect(build).toBe("if [ -f src/dashboard/package.json ]; then cd src/dashboard && npx -y bun@1.4.2 install --frozen-lockfile && npx -y bun@1.4.2 run build; fi");
  const { build: _, ...rest } = Bun.JSONC.parse(pinned) as Record<string, unknown>;
  const { build: __, ...before } = Bun.JSONC.parse(WRANGLER) as Record<string, unknown>;
  expect(rest).toEqual(before);
  expect(pinned).toContain("// A template's: Workers Builds' Bun (1.2.15) cannot read the dashboard's bun.lock, so Bun 1.4.2 runs through npx.\n  \"build\": {");
  expect(() => pinBun(pinned, "1.4.2")).toThrow(/update scripts\/template.ts's pinBun/);
});

test("the button asks for every secret the components need, and nothing else", () => {
  const registry = openRegistry(DEFAULT_REGISTRY);
  const components = [...registry.preset(TEMPLATE.preset), ...(TEMPLATE.ui ? UI_COMPONENTS : [])];
  const { order } = withOffers(registry, components, [TEMPLATE.target]);
  const declared = order.flatMap((component) => registry.manifest(component).environment ?? []);
  const asked = TEMPLATE.secrets.map((secret) => secret.name);
  // Each one a component declares is asked, or said why not; and each asked is one a component reads.
  expect([...asked, ...Object.keys(TEMPLATE.notAsked)].sort()).toEqual(declared.map((variable) => variable.name).sort());
  expect(asked).toEqual(["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_PASSWORD", "OPENROUTER_API_KEY", "PIKIT_ADMIN_TOKEN", "BRAVE_API_KEY"]);
  for (const variable of declared) if (asked.includes(variable.name)) expect(variable.secret).toBe(true);

  // .dev.vars.example (dotenv): every secret, without a value.
  const example = devVarsExample(TEMPLATE);
  const entries = example.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
  expect(entries).toEqual(asked.map((name) => `${name}=`));
});

test("package.json: the deploy script, a description per secret and binding, the rest as pikit made it", () => {
  const made = { name: TEMPLATE.name, version: "0.0.0", private: true, scripts: { test: "bun test" }, dependencies: { a: "1.0.0" }, overrides: { b: "file:vendor/b.tgz" } };
  const pkg = JSON.parse(templatePackageJson(JSON.stringify(made), TEMPLATE));
  expect(Object.keys(pkg)).toEqual(["name", "version", "description", "private", "scripts", "dependencies", "overrides", "cloudflare"]);
  expect(pkg).toMatchObject({ ...made, scripts: { test: "bun test", deploy: TEMPLATE.deploy } });
  // No build script: wrangler bundles. Deploy, then register the webhook with the URL wrangler printed.
  expect(pkg.scripts.build).toBeUndefined();
  expect(TEMPLATE.deploy).toBe("wrangler deploy | node src/pikit/channel-telegram-webhook/setup-webhook.mjs");
  expect(existsSync(join(REGISTRY, "components", "channel-telegram-webhook", "files", "src", "pikit", "channel-telegram-webhook", "setup-webhook.mjs"))).toBe(true);
  expect(Object.keys(pkg.cloudflare.bindings)).toEqual([...TEMPLATE.secrets.map((secret) => secret.name), "CONVERSATION"]);
  // Each binding described is one wrangler.jsonc has.
  const wrangler = Bun.JSONC.parse(WRANGLER) as { durable_objects: { bindings: { name: string }[] } };
  for (const binding of Object.keys(TEMPLATE.bindings)) expect(wrangler.durable_objects.bindings.map((b) => b.name)).toContain(binding);
  for (const { description } of Object.values(pkg.cloudflare.bindings) as { description: string }[]) expect(description.length).toBeGreaterThan(20);
  // The facts the descriptions give match what the channel enforces.
  const descriptions = Object.fromEntries(TEMPLATE.secrets.map((secret) => [secret.name, secret.description]));
  expect(descriptions.TELEGRAM_BOT_TOKEN).toContain("https://t.me/BotFather");
  expect(descriptions.TELEGRAM_WEBHOOK_SECRET).toContain("`openssl rand -hex 32`");
  expect(descriptions.TELEGRAM_WEBHOOK_SECRET).toContain("16 to 256 letters, digits, `_` or `-`");
  expect(descriptions.TELEGRAM_PASSWORD).toContain("8 characters or more");
  expect(descriptions.TELEGRAM_PASSWORD).toContain("`/login <password>`");
  expect(descriptions.TELEGRAM_PASSWORD).toContain("change it to log everyone out");
  expect(descriptions.OPENROUTER_API_KEY).toContain("https://openrouter.ai/settings/keys");
  expect(descriptions.BRAVE_API_KEY).toContain("https://api-dashboard.search.brave.com");
  // admin-auth-token does not start with a shorter one.
  expect(descriptions.PIKIT_ADMIN_TOKEN).toContain("**32 characters or more**");
  expect(descriptions.PIKIT_ADMIN_TOKEN).toContain("`/admin/`");
});

test(".gitignore ships .dev.vars.example and keeps secrets, state and Bun's lockfile out", () => {
  const repo = temp();
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  expect(git("init", "-q").exitCode).toBe(0);
  const pikits = "node_modules/\n.env\n.env.*\n!.env.example\n.pikit/\n.dev.vars*\n.wrangler/\n";
  writeFileSync(join(repo, ".gitignore"), templateGitignore(pikits));
  const ignored = (file: string) => git("check-ignore", "-q", file).exitCode === 0;
  for (const file of [".dev.vars", ".env", ".env.local", "bun.lock", "bun.lockb", ".wrangler/state", "node_modules/x"]) expect([file, ignored(file)]).toEqual([file, true]);
  for (const file of [".dev.vars.example", "package-lock.json", "wrangler.jsonc", "vendor/pikit-core-0.0.0-x.tgz", "src/dashboard/bun.lock"]) expect([file, ignored(file)]).toEqual([file, false]);
});

test("the README has the button, every secret, the five steps after deploying, costs and security", () => {
  const readme = templateReadme(KEY, TEMPLATE);
  expect(readme).not.toContain("{{");
  expect(readme).toContain(`[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](${deployUrl(TEMPLATE.repo)})`);
  expect(deployUrl(TEMPLATE.repo)).toBe("https://deploy.workers.cloudflare.com/?url=https://github.com/ajarellanod/pikit-telegram-cloudflare");
  for (const secret of TEMPLATE.secrets) expect(readme).toContain(`| \`${secret.name}\` |`);
  const steps = readme.slice(readme.indexOf("## After deploying"), readme.indexOf("## How it works"));
  expect(steps.match(/^\d\. \*\*/gm)).toEqual(["1. **", "2. **", "3. **", "4. **", "5. **"]);
  expect(steps).toContain("/login <your password>");
  for (const command of ["pikit doctor", "pikit add", "pikit upgrade"]) expect(steps).toContain(command);
  for (const section of ["## What it costs", "## Security"]) expect(readme).toContain(section);
  expect(readme).toContain("Workers Free plan is enough");
  expect(readme).toContain("The password");
  expect(readme).toContain("Who can talk to the bot");
  for (const text of [readme, devVarsExample(TEMPLATE), templatePackageJson("{}", TEMPLATE)]) for (const pattern of TOKEN_PATTERNS) expect(text).not.toMatch(pattern);
});

test("adjust: a project pikit made becomes the template, with one place for its secrets and npm's lockfile only", () => {
  const project = temp();
  writeFileSync(join(project, "wrangler.jsonc"), WRANGLER);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: TEMPLATE.name, version: "0.0.0", scripts: {} }));
  writeFileSync(join(project, ".gitignore"), "node_modules/\n");
  for (const file of [".env.example", "bun.lock", "README.md"]) writeFileSync(join(project, file), "pikit's\n");
  mkdirSync(join(project, "node_modules", "x"), { recursive: true });
  // The skills name the kit's checkout on this machine; the template's name it online, at its commit.
  const kitRoot = "/home/someone/.pikit/pikit";
  writeFileSync(join(project, "pikit.json"), JSON.stringify({ version: 1, kit: { commit: "abc123-dirty" } }));
  mkdirSync(join(project, ".agents", "skills", "pikit-component"), { recursive: true });
  writeFileSync(join(project, ".agents", "skills", "pikit-component", "SKILL.md"), `\`${kitRoot}\` is the kit; read \`${kitRoot}/features/memory.md\`.\n`);
  adjust(project, KEY, TEMPLATE, kitRoot);
  expect(listFiles(project)).toEqual([".agents/skills/pikit-component/SKILL.md", ".dev.vars.example", ".gitignore", "README.md", "package.json", "pikit.json", "wrangler.jsonc"]);
  expect(readFileSync(join(project, "README.md"), "utf8")).toBe(templateReadme(KEY, TEMPLATE));
  const online = "https://github.com/ajarellanod/pikit/tree/abc123";
  expect(readFileSync(join(project, ".agents", "skills", "pikit-component", "SKILL.md"), "utf8")).toBe(`\`${online}\` is the kit; read \`${online}/features/memory.md\`.\n`);
});

test("mirror: the output holds exactly the template's files, keeps .git and node_modules, and a second run writes nothing", () => {
  const from = temp();
  const to = temp();
  const write = (root: string, file: string, text: string) => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write(from, "a.txt", "a");
  write(from, "src/b.ts", "b");
  write(to, "a.txt", "old");
  write(to, "stale/c.ts", "c");
  write(to, ".git/HEAD", "ref");
  write(to, "node_modules/x/index.js", "x");
  expect(mirror(from, to)).toEqual({ written: ["src/b.ts", "a.txt"].sort(), deleted: ["stale/c.ts"] });
  expect(listFiles(to, [".git", "node_modules"])).toEqual(["a.txt", "src/b.ts"]);
  expect(existsSync(join(to, "stale"))).toBe(false);
  expect(readFileSync(join(to, ".git", "HEAD"), "utf8")).toBe("ref");
  expect(existsSync(join(to, "node_modules", "x", "index.js"))).toBe(true);
  expect(mirror(from, to)).toEqual({ written: [], deleted: [] });
});

// ---------------------------------------------------------------------------------------------------
// End to end (PIKIT_E2E=1): made twice, then taken as Workers Builds takes it.

const TIMEOUT = 600_000;
const OWNER = { id: 3003, first_name: "Grace" };
const PASSWORD = "template correct horse battery";
const MODEL_KEY = "sk-or-template-dummy-not-a-key";
const ADMIN_TOKEN = "template-admin-token-dummy-0123456789abcdef";
/** This machine's variables the project reads: none may leak into the Worker. */
const OWN = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_PASSWORD", "OPENROUTER_API_KEY", "PIKIT_ADMIN_TOKEN", "BRAVE_API_KEY", "CLOUDFLARE_API_TOKEN"];
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !OWN.includes(name))) as Record<string, string>;

async function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(command, { cwd, env: { ...CLEAN_ENV, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port as number;
  server.stop(true);
  return port;
}

test.skipIf(!E2E)(
  "the template, made twice and taken as Workers Builds takes it: npm ci, a bundle, and in workerd the deploy script registers the webhook and the owner logs in",
  async () => {
    const out = join(temp(), "pikit-telegram-cloudflare");
    const first = await makeTemplate(KEY, out);
    expect(first.written.length).toBeGreaterThan(100);
    // Idempotent: the same pikit makes the same files.
    expect(await makeTemplate(KEY, out)).toEqual({ written: [], deleted: [] });

    const files = listFiles(out);
    for (const file of [".dev.vars.example", ".gitignore", "README.md", "package-lock.json", "package.json", "pikit.config.ts", "pikit.json", "wrangler.jsonc"]) expect(files).toContain(file);
    for (const file of [".env.example", "bun.lock", ".env", ".dev.vars"]) expect(files).not.toContain(file);
    // The dashboard's source and lockfile, never its packages or build.
    for (const file of ["src/dashboard/package.json", "src/dashboard/bun.lock", "src/pikit/admin-api/index.ts"]) expect(files).toContain(file);
    expect(files.filter((file) => /^src\/dashboard\/(node_modules|dist)\//.test(file))).toEqual([]);
    // Self-contained: nothing names this machine, and nothing looks like a real token.
    for (const file of files.filter((f) => !f.endsWith(".tgz"))) {
      const text = readFileSync(join(out, file), "utf8");
      for (const local of [tmpdir(), join(import.meta.dir, ".."), process.env.HOME ?? "/nowhere"]) expect([file, text.includes(local)]).toEqual([file, false]);
      const withoutDummies = KNOWN_DUMMIES.reduce((rest, dummy) => rest.replaceAll(dummy, ""), text);
      for (const pattern of TOKEN_PATTERNS) expect([file, pattern.test(withoutDummies)]).toEqual([file, false]);
    }
    const lock = JSON.parse(readFileSync(join(out, "package-lock.json"), "utf8"));
    expect(lock.packages["node_modules/@pikit/core"].resolved).toMatch(/^file:vendor\/pikit-core-0\.0\.0-[0-9a-f]{10}\.tgz$/);

    // A clean copy, as Workers Builds clones it: npm ci from scratch, with an empty cache.
    const clean = join(temp(), "clone");
    cpSync(out, clean, { recursive: true });
    const installed = await run(["npm", "ci", "--no-audit", "--no-fund"], clean, { npm_config_cache: join(temp(), "npm-cache") });
    expect(installed.err).not.toContain("ERR!");
    expect(installed.code).toBe(0);

    const wranglerBin = join(clean, "node_modules", ".bin", "wrangler");
    const bundle = await run([wranglerBin, "deploy", "--dry-run", "--outdir", join(temp(), "bundle")], clean, { WRANGLER_SEND_METRICS: "false" });
    expect(bundle.code).toBe(0);
    const gzip = Number(/gzip: ([\d.]+) KiB/.exec(bundle.out + bundle.err)?.[1]);
    // The Workers Free plan takes a Worker of 3 MB compressed.
    expect(gzip).toBeGreaterThan(0);
    expect(gzip).toBeLessThan(3 * 1024);
    console.info(`template: the Worker's bundle is ${gzip} KiB gzip`);

    // The button's form, in .dev.vars; the only other change: where the fakes are, in each App.
    const telegram = startFakeTelegram();
    const openrouter = startFakeOpenRouter();
    const webhookSecret = "template_webhook_secret_0123456789";
    writeFileSync(
      join(clean, ".dev.vars"),
      `TELEGRAM_BOT_TOKEN=${telegram.token}\nTELEGRAM_WEBHOOK_SECRET=${webhookSecret}\nTELEGRAM_PASSWORD="${PASSWORD}"\nOPENROUTER_API_KEY=${MODEL_KEY}\nPIKIT_ADMIN_TOKEN=${ADMIN_TOKEN}\nBRAVE_API_KEY=none\n`,
    );
    let config = readFileSync(join(clean, "pikit.config.ts"), "utf8");
    config = setConfigEntry(config, "channel-telegram-webhook", `{ apiBase: "${telegram.url}" }`);
    config = setConfigEntry(config, "provider-openrouter", `{ apiBase: "${openrouter.url}" }`);
    config = setConfigEntry(config, "channel-telegram-webhook-worker", `{ apiBase: "${telegram.url}" }`, "workerConfig");
    writeFileSync(join(clean, "pikit.config.ts"), config);

    const port = freePort();
    const base = `http://127.0.0.1:${port}`;
    // wrangler.jsonc names the Worker: no --name, as Workers Builds runs it.
    const dev = Bun.spawn([wranglerBin, "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(freePort())], {
      cwd: clean,
      env: { ...CLEAN_ENV, WRANGLER_SEND_METRICS: "false" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let logs = "";
    const decoder = new TextDecoder();
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) logs += decoder.decode(chunk);
    };
    const collected = Promise.all([collect(dev.stdout), collect(dev.stderr)]);
    try {
      let health: { ok?: boolean; version?: string } | undefined;
      for (let i = 0; i < 90 && health?.ok !== true; i++) {
        health = await fetch(`${base}/health`).then(
          (response) => response.json() as Promise<{ ok?: boolean; version?: string }>,
          () => undefined,
        );
        if (health?.ok !== true) {
          if (dev.exitCode !== null) throw new Error(`wrangler dev exited (${dev.exitCode}):\n${logs}`);
          await Bun.sleep(1_000);
        }
      }
      const version = health?.version;
      expect(health?.ok).toBe(true);
      expect(typeof version).toBe("string");

      // Workers Builds' deploy command is package.json's deploy script, run by a shell: here with a
      // `wrangler` that prints what `wrangler deploy` prints, naming the local Worker.
      const fakeBin = join(temp(), "bin");
      mkdirSync(fakeBin);
      const printed = ["Uploaded pikit-telegram-bot (1.20 sec)", "Deployed pikit-telegram-bot triggers (0.31 sec)", `  ${base}`, `Current Version ID: ${version}`];
      writeFileSync(join(fakeBin, "wrangler"), `#!/bin/sh\n[ "$1" = deploy ] || exit 3\n${printed.map((line) => `echo "${line}"`).join("\n")}\n`);
      chmodSync(join(fakeBin, "wrangler"), 0o755);
      const pkg = JSON.parse(readFileSync(join(clean, "package.json"), "utf8"));
      const deployed = await run(["sh", "-c", pkg.scripts.deploy], clean, { PATH: `${fakeBin}:${process.env.PATH}` });
      expect(deployed.err).toBe("");
      expect(deployed.code).toBe(0);
      expect(deployed.out).toBe(`${printed.join("\n")}\n\u2713 Telegram telegram: webhook ${base}/telegram\n`);
      expect([telegram.webhookUrl, telegram.webhookSecret, telegram.allowedUpdates]).toEqual([`${base}/telegram`, webhookSecret, ["message"]]);

      // Nobody is listed: the owner is told /login, logs in, and is answered.
      expect((await telegram.write(OWNER, "hello?")).status).toBe(200);
      expect((await telegram.write(OWNER, `/login ${PASSWORD}`)).status).toBe(200);
      expect((await telegram.write(OWNER, "hello again")).status).toBe(200);
      const sent = await telegram.sentCount(3, 60_000);
      expect(sent.map((message) => [message.chatId, message.text])).toEqual([
        // Sent as HTML: Telegram shows `<password>`.
        [OWNER.id, `This bot is private. If you have its password, send /login &lt;password&gt;. Your Telegram user id is ${OWNER.id}: its owner can also let you in by adding it to TELEGRAM_ALLOWED_USERS.`],
        [OWNER.id, "\u2713 You're logged in: this chat can talk to the agent now. You may delete your /login message: it contains the password."],
        [OWNER.id, "answer: hello again"],
      ]);
      expect(openrouter.requests[0]).toMatchObject({ model: "z-ai/glm-5.3-flash", apiKey: MODEL_KEY });
      expect(JSON.stringify(openrouter.requests)).not.toContain(PASSWORD);
      // The agent knows itself (extension-pikit-self): the guide, the docs at the template's kit commit,
      // and what runs in its object, read from the running App.
      const commit = String(JSON.parse(readFileSync(join(clean, "pikit.json"), "utf8")).kit.commit).replace(/-dirty$/, "");
      const prompt = JSON.stringify(openrouter.requests[0]?.messages);
      expect(prompt).toContain("<pikit-self>");
      expect(prompt).toContain(`https://github.com/ajarellanod/pikit/tree/${commit}/docs/concepts.md`);
      expect(prompt).toContain("Target: durable.");
      expect(prompt).toContain("- channel-telegram-webhook: ");
      expect(prompt).toContain("- assistant: model openrouter/z-ai/glm-5.3-flash; tools read, write, edit, bash, fetch, websearch; extensions pikit-self");

      // The dashboard, built by wrangler's build: its page for anyone, its API for the token only.
      const page = await fetch(`${base}/admin/`);
      expect([page.status, page.headers.get("content-type")?.startsWith("text/html")]).toEqual([200, true]);
      expect(await page.text()).toContain("<div id=\"root\">");
      expect((await fetch(`${base}/admin/api/app`)).status).toBe(401);
      const app = await fetch(`${base}/admin/api/app`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
      expect(app.status).toBe(200);
      // The owner's chat reaches the conversation index in the background (a message to its object).
      let listed = "";
      for (let i = 0; i < 20 && !listed.includes(`telegram:${OWNER.id}`); i++) {
        if (i > 0) await Bun.sleep(500);
        const conversations = await fetch(`${base}/admin/api/conversations`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
        expect(conversations.status).toBe(200);
        listed = JSON.stringify(await conversations.json());
      }
      expect(listed).toContain(`telegram:${OWNER.id}`);
    } finally {
      dev.kill("SIGINT");
      const stopped = await Promise.race([dev.exited, Bun.sleep(15_000).then(() => undefined)]);
      if (stopped === undefined) dev.kill("SIGKILL");
      await dev.exited;
      await collected;
      await telegram.stop();
      await openrouter.stop();
    }
    expect(logs).toContain("pikit: Worker started");
    for (const secret of [telegram.token, PASSWORD, webhookSecret, MODEL_KEY, ADMIN_TOKEN]) expect(logs).not.toContain(secret);
  },
  TIMEOUT,
);

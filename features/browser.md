# Browser

**Public appeal:** ⭐ The agent reads web pages, clicks and fills forms. Hermes offers a cloud browser
(Browser Use) in its tool gateway; browsing is a standard tool of assistant agents.

**Specified:** idea

**Needed by:** nothing required.

## What it gives
A tool to open a page, read it, take a screenshot and act on it, for the agents that name it.

## How it fits pikit
- The smallest version needs nothing new: a Pi skill that drives a browser CLI through `bash`, on
  an `execution.shell` that has a browser installed, ideally [sandboxed](sandboxed-execution.md).
- If that is not enough: `tool-browser` provides `agent.tool` `browser` over a `browser` capability
  (new, suite first), with providers per target: a headless browser in a container (server), the
  Cloudflare Browser Rendering binding (Cloudflare), or a hosted browser service over
  `network.fetch`.
- Reading a page without a browser is `tool-http-fetch` (SPEC §6.3), on `network.fetch`.
- Replay: reading is `safe`; a click or a submitted form is `never`.
- Pages are untrusted input (prompt injection); a browser profile holds no credential unless the
  project puts one there on purpose.

## Pi first
Pi has no browser tool; its way is a skill and a CLI through `bash`. Prefer that wherever a shell
exists, and build a capability only for targets without one (Cloudflare).

## Open questions
- Is a `browser` capability needed at all, or only the skill plus a Cloudflare-specific tool?
- Screenshots to the model need images in tool results ([rich content](rich-content.md)).

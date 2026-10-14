# email-resend

Sends one email to one person with [Resend](https://resend.com): what a component asks when it
must reach someone by email (channel-web's sign-in links, password resets, invitations). Variables
only, no SMTP and no SDK: a `fetch` to Resend's `POST /emails`.

- **Provides:** `email.send` (`@pikit/contracts`' `email.ts`).
- **Requires:** `secrets` (for example `secrets-env`, or `secrets-workers` on Cloudflare), holding
  `RESEND_API_KEY` and `EMAIL_FROM`.
- **Targets:** `server` and `durable`: it uses only `secrets` and `fetch`.
- **Installs to:** `src/pikit/email-resend/`.

```sh
pikit add email-resend
pikit configure                  # RESEND_API_KEY and EMAIL_FROM
```

## Configure

| Variable | |
|---|---|
| `RESEND_API_KEY` | A key with sending access, from resend.com/api-keys. A secret: sent only to Resend. |
| `EMAIL_FROM` | The sender of every email: `bot@example.com` or `Assistant <bot@example.com>`, on a domain you verified in Resend (resend.com/domains). |

Both are read at start: without one, or with a sender that is not an address, the app does not
start, and the error names the variable (never its value). Config holds values only: `apiBase`
(Resend's API by default; a proxy or a test double) and `timeoutMs` (10 s).

## Guarantees

What every `email.send` provider guarantees (the contract's header):
- **One recipient per call**, a plain address. A message with another address, an empty subject or
  text, or a line break in the subject is `invalid`, and nothing is sent.
- **The sender is `EMAIL_FROM`**: a component never picks one.
- **It resolves with Resend's id** once Resend accepted the email (find it in Resend's console).
  Accepted is not delivered: bounces are Resend's.
- **Every failure is an `EmailError`**: `invalid` (Resend's 400 and 422: the message), `rejected`
  (401 and 403: the key, an unverified domain; and a sender Resend refuses, `invalid_from_address`)
  or `unavailable` (408, 429, 5xx, the network, the timeout, a cancelled context: retry later; after
  the request left the email may have been sent).
- **No content in errors**: what Resend says goes into the message cleaned by `emailErrorDetail` (no
  links, nothing when it quotes the subject or the body); the key is in no error.
- **Nothing is retried or stored**: the caller decides.

## Tests

`email-resend.test.ts` runs `createEmailSenderConformance` (`@pikit/contracts/testing`) against a
local stand-in of Resend's API (`Bun.serve`, through `apiBase`): a send and what Resend received,
invalid messages that never reach it, each failure's code, no subject, text or link in an error or a
log line, a cancel and the timeout. Also what setup declares, the start's refusals, and the mapping of
Resend's answers. No test reaches the network.

## Replace it

`email-ses` sends with Amazon SES instead; another service is a component that provides `email.send`
and passes the same suite. Consumers do not change.

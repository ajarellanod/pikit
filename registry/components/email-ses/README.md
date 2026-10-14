# email-ses

Sends one email to one person with [Amazon SES](https://aws.amazon.com/ses/) (its v2 API,
`SendEmail`): what a component asks when it must reach someone by email (channel-web's sign-in
links, password resets, invitations). Variables only, no SMTP and no AWS SDK: a `fetch` signed with
Signature Version 4 over Web Crypto.

- **Provides:** `email.send` (`@pikit/contracts`' `email.ts`).
- **Requires:** `secrets` (for example `secrets-env`, or `secrets-workers` on Cloudflare), holding
  the variables below.
- **Targets:** `server` and `durable`: it uses only `secrets`, `fetch` and Web Crypto.
- **Installs to:** `src/pikit/email-ses/` (`index.ts` the component, `sigv4.ts` the signer, and their
  tests).

```sh
pikit add email-ses
pikit configure                  # the AWS_SES_* variables and EMAIL_FROM
```

## Configure

| Variable | |
|---|---|
| `AWS_SES_REGION` | Where your sender is verified in SES: `us-east-1`, `eu-west-1`… |
| `AWS_SES_ACCESS_KEY_ID` | An IAM user's (or role's) access key, allowed `ses:SendEmail`. |
| `AWS_SES_SECRET_ACCESS_KEY` | Its secret key. Never sent: only signatures made with it are. |
| `AWS_SES_SESSION_TOKEN` | Optional: the session token of temporary credentials (STS). |
| `EMAIL_FROM` | The sender of every email: `bot@example.com` or `Assistant <bot@example.com>`, an address or domain verified in SES in that region. |

A policy that allows sending only:

```json
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": "ses:SendEmail", "Resource": "*" }] }
```

A new SES account is in the sandbox: it sends only to verified addresses until AWS moves it out.
Everything is read at start: without a variable, with a region that is not one or a sender that is
not an address, the app does not start, and the error names the variable (never its value). Config
holds values only: `endpoint` (`https://email.<region>.amazonaws.com` by default; a VPC endpoint or a
test double) and `timeoutMs` (10 s). Temporary credentials expire: the app reads them at start only.

## Guarantees

What every `email.send` provider guarantees (the contract's header):
- **One recipient per call**, a plain address. A message with another address, an empty subject or
  text, or a line break in the subject is `invalid`, and nothing is sent.
- **The sender is `EMAIL_FROM`**: a component never picks one.
- **It resolves with SES's `MessageId`** once SES accepted the email. Accepted is not delivered:
  bounces and complaints are SES's (its suppression list, its event destinations).
- **Every failure is an `EmailError`**, by SES's error type, then its status: `rejected`
  (`MessageRejected`, `MailFromDomainNotVerified`, `AccountSuspended`, `SendingPaused`, the
  credentials' and signature's errors, 403), `invalid` (`BadRequest`, validation errors, other 400s)
  or `unavailable` (`TooManyRequests`, `LimitExceeded`, `Throttling`, 429, 5xx, the network, the
  timeout, a cancelled context: retry later; after the request left the email may have been sent).
- **No content in errors**: what SES says goes into the message cleaned by `emailErrorDetail` (no
  links, nothing when it quotes the subject or the body); no key is in an error.
- **Nothing is retried or stored**: the caller decides.

## Tests

- `sigv4.test.ts`: the signer against AWS's published Signature Version 4 test vectors (`get-vanilla`,
  `post-vanilla`, `post-x-www-form-urlencoded`, `get-vanilla-with-session-token`, from
  awslabs/aws-c-auth's copy of the suite).
- `email-ses.test.ts`: `createEmailSenderConformance` (`@pikit/contracts/testing`) against a local
  stand-in of SES (`Bun.serve`, through `endpoint`) that checks each request's signature as SES does,
  so a request signed over another body or header than the one sent is refused; a session token;
  what setup declares, the start's refusals, and the mapping of SES's errors. No test reaches the
  network.

## Replace it

`email-resend` sends with Resend instead; another service is a component that provides `email.send`
and passes the same suite. Consumers do not change.

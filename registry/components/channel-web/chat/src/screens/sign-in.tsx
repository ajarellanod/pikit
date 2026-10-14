/**
 * Signing in, as `GET /chat/api/config` says one may: a button per provider (built-in or OIDC, by its
 * name), email and password, a link by email; making an account when `signUp` is not `invite` (with a
 * password); "forgot password" when the App sends email. What a provider or a link answered with
 * (`?error=<code>`) is said humanly at the top.
 */

import { ArrowRight } from "iconoir-react";
import { useState } from "react";
import { Button } from "@/components/bui/Button";
import { FormNote, Spinner, TextField } from "@/components/chat/field";
import { requestPasswordReset, sendMagicLink, signInWithPassword, signInWithProvider, signUp } from "@/lib/auth";
import type { ChatConfig } from "@/lib/chat-api";
import { asError, ChatFailure, normalCode } from "@/lib/errors";
import { go } from "@/lib/location";
import { offers, providersOf, usePageTitle } from "@/lib/session";
import { AuthCard, Or, ScreenLink } from "./auth-card";

export interface SignedOutProps {
  config: ChatConfig;
  /** A session was opened: read the user. */
  onSignedIn: () => void;
  /** Why the last sign-in by a provider or a link failed, said humanly. */
  landing?: string;
}

/** Whether a person may make an account with a password here. */
export const maySignUp = (config: ChatConfig): boolean => config.signUp !== "invite" && offers(config, "password");

function Submit({ busy, children, disabled = false }: { busy: boolean; children: string; disabled?: boolean }) {
  return (
    <Button type="submit" variant="primary" className="mt-1 h-10 w-full gap-2 py-0" disabled={busy || disabled} aria-busy={busy}>
      {busy ? <Spinner /> : null}
      {children}
      {busy ? null : <ArrowRight width={15} height={15} strokeWidth={2} aria-hidden />}
    </Button>
  );
}

function Providers({ config, onError }: { config: ChatConfig; onError: (error: Error) => void }) {
  const [leaving, setLeaving] = useState<string>();
  const providers = providersOf(config);
  if (providers.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        <Button
          key={provider.id}
          className="h-10 w-full gap-2 py-0"
          disabled={leaving !== undefined}
          aria-busy={leaving === provider.id}
          onClick={() => {
            setLeaving(provider.id);
            signInWithProvider(provider.id).catch((error: unknown) => {
              setLeaving(undefined);
              onError(asError(error));
            });
          }}
        >
          {leaving === provider.id && <Spinner />}
          Continue with {provider.name}
        </Button>
      ))}
    </div>
  );
}

export function SignInScreen({ config, onSignedIn, landing }: SignedOutProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "link">();
  const [problem, setProblem] = useState<string | undefined>(landing);
  const [linkSent, setLinkSent] = useState(false);
  usePageTitle(config.name, "Sign in");
  const withPassword = offers(config, "password");
  const withLink = offers(config, "magic-link");
  const hasProviders = providersOf(config).length > 0;

  const signIn = async () => {
    if (busy !== undefined) return;
    setBusy("password");
    setProblem(undefined);
    try {
      await signInWithPassword(email.trim(), password);
      onSignedIn();
    } catch (error) {
      if (error instanceof ChatFailure && normalCode(error.code) === "EMAIL_NOT_VERIFIED") go(`/verify?email=${encodeURIComponent(email.trim())}`);
      else setProblem(asError(error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const emailLink = async () => {
    if (busy !== undefined) return;
    if (email.trim() === "") {
      setProblem("Write your email first.");
      return;
    }
    setBusy("link");
    setProblem(undefined);
    try {
      await sendMagicLink(email.trim());
      setLinkSent(true);
    } catch (error) {
      setProblem(asError(error).message);
    } finally {
      setBusy(undefined);
    }
  };

  if (linkSent) {
    return (
      <AuthCard name={config.name} title="Check your email" lead={<>We sent a sign-in link to {email.trim()}. It works once, for a few minutes.</>}>
        <Button className="h-10 w-full" onClick={() => setLinkSent(false)}>
          Back
        </Button>
      </AuthCard>
    );
  }

  const nothing = !withPassword && !withLink && !hasProviders;
  return (
    <AuthCard
      name={config.name}
      title="Sign in"
      lead={nothing ? "No way to sign in is set up here yet." : `To talk with ${config.name}.`}
      footer={
        maySignUp(config) ? (
          <>
            No account yet? <ScreenLink to="/sign-up">Make one</ScreenLink>
          </>
        ) : undefined
      }
    >
      {problem !== undefined && <FormNote>{problem}</FormNote>}
      <Providers config={config} onError={(error) => setProblem(error.message)} />
      {hasProviders && (withPassword || withLink) && <Or />}
      {(withPassword || withLink) && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void (withPassword ? signIn() : emailLink());
          }}
        >
          <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" required autoFocus={!hasProviders} />
          {withPassword && (
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              required
              help={
                config.email ? (
                  <a href={`#/forgot${email.trim() === "" ? "" : `?email=${encodeURIComponent(email.trim())}`}`} className="text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink">
                    Forgot your password?
                  </a>
                ) : undefined
              }
            />
          )}
          <Submit busy={busy === (withPassword ? "password" : "link")}>{withPassword ? "Sign in" : "Email me a link"}</Submit>
          {withPassword && withLink && (
            <Button className="h-10 w-full gap-2 py-0" disabled={busy !== undefined} aria-busy={busy === "link"} onClick={() => void emailLink()}>
              {busy === "link" && <Spinner />}
              Email me a sign-in link instead
            </Button>
          )}
        </form>
      )}
    </AuthCard>
  );
}

export function SignUpScreen({ config, onSignedIn }: SignedOutProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  usePageTitle(config.name, "Make an account");

  if (!maySignUp(config)) {
    return (
      <AuthCard name={config.name} title="By invitation" lead="Accounts here are by invitation: ask whoever runs this assistant to invite you." footer={<ScreenLink to="/sign-in">Sign in</ScreenLink>}>
        {null}
      </AuthCard>
    );
  }

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      // With email, the password is chosen from the confirmation's link: only the address's owner sets it.
      const made = await signUp(name.trim(), email.trim(), config.email ? undefined : password);
      if (made.verify) go(`/verify?email=${encodeURIComponent(email.trim())}`, true);
      else onSignedIn();
    } catch (error) {
      setProblem(asError(error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      name={config.name}
      title="Make an account"
      lead={config.signUp === "allowlist" ? "Only the addresses the operator allows may make one." : undefined}
      footer={
        <>
          Already have one? <ScreenLink to="/sign-in">Sign in</ScreenLink>
        </>
      }
    >
      {problem !== undefined && <FormNote>{problem}</FormNote>}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField label="Your name" value={name} onChange={setName} autoComplete="name" required autoFocus maxLength={100} />
        <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" required />
        {config.email ? (
          <p className="text-[12.5px] leading-[1.5] text-ink-3">We email you a link: open it to choose your password.</p>
        ) : (
          <TextField label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" required minLength={8} maxLength={128} help="At least 8 characters." />
        )}
        <Submit busy={busy}>Make the account</Submit>
      </form>
    </AuthCard>
  );
}

export function ForgotScreen({ config, initialEmail }: SignedOutProps & { initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail ?? "");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string>();
  usePageTitle(config.name, "Forgot password");

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      await requestPasswordReset(email.trim());
      setSent(true);
    } catch (error) {
      setProblem(asError(error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      name={config.name}
      title="Forgot your password?"
      lead={
        !config.email
          ? "This assistant sends no email: ask whoever runs it for a link that sets a new password."
          : sent
            ? `If ${email.trim()} has an account here, a link that sets a new password is on its way.`
            : "We email you a link that sets a new one."
      }
      footer={<ScreenLink to="/sign-in">Back to sign in</ScreenLink>}
    >
      {config.email && !sent && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {problem !== undefined && <FormNote>{problem}</FormNote>}
          <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" required autoFocus />
          <Submit busy={busy}>Email me a link</Submit>
        </form>
      )}
    </AuthCard>
  );
}

/**
 * Where an invitation (`#/set-password?token=…&invite=1`), a new account's confirmation
 * (`&welcome=1`: setting its first password confirms the email) and a password reset (`#/set-password?token=…`)
 * land: a new password for the link's account (`POST /chat/api/auth/reset-password`), then a sign-in
 * with it and the email (setting it ends every session). The link names the email (`&email=`): shown
 * read-only; a link without it asks it, and without one the person signs in after. An invitation also offers the
 * providers: one whose verified email is the invited one signs in to the same account.
 *
 * And "confirm your email" (`#/verify?email=…`), after making an account or signing in with one not
 * confirmed yet: its link chooses the password (above); it can be sent again.
 */

import { ArrowRight } from "iconoir-react";
import { useState } from "react";
import { Button } from "@/components/bui/Button";
import { FormNote, Spinner, TextField } from "@/components/chat/field";
import { resetPassword, sendVerificationEmail, signInWithPassword, signInWithProvider } from "@/lib/auth";
import { asError } from "@/lib/errors";
import { go } from "@/lib/location";
import type { SetPasswordLink } from "@/lib/routes";
import { providersOf, usePageTitle } from "@/lib/session";
import { AuthCard, Or, ScreenLink } from "./auth-card";
import type { SignedOutProps } from "./sign-in";

export function SetPasswordScreen({ config, onSignedIn, link }: SignedOutProps & { link: SetPasswordLink }) {
  const { token } = link;
  const invite = link.kind === "invite";
  const welcome = link.kind === "welcome";
  const [email, setEmail] = useState(link.email ?? "");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [done, setDone] = useState(false);
  usePageTitle(config.name, invite || welcome ? "Welcome" : "New password");
  const providers = invite ? providersOf(config) : [];

  if (token === null || token === "") {
    return (
      <AuthCard name={config.name} title="This link is not complete" lead="Open the link from your email again, whole: it carries a token this page needs." footer={<ScreenLink to="/sign-in">Sign in</ScreenLink>}>
        {null}
      </AuthCard>
    );
  }
  if (done) {
    return (
      <AuthCard name={config.name} title="Your password is set" lead="Sign in with your email and it." footer={undefined}>
        <Button variant="primary" className="w-full" onClick={() => go("/sign-in", true)}>
          Sign in
          <ArrowRight width={15} height={15} strokeWidth={2} aria-hidden />
        </Button>
      </AuthCard>
    );
  }

  const submit = async () => {
    if (busy) return;
    if (password !== again) {
      setProblem("The two passwords are not the same.");
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      await resetPassword(token, password);
    } catch (error) {
      setProblem(asError(error).message);
      setBusy(false);
      return;
    }
    try {
      if (email.trim() === "") setDone(true);
      else {
        await signInWithPassword(email.trim(), password);
        onSignedIn();
        go("/", true);
      }
    } catch {
      // The password is set; the email may not be the account's.
      setDone(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      name={config.name}
      title={invite ? "You are invited" : welcome ? "Choose your password" : "Set a new password"}
      lead={
        invite || welcome
          ? `${welcome ? "Your email is confirmed. " : ""}Choose a password to talk with ${config.name}.`
          : "Choose a new password: every browser signed in with the old one is signed out."
      }
      footer={<ScreenLink to="/sign-in">Sign in instead</ScreenLink>}
    >
      {problem !== undefined && <FormNote>{problem}</FormNote>}
      {providers.length > 0 && (
        <>
          <p className="text-[12.5px] leading-[1.5] text-ink-3">Or sign in with an account whose email is the one you were invited with:</p>
          {providers.map((provider) => (
            <Button
              key={provider.id}
              className="w-full"
              onClick={() => signInWithProvider(provider.id).catch((error: unknown) => setProblem(asError(error).message))}
            >
              Continue with {provider.name}
            </Button>
          ))}
          <Or />
        </>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {link.email === undefined ? (
          <TextField label="Your email" type="email" value={email} onChange={setEmail} autoComplete="username" help="To sign you in right after. Leave it empty to sign in later." />
        ) : (
          <TextField label="Your email" type="email" value={link.email} onChange={() => undefined} autoComplete="username" readOnly />
        )}
        <TextField label="New password" type="password" value={password} onChange={setPassword} autoComplete="new-password" required minLength={8} maxLength={128} autoFocus help="At least 8 characters." />
        <TextField label="The same again" type="password" value={again} onChange={setAgain} autoComplete="new-password" required minLength={8} maxLength={128} />
        <Button type="submit" variant="primary" className="mt-1 w-full" disabled={busy} aria-busy={busy}>
          {busy && <Spinner />}
          Set the password
        </Button>
      </form>
    </AuthCard>
  );
}

export function VerifyScreen({ config, email, again }: SignedOutProps & { email: string | null; again: boolean }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(again);
  const [problem, setProblem] = useState<string>();
  usePageTitle(config.name, "Confirm your email");
  const address = email ?? "";

  const resend = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      await sendVerificationEmail(address);
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
      title="Confirm your email"
      lead={
        <>
          {again ? "Your email is not confirmed yet. " : ""}We sent a link to {address === "" ? "your email" : <span className="font-medium text-ink">{address}</span>}: open it to choose your password.
        </>
      }
      footer={<ScreenLink to="/sign-in">Back to sign in</ScreenLink>}
    >
      {problem !== undefined && <FormNote>{problem}</FormNote>}
      {sent && <FormNote tone="done">A new link is on its way. It may take a minute; look in spam too.</FormNote>}
      {address !== "" && (
        <Button className="w-full" disabled={busy} aria-busy={busy} onClick={() => void resend()}>
          {busy && <Spinner />}
          Send the link again
        </Button>
      )}
    </AuthCard>
  );
}

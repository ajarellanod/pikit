/**
 * Where an invitation (`#/set-password?token=…&invite=1`) and a password reset (`#/set-password?token=…`)
 * land: a new password for the link's account (`POST /chat/api/auth/reset-password`), then a sign-in
 * with it when the email is given (setting it ends every session). An invitation also offers the
 * providers: one whose verified email is the invited one signs in to the same account.
 *
 * And "confirm your email" (`#/verify?email=…`), after making an account or signing in with one not
 * confirmed yet: its link signs in and comes back to `/chat/`; it can be sent again.
 */

import { ArrowRight } from "iconoir-react";
import { useState } from "react";
import { Button } from "@/components/bui/Button";
import { FormNote, Spinner, TextField } from "@/components/chat/field";
import { resetPassword, sendVerificationEmail, signInWithPassword, signInWithProvider } from "@/lib/auth";
import { asError } from "@/lib/errors";
import { go } from "@/lib/location";
import { providersOf, usePageTitle } from "@/lib/session";
import { AuthCard, Or, ScreenLink } from "./auth-card";
import type { SignedOutProps } from "./sign-in";

export function SetPasswordScreen({ config, onSignedIn, token, invite }: SignedOutProps & { token: string | null; invite: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [done, setDone] = useState(false);
  usePageTitle(config.name, invite ? "Welcome" : "New password");
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
        <Button variant="primary" className="h-10 w-full gap-2 py-0" onClick={() => go("/sign-in", true)}>
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
      title={invite ? "You are invited" : "Set a new password"}
      lead={invite ? `Choose a password to talk with ${config.name}.` : "Choose a new password: every browser signed in with the old one is signed out."}
      footer={<ScreenLink to="/sign-in">Sign in instead</ScreenLink>}
    >
      {problem !== undefined && <FormNote>{problem}</FormNote>}
      {providers.length > 0 && (
        <>
          <p className="text-[12.5px] leading-[1.5] text-ink-3">Or sign in with an account whose email is the one you were invited with:</p>
          {providers.map((provider) => (
            <Button
              key={provider.id}
              className="h-10 w-full py-0"
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
        <TextField label="Your email" type="email" value={email} onChange={setEmail} autoComplete="username" help="To sign you in right after. Leave it empty to sign in later." />
        <TextField label="New password" type="password" value={password} onChange={setPassword} autoComplete="new-password" required minLength={8} maxLength={128} autoFocus help="At least 8 characters." />
        <TextField label="The same again" type="password" value={again} onChange={setAgain} autoComplete="new-password" required minLength={8} maxLength={128} />
        <Button type="submit" variant="primary" className="mt-1 h-10 w-full gap-2 py-0" disabled={busy} aria-busy={busy}>
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
          {again ? "Your email is not confirmed yet. " : ""}We sent a link to {address === "" ? "your email" : <span className="font-medium text-ink">{address}</span>}: open it to sign in.
        </>
      }
      footer={<ScreenLink to="/sign-in">Back to sign in</ScreenLink>}
    >
      {problem !== undefined && <FormNote>{problem}</FormNote>}
      {sent && <FormNote tone="done">A new link is on its way. It may take a minute; look in spam too.</FormNote>}
      {address !== "" && (
        <Button className="h-10 w-full gap-2 py-0" disabled={busy} aria-busy={busy} onClick={() => void resend()}>
          {busy && <Spinner />}
          Send the link again
        </Button>
      )}
    </AuthCard>
  );
}

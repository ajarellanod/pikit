/**
 * The user's account: their name (their email is how they are known: it stays), their password
 * (changing it signs every other browser out; without one, a link by email sets one), the ways they
 * sign in (link a provider the App offers, unlink one while another stays), the browsers signed in
 * (sign one out, every other, or all), the theme, and signing out.
 */

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/bui/Button";
import { LoaderGrid } from "@/components/bui/LoadingState";
import { Page, Section } from "@/components/bui/Page";
import { StatusPill } from "@/components/bui/StatusPill";
import { ThemeToggle } from "@/components/bui/ThemeToggle";
import { FormNote, Spinner, TextField } from "@/components/chat/field";
import { ErrorNote } from "@/components/pikit/error-note";
import {
  changePassword,
  currentSession,
  type LinkedAccount,
  linkProvider,
  listAccounts,
  listSessions,
  requestPasswordReset,
  revokeAllSessions,
  revokeOtherSessions,
  revokeSession,
  type Session,
  unlinkAccount,
  updateName,
} from "@/lib/auth";
import { asError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { offers, providerName, providersOf, usePageTitle, useSession } from "@/lib/session";

/** A panel of the page: a card with its rows. */
function Panel({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4 rounded-card bg-surface p-4 shadow-card sm:p-5">{children}</div>;
}

function Row({ title, detail, children }: { title: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13.5px] font-medium text-ink">{title}</span>
        {detail !== undefined && <span className="text-[12.5px] text-ink-3 [overflow-wrap:anywhere]">{detail}</span>}
      </div>
      {children !== undefined && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** A browser, said shortly from its user agent: "Firefox on macOS". */
export function browserOf(agent: string | null | undefined): string {
  if (agent === null || agent === undefined || agent === "") return "A browser";
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "A browser";
  const system = /iPhone|iPad/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android" : /Mac OS X/.test(agent) ? "macOS" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : undefined;
  return system === undefined ? browser : `${browser} on ${system}`;
}

function NameSection() {
  const { me, reloadMe } = useSession();
  const [name, setName] = useState(me.user.name);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "problem" | "done"; text: string }>();

  const save = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      await updateName(name.trim());
      await reloadMe();
      setNote({ tone: "done", text: "Saved." });
    } catch (error) {
      setNote({ tone: "problem", text: asError(error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="You">
      <Panel>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <TextField label="Name" value={name} onChange={setName} autoComplete="name" maxLength={100} required />
          <Row title="Email" detail={me.user.email} />
          {note !== undefined && <FormNote tone={note.tone}>{note.text}</FormNote>}
          <Button size="sm" type="submit" variant="primary" className="self-start" disabled={busy || name.trim() === "" || name.trim() === me.user.name} aria-busy={busy}>
            {busy && <Spinner />}
            Save
          </Button>
        </form>
      </Panel>
    </Section>
  );
}

function PasswordSection() {
  const { config, me } = useSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "problem" | "done"; text: string }>();
  const hasPassword = me.methods.includes("password");
  if (!offers(config, "password")) return null;

  const change = async () => {
    if (next !== again) {
      setNote({ tone: "problem", text: "The two new passwords are not the same." });
      return;
    }
    setBusy(true);
    setNote(undefined);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setAgain("");
      setNote({ tone: "done", text: "Changed. Every other browser is signed out." });
    } catch (error) {
      setNote({ tone: "problem", text: asError(error).message });
    } finally {
      setBusy(false);
    }
  };
  const emailLink = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      await requestPasswordReset(me.user.email);
      setNote({ tone: "done", text: `A link that sets a password is on its way to ${me.user.email}.` });
    } catch (error) {
      setNote({ tone: "problem", text: asError(error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Password">
      <Panel>
        {hasPassword ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void change();
            }}
          >
            <TextField label="Current password" type="password" value={current} onChange={setCurrent} autoComplete="current-password" required />
            <TextField label="New password" type="password" value={next} onChange={setNext} autoComplete="new-password" required minLength={8} maxLength={128} help="At least 8 characters." />
            <TextField label="The new one again" type="password" value={again} onChange={setAgain} autoComplete="new-password" required minLength={8} maxLength={128} />
            {note !== undefined && <FormNote tone={note.tone}>{note.text}</FormNote>}
            <Button size="sm" type="submit" variant="primary" className="self-start" disabled={busy} aria-busy={busy}>
              {busy && <Spinner />}
              Change the password
            </Button>
          </form>
        ) : (
          <>
            <Row
              title="No password"
              detail={config.email ? "You sign in another way. To have a password too, we email you a link that sets one." : "You sign in another way. To have a password too, ask whoever runs this assistant for a link."}
            >
              {config.email && (
                <Button size="sm" disabled={busy} aria-busy={busy} onClick={() => void emailLink()}>
                  Email me a link
                </Button>
              )}
            </Row>
            {note !== undefined && <FormNote tone={note.tone}>{note.text}</FormNote>}
          </>
        )}
      </Panel>
    </Section>
  );
}

function MethodsSection() {
  const { config, reloadMe } = useSession();
  const [accounts, setAccounts] = useState<LinkedAccount[]>();
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(() => {
    listAccounts().then(
      (found) => (setAccounts(found), setError(undefined)),
      (thrown: unknown) => setError(asError(thrown)),
    );
  }, []);
  useEffect(load, [load]);

  const providers = providersOf(config);
  const linked = new Set((accounts ?? []).map((account) => account.providerId));
  const unlink = async (account: LinkedAccount) => {
    setBusy(account.id);
    try {
      await unlinkAccount(account.id);
      load();
      await reloadMe();
    } catch (thrown) {
      setError(asError(thrown));
    } finally {
      setBusy(undefined);
    }
  };
  const link = (provider: string) => {
    setBusy(provider);
    linkProvider(provider).catch((thrown: unknown) => {
      setError(asError(thrown));
      setBusy(undefined);
    });
  };

  return (
    <Section title="Ways to sign in">
      <Panel>
        {error !== undefined && <ErrorNote error={error} />}
        {accounts === undefined && error === undefined && (
          <div className="flex items-center gap-2.5 text-[13px] text-ink-3">
            <LoaderGrid /> Loading
          </div>
        )}
        {accounts?.map((account) => (
          <Row key={account.id} title={providerName(config, account.providerId)} detail={`Linked ${formatAgo(Date.parse(account.createdAt))}`}>
            <StatusPill tone="green">Linked</StatusPill>
            {account.providerId !== "credential" && (
              <Button size="sm" disabled={busy !== undefined || accounts.length < 2} aria-busy={busy === account.id} title={accounts.length < 2 ? "Your only way to sign in: link another first" : undefined} onClick={() => void unlink(account)}>
                Unlink
              </Button>
            )}
          </Row>
        ))}
        {accounts !== undefined &&
          providers
            .filter((provider) => !linked.has(provider.id))
            .map((provider) => (
              <Row key={provider.id} title={provider.name} detail="Not linked: sign in with it too (its email must be yours, verified)">
                <Button size="sm" disabled={busy !== undefined} aria-busy={busy === provider.id} onClick={() => link(provider.id)}>
                  {busy === provider.id && <Spinner />}
                  Link
                </Button>
              </Row>
            ))}
      </Panel>
    </Section>
  );
}

function SessionsSection() {
  const { signedOut } = useSession();
  const [sessions, setSessions] = useState<Session[]>();
  const [mine, setMine] = useState<string>();
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(() => {
    Promise.all([listSessions(), currentSession()]).then(
      ([found, current]) => {
        setSessions([...found].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
        setMine(current?.session.id);
        setError(undefined);
      },
      (thrown: unknown) => setError(asError(thrown)),
    );
  }, []);
  useEffect(load, [load]);

  const act = async (key: string, action: () => Promise<void>, after: () => void) => {
    setBusy(key);
    try {
      await action();
      after();
    } catch (thrown) {
      setError(asError(thrown));
    } finally {
      setBusy(undefined);
    }
  };
  const others = (sessions ?? []).filter((session) => session.id !== mine);

  return (
    <Section title="Browsers signed in" meta={sessions === undefined ? undefined : String(sessions.length)}>
      <Panel>
        {error !== undefined && <ErrorNote error={error} />}
        {sessions === undefined && error === undefined && (
          <div className="flex items-center gap-2.5 text-[13px] text-ink-3">
            <LoaderGrid /> Loading
          </div>
        )}
        {sessions?.map((session) => (
          <Row key={session.id} title={browserOf(session.userAgent)} detail={`Active ${formatAgo(Date.parse(session.updatedAt))}${session.ipAddress ? ` · ${session.ipAddress}` : ""}`}>
            {session.id === mine ? (
              <StatusPill tone="accent">This browser</StatusPill>
            ) : (
              <Button size="sm" disabled={busy !== undefined} aria-busy={busy === session.id} onClick={() => void act(session.id, () => revokeSession(session.token), load)}>
                Sign out
              </Button>
            )}
          </Row>
        ))}
        {sessions !== undefined && (
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            <Button size="sm" disabled={busy !== undefined || others.length === 0} aria-busy={busy === "others"} onClick={() => void act("others", revokeOtherSessions, load)}>
              Sign out every other browser
            </Button>
            <Button size="sm" variant="danger" disabled={busy !== undefined} aria-busy={busy === "all"} onClick={() => void act("all", revokeAllSessions, signedOut)}>
              Sign out everywhere
            </Button>
          </div>
        )}
      </Panel>
    </Section>
  );
}

export function AccountScreen() {
  const { config, me, signOut } = useSession();
  usePageTitle(config.name, "Account");
  return (
    <Page
      eyebrow="Account"
      title={me.user.name.trim() === "" ? me.user.email : me.user.name}
      aside={
        <Button size="sm" onClick={() => void signOut()}>
          Sign out
        </Button>
      }
    >
      <NameSection />
      <PasswordSection />
      <MethodsSection />
      <SessionsSection />
      <Section title="Look">
        <Panel>
          <Row title="Theme" detail="Light, dark, or your system's: kept in this browser">
            <ThemeToggle />
          </Row>
        </Panel>
      </Section>
    </Page>
  );
}

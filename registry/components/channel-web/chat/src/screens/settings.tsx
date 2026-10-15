/**
 * The user's Settings: a modal over the page in the dashboard's settings dialog's look (its frame,
 * navigation and rows are the shared `settings-shell` and `settings-rows`), opened from the user's menu
 * at the sidebar's foot or by `#/settings/<section>`. Full screen on a phone, the sections on top.
 *
 * - **Profile**: the name (their email is how they are known: it stays).
 * - **Password** (when the App signs in with one): change it in a small dialog (every other browser is
 *   signed out), or, without one, a link by email that sets one.
 * - **Connected accounts** (when the App offers a provider): connect each, disconnect one while
 *   another way to sign in remains.
 * - **Sessions**: this browser and the others, each signed out alone or all the others at once.
 * - **Appearance**: the theme, this browser's.
 */

import { Computer, HalfMoon, Key, Laptop, Link as LinkIcon, Palette, SunLight, User } from "iconoir-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/bui/Button";
import { LoaderGrid } from "@/components/bui/LoadingState";
import { StatusPill } from "@/components/bui/StatusPill";
import { Dialog } from "@/components/chat/dialog";
import { FormNote, Spinner, TextField } from "@/components/chat/field";
import { ErrorNote } from "@/components/pikit/error-note";
import { Segmented, SettingsHeading, SettingsRow as SharedRow } from "@/components/pikit/settings-rows";
import { SETTINGS_FRAME_STYLE, type SettingsEntry, SettingsPanels, settingsFrameClass, useSettingsChoice } from "@/components/pikit/settings-shell";
import {
  changePassword,
  currentSession,
  type LinkedAccount,
  linkProvider,
  listAccounts,
  listSessions,
  requestPasswordReset,
  revokeOtherSessions,
  revokeSession,
  type Session,
  unlinkAccount,
  updateName,
} from "@/lib/auth";
import type { ChatConfig } from "@/lib/chat-api";
import { asError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { offers, providerName, providersOf, useSession } from "@/lib/session";
import { setTheme, type Theme, useTheme } from "@/lib/theme";

/** A browser, said shortly from its user agent: "Firefox on macOS". */
export function browserOf(agent: string | null | undefined): string {
  if (agent === null || agent === undefined || agent === "") return "A browser";
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "A browser";
  const system = /iPhone|iPad/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android" : /Mac OS X/.test(agent) ? "macOS" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : undefined;
  return system === undefined ? browser : `${browser} on ${system}`;
}

/** A row of the shared look, its control below its text on a phone when both do not fit. */
const SettingsRow = (props: Parameters<typeof SharedRow>[0]) => <SharedRow wrap {...props} />;

type Note = { tone: "problem" | "done"; text: string };

/** A short line under a section's rows: what happened, or what went wrong. */
const Said = ({ note }: { note: Note | undefined }) => (note === undefined ? null : <div className="mt-3">{<FormNote tone={note.tone}>{note.text}</FormNote>}</div>);

function Loading() {
  return (
    <div className="flex items-center gap-2.5 py-3 text-[13px] text-ink-3">
      <LoaderGrid /> Loading
    </div>
  );
}

function ProfileSection() {
  const { me, reloadMe } = useSession();
  const [name, setName] = useState(me.user.name);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const id = useId();
  const changed = name.trim() !== "" && name.trim() !== me.user.name;

  const save = async () => {
    if (!changed || busy) return;
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
    <div>
      <SettingsRow label="Name" description="How the assistant and this page call you." htmlFor={id}>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input
            id={id}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && name !== me.user.name && (event.preventDefault(), setName(me.user.name))}
            autoComplete="name"
            maxLength={100}
            spellCheck={false}
            className="h-8 w-44 rounded-control bg-surface px-2.5 text-[13px] text-ink shadow-btn outline-none transition-shadow duration-100 focus-visible:shadow-[0_0_0_1px_var(--line-strong),0_0_0_3px_var(--accent-tint)] sm:w-56"
          />
          <Button size="sm" type="submit" variant="primary" disabled={!changed || busy} aria-busy={busy}>
            {busy && <Spinner />}
            Save
          </Button>
        </form>
      </SettingsRow>
      <SettingsRow label="Email" description="How you are known here: it does not change.">
        <span className="max-w-56 truncate text-[13px] text-ink-2" title={me.user.email}>
          {me.user.email}
        </span>
      </SettingsRow>
      <Said note={note} />
    </div>
  );
}

/** Current, new and the new one again: changed, every other browser signed out. */
function ChangePasswordDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setCurrent("");
    setNext("");
    setAgain("");
    setProblem(undefined);
  }, [open]);

  const change = async () => {
    if (next !== again) {
      setProblem("The two new passwords are not the same.");
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      await changePassword(current, next);
      onChanged();
      onClose();
    } catch (error) {
      setProblem(asError(error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title="Change password" description="Every other browser signed in as you is signed out." onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void change();
        }}
      >
        <TextField label="Current password" type="password" value={current} onChange={setCurrent} autoComplete="current-password" autoFocus required />
        <TextField label="New password" type="password" value={next} onChange={setNext} autoComplete="new-password" required minLength={8} maxLength={128} help="At least 8 characters." />
        <TextField label="The new one again" type="password" value={again} onChange={setAgain} autoComplete="new-password" required minLength={8} maxLength={128} />
        {problem !== undefined && <FormNote>{problem}</FormNote>}
        <div className="mt-1 flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" type="submit" variant="primary" disabled={busy} aria-busy={busy}>
            {busy && <Spinner />}
            Change password
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PasswordSection() {
  const { config, me } = useSession();
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const hasPassword = me.methods.includes("password");

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
    <div>
      {hasPassword ? (
        <SettingsRow label="Password" description="Changing it signs every other browser out.">
          <Button size="sm" onClick={() => (setNote(undefined), setChanging(true))}>
            Change password
          </Button>
        </SettingsRow>
      ) : (
        <SettingsRow
          label="No password yet"
          description={config.email ? "You sign in another way. To have a password too, we email you a link that sets one." : "You sign in another way. To have a password too, ask whoever runs this assistant for a link."}
        >
          {config.email && (
            <Button size="sm" disabled={busy} aria-busy={busy} onClick={() => void emailLink()}>
              {busy && <Spinner />}
              Set a password
            </Button>
          )}
        </SettingsRow>
      )}
      <Said note={note} />
      <ChangePasswordDialog open={changing} onClose={() => setChanging(false)} onChanged={() => setNote({ tone: "done", text: "Password changed. Every other browser is signed out." })} />
    </div>
  );
}

function AccountsSection() {
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
    <div>
      {error !== undefined && <ErrorNote error={error} />}
      {accounts === undefined && error === undefined && <Loading />}
      {accounts !== undefined &&
        providersOf(config).map((provider) => {
          const account = accounts.find((each) => each.providerId === provider.id);
          if (account === undefined) {
            return (
              <SettingsRow key={provider.id} label={provider.name} description="Not connected: sign in with it too (its email must be yours, verified).">
                <Button size="sm" disabled={busy !== undefined} aria-busy={busy === provider.id} onClick={() => link(provider.id)}>
                  {busy === provider.id && <Spinner />}
                  Connect
                </Button>
              </SettingsRow>
            );
          }
          const only = accounts.length < 2;
          return (
            <SettingsRow key={provider.id} label={providerName(config, provider.id)} description={`Connected ${formatAgo(Date.parse(account.createdAt))}${only ? ": your only way to sign in" : ""}`}>
              <div className="flex items-center gap-2">
                <StatusPill tone="green">Connected</StatusPill>
                {!only && (
                  <Button size="sm" disabled={busy !== undefined} aria-busy={busy === account.id} onClick={() => void unlink(account)}>
                    Disconnect
                  </Button>
                )}
              </div>
            </SettingsRow>
          );
        })}
    </div>
  );
}

function SessionsSection() {
  const [sessions, setSessions] = useState<Session[]>();
  const [mine, setMine] = useState<string>();
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<Note>();

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

  const act = async (key: string, action: () => Promise<void>, done?: string) => {
    setBusy(key);
    setNote(undefined);
    try {
      await action();
      load();
      if (done !== undefined) setNote({ tone: "done", text: done });
    } catch (thrown) {
      setError(asError(thrown));
    } finally {
      setBusy(undefined);
    }
  };
  const ordered = [...(sessions ?? [])].sort((a, b) => Number(b.id === mine) - Number(a.id === mine));
  const others = ordered.filter((session) => session.id !== mine);
  const detail = (session: Session) => `Active ${formatAgo(Date.parse(session.updatedAt))}${session.ipAddress ? ` · ${session.ipAddress}` : ""}`;

  return (
    <div>
      {error !== undefined && <ErrorNote error={error} />}
      {sessions === undefined && error === undefined && <Loading />}
      {sessions !== undefined && (
        <>
          <SettingsHeading>This device</SettingsHeading>
          {ordered
            .filter((session) => session.id === mine)
            .map((session) => (
              <SettingsRow key={session.id} label={browserOf(session.userAgent)} description={detail(session)}>
                <StatusPill tone="accent">This device</StatusPill>
              </SettingsRow>
            ))}
          <SettingsHeading
            aside={
              others.length > 0 && (
                <Button size="sm" disabled={busy !== undefined} aria-busy={busy === "others"} onClick={() => void act("others", revokeOtherSessions, "Every other session is signed out.")}>
                  {busy === "others" && <Spinner />}
                  Sign out other sessions
                </Button>
              )
            }
          >
            Other sessions
          </SettingsHeading>
          {others.length === 0 && <p className="py-3 text-[13px] text-ink-3">You are signed in nowhere else.</p>}
          {others.map((session) => (
            <SettingsRow key={session.id} label={browserOf(session.userAgent)} description={detail(session)}>
              <Button size="sm" disabled={busy !== undefined} aria-busy={busy === session.id} onClick={() => void act(session.id, () => revokeSession(session.token))}>
                Sign out
              </Button>
            </SettingsRow>
          ))}
          <Said note={note} />
        </>
      )}
    </div>
  );
}

function AppearanceSection() {
  const theme = useTheme();
  return (
    <div>
      <SettingsRow label="Theme" description="Light, dark, or as the system is. This browser's only.">
        <Segmented<Theme>
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: "system", label: "The system's theme", icon: Computer },
            { value: "light", label: "Light mode", icon: SunLight },
            { value: "dark", label: "Dark mode", icon: HalfMoon },
          ]}
        />
      </SettingsRow>
    </div>
  );
}

type Section = SettingsEntry & { component: () => ReactNode };

/** The sections this App's config makes sense of: no Password without passwords, no Connected accounts without a provider. */
export function settingsSectionsOf(config: ChatConfig): Section[] {
  return [
    { id: "profile", title: "Profile", group: "Account", icon: User, keywords: ["name", "email"], component: ProfileSection },
    ...(offers(config, "password") ? [{ id: "password", title: "Password", group: "Account", icon: Key, keywords: ["change", "set"], component: PasswordSection }] : []),
    ...(providersOf(config).length > 0 ? [{ id: "accounts", title: "Connected accounts", group: "Account", icon: LinkIcon, keywords: ["providers", "link", "connect", ...providersOf(config).map((each) => each.name)], component: AccountsSection }] : []),
    { id: "sessions", title: "Sessions", group: "Account", icon: Laptop, keywords: ["browsers", "devices", "sign out"], component: SessionsSection },
    { id: "appearance", title: "Appearance", group: "This browser", icon: Palette, keywords: ["theme", "dark", "light"], component: AppearanceSection },
  ];
}

/** The modal, at `section` (an id) while open (`undefined`: closed). */
export function SettingsModal({ section, onClose }: { section: string | undefined; onClose: () => void }) {
  const { config } = useSession();
  const open = section !== undefined;
  const ref = useRef<HTMLDialogElement>(null);
  const choice = useSettingsChoice(settingsSectionsOf(config), open, section);
  const Current = choice.current?.component;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label="Settings"
      // React passes a dialog's close up its tree: the change-password dialog's is not this one's.
      onClose={(event) => event.target === event.currentTarget && onClose()}
      onClick={(event) => event.target === ref.current && onClose()}
      className={`m-0 max-h-none max-w-none border-0 p-0 backdrop:bg-black/30 backdrop:backdrop-blur-[1px] ${open ? settingsFrameClass(true) : ""}`}
      style={open ? SETTINGS_FRAME_STYLE : undefined}
    >
      {open && (
        <SettingsPanels choice={choice} onClose={onClose} fullScreenOnMobile navClassName="max-h-[38dvh]">
          {Current !== undefined && <Current key={choice.current?.id} />}
        </SettingsPanels>
      )}
    </dialog>
  );
}

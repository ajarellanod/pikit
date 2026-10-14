/**
 * The chat's users (channel-web's `/admin/api/channel-web/*`, `admin-api.ts`): who has an account, how
 * they sign in, when they came and were last seen, who is banned; and what the operator does to them:
 * invite (a link, emailed when an email sender is installed), a password-reset link, ban (every
 * session revoked) or unban, remove (behind a confirmation).
 *
 * A link is shown once, in the dialog that made it (`link.tsx`), and in nothing else: the list never
 * carries one. The list reads 100 users a page, newest first; the search and the filters work on the
 * pages read ("Show more" reads the next).
 */

import { Calendar, Clock, Group, KeyBack, LogIn, Mail, Prohibition, Trash, Undo, User, UserPlus } from "iconoir-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/bui/Button";
import EmptyState from "@/components/bui/EmptyState";
import { FilterChips, type PillTone, StatePill } from "@/components/bui/FilterTable";
import { Page, PageLoading, Section } from "@/components/bui/Page";
import RecordsTable, { type RecordColumn, RecordMark, RecordName, RecordTag, TagList, tagHue } from "@/components/bui/RecordsTable";
import SearchField from "@/components/bui/SearchField";
import { ErrorNote } from "@/components/pikit/error-note";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { every } from "@/lib/activity";
import { api, ApiFailure, post, useApi } from "@/lib/api";
import { formatAgo } from "@/lib/format";
import type { AdminChatInvitation, AdminChatLink, AdminChatUser, AdminChatUsersPage, AdminChatUserState } from "./admin-api";
import { LinkShown } from "./link";

export const BASE = "/channel-web";
const PAGE = 100;

type Filter = "all" | "active" | "invited" | "banned";
type State = Exclude<Filter, "all">;

/** `banned`; `invited` (no way to sign in yet, never seen); else `active`. */
const stateOf = (user: AdminChatUser): State => (user.banned ? "banned" : user.methods.length === 0 && user.lastSeenAt === undefined ? "invited" : "active");
const TONE: Record<State, PillTone> = { active: "green", invited: "blue", banned: "red" };
const nameOf = (user: AdminChatUser) => (user.name.trim() === "" ? user.email : user.name);

/** What a dialog is about: the invitation form, a link just made, or a confirmation. */
type Dialog =
  | { kind: "invite"; email?: string; name?: string }
  | { kind: "link"; title: string; what: string; link: AdminChatLink }
  | { kind: "ban" | "remove"; user: AdminChatUser };

const fieldClass = "h-9 w-full rounded-lg bg-field px-3 text-[13px] text-ink shadow-[var(--shadow-hairline)] outline-none placeholder:text-ink-3 focus-visible:shadow-[0_0_0_1px_var(--line-strong),0_0_0_3px_var(--accent-tint)]";

const asError = (thrown: unknown): Error => (thrown instanceof Error ? thrown : new Error(String(thrown)));

/** What a refusal of an action means to the operator; anything else as the API said it. */
function refusal(thrown: unknown): Error {
  if (thrown instanceof ApiFailure && thrown.body.error === "exists") return new ApiFailure(409, { error: "exists", message: "That email has an account in use: make a password-reset link for it instead." });
  if (thrown instanceof ApiFailure && thrown.status === 404 && thrown.body.error === "not_found") return new ApiFailure(404, { error: "not_found", message: "No such user (removed meanwhile?)." });
  return asError(thrown);
}

export function UsersPage() {
  const first = useApi<AdminChatUsersPage>(`${BASE}/users?limit=${PAGE}`, every(60_000));
  /** Pages read past the first, and the cursor after them. */
  const [more, setMore] = useState<{ items: AdminChatUser[]; next?: string }>();
  const [reading, setReading] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [dialog, setDialog] = useState<Dialog>();
  const [busy, setBusy] = useState<string>();
  const [failed, setFailed] = useState<Error>();

  if (first.error !== undefined && first.data === undefined) {
    return (
      <Page eyebrow="Web users">
        <ErrorNote error={first.error} title="The chat's users cannot be read" />
      </Page>
    );
  }
  if (first.data === undefined) return <PageLoading eyebrow="Web users" />;

  // A user may be on two pages read at different times (the first is read again): shown once.
  const users = [...new Map([...first.data.items, ...(more?.items ?? [])].map((user) => [user.id, user])).values()];
  const next = more === undefined ? first.data.next : more.next;
  const count = (state: State) => users.filter((user) => stateOf(user) === state).length;
  const needle = query.trim().toLowerCase();
  const rows = users.filter((user) => (filter === "all" || stateOf(user) === filter) && (needle === "" || `${user.name} ${user.email} ${user.id}`.toLowerCase().includes(needle)));

  /** After an action: the list from its first page again. */
  const refresh = () => {
    setMore(undefined);
    first.reload();
  };
  const readMore = async () => {
    if (next === undefined) return;
    setReading(true);
    setFailed(undefined);
    try {
      const page = await api<AdminChatUsersPage>(`${BASE}/users?limit=${PAGE}&cursor=${encodeURIComponent(next)}`);
      setMore({ items: [...(more?.items ?? []), ...page.items], ...(page.next !== undefined && { next: page.next }) });
    } catch (thrown) {
      setFailed(asError(thrown));
    } finally {
      setReading(false);
    }
  };
  const act = async (user: AdminChatUser, work: () => Promise<void>) => {
    setBusy(user.id);
    setFailed(undefined);
    try {
      await work();
    } catch (thrown) {
      setFailed(refusal(thrown));
    } finally {
      setBusy(undefined);
    }
  };
  const path = (user: AdminChatUser, action?: string) => `${BASE}/users/${encodeURIComponent(user.id)}${action === undefined ? "" : `/${action}`}`;

  const resetLink = (user: AdminChatUser) =>
    act(user, async () => {
      const link = await post<AdminChatLink>(path(user, "password-reset"));
      setDialog({ kind: "link", title: `A password-reset link for ${nameOf(user)}`, what: "password-reset link", link });
    });
  const setBanned = (user: AdminChatUser, banned: boolean) =>
    act(user, async () => {
      await post<AdminChatUserState>(path(user, banned ? "ban" : "unban"));
      refresh();
    });
  const remove = (user: AdminChatUser) =>
    act(user, async () => {
      await api<unknown>(path(user), { method: "DELETE" });
      refresh();
    });

  const columns: RecordColumn<AdminChatUser>[] = [
    {
      key: "name",
      label: "User",
      icon: <User />,
      width: 220,
      sort: (a, b) => nameOf(a).localeCompare(nameOf(b)),
      title: (row) => `${row.name} (${row.id})`,
      cell: (row) => (
        <>
          <RecordMark name={nameOf(row)} />
          <RecordName>{nameOf(row)}</RecordName>
        </>
      ),
    },
    {
      key: "email",
      label: "Email",
      icon: <Mail />,
      width: 240,
      sort: (a, b) => a.email.localeCompare(b.email),
      title: (row) => (row.emailVerified ? `${row.email} (verified)` : `${row.email} (not verified)`),
      cell: (row) => <span className="truncate text-ink-2">{row.email}</span>,
    },
    {
      key: "methods",
      label: "Signs in with",
      icon: <LogIn />,
      width: 170,
      cell: (row) => <TagList tags={row.methods} empty="nothing yet" render={(method) => <RecordTag base={tagHue(method)}>{method}</RecordTag>} />,
    },
    { key: "state", label: "State", icon: <Prohibition />, width: 110, sort: (a, b) => stateOf(a).localeCompare(stateOf(b)), cell: (row) => <StatePill tone={TONE[stateOf(row)]}>{stateOf(row)}</StatePill> },
    {
      key: "created",
      label: "Created",
      icon: <Calendar />,
      width: 130,
      sort: (a, b) => a.createdAt - b.createdAt,
      title: (row) => new Date(row.createdAt).toLocaleString(),
      cell: (row) => <span className="text-ink-2">{formatAgo(row.createdAt)}</span>,
    },
    {
      key: "seen",
      label: "Last seen",
      icon: <Clock />,
      width: 130,
      sort: (a, b) => (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0),
      muted: (row) => row.lastSeenAt === undefined,
      title: (row) => (row.lastSeenAt === undefined ? undefined : new Date(row.lastSeenAt).toLocaleString()),
      cell: (row) => (row.lastSeenAt === undefined ? "never" : formatAgo(row.lastSeenAt)),
    },
    {
      key: "actions",
      label: "",
      width: 290,
      cell: (row) => {
        const disabled = busy !== undefined;
        return (
          <span className="flex items-center gap-1">
            {stateOf(row) === "invited" ? (
              <Button size="xs" variant="quiet" disabled={disabled} onClick={() => setDialog({ kind: "invite", email: row.email, name: row.name })} title="A new invitation link">
                <UserPlus width={13} height={13} strokeWidth={1.8} /> Invite again
              </Button>
            ) : (
              <Button size="xs" variant="quiet" disabled={disabled} onClick={() => void resetLink(row)} title="A link that sets a new password">
                <KeyBack width={13} height={13} strokeWidth={1.8} /> Reset link
              </Button>
            )}
            {row.banned ? (
              <Button size="xs" variant="quiet" disabled={disabled} onClick={() => void setBanned(row, false)}>
                <Undo width={13} height={13} strokeWidth={1.8} /> Unban
              </Button>
            ) : (
              <Button size="xs" variant="quiet" disabled={disabled} onClick={() => setDialog({ kind: "ban", user: row })}>
                <Prohibition width={13} height={13} strokeWidth={1.8} /> Ban
              </Button>
            )}
            <Button size="xs" variant="quiet" disabled={disabled} className="text-red" onClick={() => setDialog({ kind: "remove", user: row })}>
              <Trash width={13} height={13} strokeWidth={1.8} /> Remove
            </Button>
          </span>
        );
      },
    },
  ];

  const banned = count("banned");
  return (
    <Page
      eyebrow="Web users"
      title={users.length === 0 ? "Nobody has an account yet" : `${users.length}${next === undefined ? "" : "+"} ${users.length === 1 ? "person" : "people"} with an account`}
      aside={
        <Button variant="primary" size="sm" onClick={() => setDialog({ kind: "invite" })}>
          <UserPlus width={14} height={14} strokeWidth={1.8} /> Invite
        </Button>
      }
      description={
        <>
          The people who talk to the assistant from the chat page (<code className="font-mono text-[12.5px]">/chat/</code>), each in conversations only they see. Invite someone with a link;
          ban or remove anyone. A ban or a removal revokes their sessions at once, but a session its signed cookie vouches for stays good for at most a few minutes (the component's{" "}
          <code className="font-mono text-[12.5px]">sessionCacheSeconds</code>). Who may make an account themselves is in Settings, Web chat.
        </>
      }
    >
      {first.error !== undefined && <ErrorNote error={first.error} title="Not read again" />}
      {failed !== undefined && <ErrorNote error={failed} title="Not done" />}
      <Section
        title="Users"
        meta={users.length}
        tools={
          <>
            <SearchField value={query} onChange={setQuery} placeholder="Name, email or id" label="Search the users" className="w-56" />
            <FilterChips
              label="Show the users who are"
              value={filter}
              onChange={setFilter}
              filters={[
                { key: "all", label: "All", count: users.length },
                { key: "active", label: "Active", tone: "green", count: count("active") },
                { key: "invited", label: "Invited", tone: "blue", count: count("invited") },
                { key: "banned", label: "Banned", tone: "red", count: banned },
              ]}
            />
          </>
        }
      >
        <RecordsTable
          label="The chat's users"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          empty={
            users.length === 0 ? (
              <EmptyState icon={<Group />} title="No user yet" hint="Invite someone (Invite, above), or let people sign up: Settings, Web chat." />
            ) : (
              <EmptyState icon={<Group />} title="Nobody matches" hint={next === undefined ? "Clear the search or pick another filter." : "Clear the search, pick another filter, or show more users."} />
            )
          }
        />
        {next !== undefined && (
          <div>
            <Button size="sm" variant="secondary" disabled={reading} onClick={() => void readMore()}>
              {reading ? "Reading" : "Show more"}
            </Button>
          </div>
        )}
      </Section>

      <AlertDialog open={dialog !== undefined} onOpenChange={(open) => !open && setDialog(undefined)}>
        <AlertDialogContent>
          {dialog?.kind === "invite" && (
            <InviteForm
              initial={dialog}
              onDone={(invitation) => {
                refresh();
                setDialog({ kind: "link", title: "Invited", what: "invitation link", link: invitation });
              }}
            />
          )}
          {dialog?.kind === "link" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{dialog.title}</AlertDialogTitle>
                <AlertDialogDescription>Copy it now: it is not shown again. Anyone with it can set the password.</AlertDialogDescription>
              </AlertDialogHeader>
              <LinkShown link={dialog.link} what={dialog.what} />
              <AlertDialogFooter>
                <AlertDialogCancel>Done</AlertDialogCancel>
              </AlertDialogFooter>
            </>
          )}
          {(dialog?.kind === "ban" || dialog?.kind === "remove") && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{`${dialog.kind === "ban" ? "Ban" : "Remove"} ${nameOf(dialog.user)}?`}</AlertDialogTitle>
                <AlertDialogDescription>
                  {dialog.kind === "ban"
                    ? `${dialog.user.email} is signed out everywhere and cannot sign in until you unban them. Their conversations stay.`
                    : `${dialog.user.email}'s account, sessions and sign-in methods are deleted, and their conversations leave their list (the assistant keeps them). They can come back only as a new user.`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    const { user } = dialog;
                    setDialog(undefined);
                    void (dialog.kind === "ban" ? setBanned(user, true) : remove(user));
                  }}
                >
                  {dialog.kind === "ban" ? "Ban" : "Remove"}
                </Button>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

/** The invitation: an email and an optional name; on success, the link (shown by the caller). */
function InviteForm({ initial, onDone }: { initial: { email?: string; name?: string }; onDone: (invitation: AdminChatInvitation) => void }) {
  const [email, setEmail] = useState(initial.email ?? "");
  const [name, setName] = useState(initial.name ?? "");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<Error>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setFailed(undefined);
    try {
      onDone(await post<AdminChatInvitation>(`${BASE}/invitations`, { email: email.trim(), ...(name.trim() !== "" && { name: name.trim() }) }));
    } catch (thrown) {
      setFailed(refusal(thrown));
      setSending(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="contents">
      <AlertDialogHeader>
        <AlertDialogTitle>Invite someone</AlertDialogTitle>
        <AlertDialogDescription>They get a link that sets their password (or lets them sign in with a provider). You see it once, to send it yourself; it is emailed too when an email sender is installed.</AlertDialogDescription>
      </AlertDialogHeader>
      <div className="flex flex-col gap-2">
        <input type="email" required maxLength={254} autoFocus value={email} onChange={(event) => setEmail(event.target.value)} placeholder="ana@example.com" aria-label="Their email" className={fieldClass} />
        <input type="text" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Their name (optional)" aria-label="Their name (optional)" className={fieldClass} />
      </div>
      {failed !== undefined && <ErrorNote error={failed} title="Not invited" />}
      <AlertDialogFooter>
        <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
        <Button type="submit" size="sm" variant="primary" disabled={sending || email.trim() === ""}>
          {sending ? "Inviting" : "Invite"}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

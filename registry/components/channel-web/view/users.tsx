/**
 * The chat's users (channel-web's `/admin/api/channel-web/*`, `admin-api.ts`): who has an account, how
 * they sign in, when they came and were last seen, who is banned; and what the operator does to them:
 * invite (a link, emailed when an email sender is installed), a password-reset link, ban (every
 * session revoked) or unban, remove (behind a confirmation).
 *
 * A link is shown once, in the dialog that made it (`link.tsx`), and in nothing else: the list never
 * carries one. The list is the server's, 20 users a page, newest first: the search and the state's
 * filter are the route's (`q`, `state`), so the chips' counts and the footer's total are of every user,
 * not of a page read.
 */

import { Calendar, Clock, Group, KeyBack, LogIn, Mail, Prohibition, Trash, Undo, User, UserPlus } from "iconoir-react";
import { type FormEvent, useEffect, useState } from "react";
import { ActionsMenu } from "@/components/bui/ActionsMenu";
import { Button } from "@/components/bui/Button";
import EmptyState from "@/components/bui/EmptyState";
import { Field } from "@/components/bui/Field";
import { FilterChips, type PillTone } from "@/components/bui/FilterTable";
import { Page, PageLoading } from "@/components/bui/Page";
import RecordsTable, { type RecordColumn, RecordMark, RecordName, RecordTag, TagList } from "@/components/bui/RecordsTable";
import SearchField from "@/components/bui/SearchField";
import { StatusDot } from "@/components/bui/StatusDot";
import { ErrorNote } from "@/components/pikit/error-note";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { every } from "@/lib/activity";
import { api, ApiFailure, post, useApi } from "@/lib/api";
import { formatAgo } from "@/lib/format";
import type { AdminChatInvitation, AdminChatLink, AdminChatUser, AdminChatUsersPage, AdminChatUserState } from "./admin-api";
import { LinkShown } from "./link";

export const BASE = "/channel-web";
const PAGE = 20;
/** ms the search waits for the typing to stop before it asks. */
const SEARCH_WAIT = 250;

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

const fieldClass = "control w-full";

/** The dialogs' widths: a link's is wide enough for it; the invitation and a confirmation are narrow. */
const DIALOG = { narrow: "data-[size=default]:sm:max-w-[440px]", link: "data-[size=default]:sm:max-w-[600px]" };

const asError = (thrown: unknown): Error => (thrown instanceof Error ? thrown : new Error(String(thrown)));

/** What a refusal of an action means to the operator; anything else as the API said it. */
function refusal(thrown: unknown): Error {
  if (thrown instanceof ApiFailure && thrown.body.error === "exists") return new ApiFailure(409, { error: "exists", message: "That email has an account in use: make a password-reset link for it instead." });
  if (thrown instanceof ApiFailure && thrown.status === 404 && thrown.body.error === "not_found") return new ApiFailure(404, { error: "not_found", message: "No such user (removed meanwhile?)." });
  return asError(thrown);
}

export function UsersPage() {
  const [query, setQuery] = useState("");
  /** The search the route is asked: the query once the typing stops. */
  const [needle, setNeedle] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog>();
  const [failed, setFailed] = useState<Error>();
  // Another search or filter starts at its first page.
  useEffect(() => {
    const wait = setTimeout(() => {
      if (query.trim() === needle) return;
      setNeedle(query.trim());
      setPage(1);
    }, SEARCH_WAIT);
    return () => clearTimeout(wait);
  }, [query, needle]);
  const show = (next: Filter) => {
    setFilter(next);
    setPage(1);
  };
  const params = new URLSearchParams({ limit: String(PAGE), offset: String((page - 1) * PAGE) });
  if (filter !== "all") params.set("state", filter);
  if (needle !== "") params.set("q", needle);
  const listed = useApi<AdminChatUsersPage>(`${BASE}/users?${params}`, every(60_000));
  const data = listed.data;
  // A page past the last (its users removed meanwhile): the last one.
  const pages = data === undefined ? 1 : Math.max(Math.ceil(data.total / PAGE), 1);
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);

  if (listed.error !== undefined && data === undefined) {
    return (
      <Page eyebrow="Web users">
        <ErrorNote error={listed.error} title="The chat's users cannot be read" />
      </Page>
    );
  }
  if (data === undefined) return <PageLoading eyebrow="Web users" />;

  const { counts } = data;
  const nobody = counts.all === 0 && needle === "";
  /** After an action: the page read again (a removed user's place taken by the next). */
  const refresh = () => listed.reload();
  const act = async (work: () => Promise<void>) => {
    setFailed(undefined);
    try {
      await work();
    } catch (thrown) {
      setFailed(refusal(thrown));
    }
  };
  const path = (user: AdminChatUser, action?: string) => `${BASE}/users/${encodeURIComponent(user.id)}${action === undefined ? "" : `/${action}`}`;

  const resetLink = (user: AdminChatUser) =>
    act(async () => {
      const link = await post<AdminChatLink>(path(user, "password-reset"));
      setDialog({ kind: "link", title: `Password-reset link for ${nameOf(user)}`, what: "password-reset link", link });
    });
  const setBanned = (user: AdminChatUser, banned: boolean) =>
    act(async () => {
      await post<AdminChatUserState>(path(user, banned ? "ban" : "unban"));
      refresh();
    });
  const remove = (user: AdminChatUser) =>
    act(async () => {
      await api<unknown>(path(user), { method: "DELETE" });
      refresh();
    });

  const columns: RecordColumn<AdminChatUser>[] = [
    {
      key: "name",
      label: "User",
      icon: <User />,
      width: 190,
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
      width: 220,
      sort: (a, b) => a.email.localeCompare(b.email),
      title: (row) => (row.emailVerified ? `${row.email} (verified)` : `${row.email} (not verified)`),
      cell: (row) => <span className="truncate text-ink-2">{row.email}</span>,
    },
    {
      key: "methods",
      label: "Signs in with",
      icon: <LogIn />,
      width: 140,
      cell: (row) => <TagList tags={row.methods} empty="nothing yet" render={(method) => <RecordTag>{method}</RecordTag>} />,
    },
    { key: "state", label: "State", icon: <Prohibition />, width: 100, sort: (a, b) => stateOf(a).localeCompare(stateOf(b)), cell: (row) => <StatusDot tone={TONE[stateOf(row)]}>{stateOf(row)}</StatusDot> },
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
      width: 120,
      sort: (a, b) => (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0),
      muted: (row) => row.lastSeenAt === undefined,
      title: (row) => (row.lastSeenAt === undefined ? undefined : new Date(row.lastSeenAt).toLocaleString()),
      cell: (row) => (row.lastSeenAt === undefined ? "never" : formatAgo(row.lastSeenAt)),
    },
    {
      key: "actions",
      label: "",
      width: 48,
      cell: (row) => (
        <ActionsMenu
          label={`Actions for ${nameOf(row)}`}
          className="btn btn-ghost btn-xs btn-icon size-7 text-ink-2 hover:text-ink aria-expanded:text-ink"
          actions={[
            stateOf(row) === "invited"
              ? { key: "invite", label: "Invite again", icon: <UserPlus />, onSelect: () => setDialog({ kind: "invite", email: row.email, name: row.name }) }
              : { key: "reset", label: "Reset link", icon: <KeyBack />, onSelect: () => void resetLink(row) },
            row.banned
              ? { key: "unban", label: "Unban", icon: <Undo />, onSelect: () => void setBanned(row, false) }
              : { key: "ban", label: "Ban", icon: <Prohibition />, onSelect: () => setDialog({ kind: "ban", user: row }) },
            { key: "remove", label: "Remove", icon: <Trash />, danger: true, onSelect: () => setDialog({ kind: "remove", user: row }) },
          ]}
        />
      ),
    },
  ];

  return (
    <Page
      eyebrow="Web users"
      title={nobody ? "Nobody has an account yet" : "Who has an account"}
      description={
        <>
          People who use the chat page at <code className="font-mono text-[12.5px]">/chat/</code>.
        </>
      }
    >
      {listed.error !== undefined && <ErrorNote error={listed.error} title="Not read again" />}
      {failed !== undefined && <ErrorNote error={failed} title="Not done" />}
      <section className="flex min-w-0 flex-col gap-2.5" aria-label="The chat's users">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <SearchField value={query} onChange={setQuery} placeholder="Name, email or id" label="Search the users" className="w-60" />
          <FilterChips
            label="Show the users who are"
            value={filter}
            onChange={show}
            filters={[
              { key: "all", label: "All", count: counts.all },
              { key: "active", label: "Active", tone: "green", count: counts.active },
              { key: "invited", label: "Invited", tone: "blue", count: counts.invited },
              { key: "banned", label: "Banned", tone: "red", count: counts.banned },
            ]}
          />
          <Button variant="primary" className="ml-auto" onClick={() => setDialog({ kind: "invite" })}>
            <UserPlus width={15} height={15} strokeWidth={1.8} /> Invite
          </Button>
        </div>
        <RecordsTable
          label="The chat's users"
          columns={columns}
          rows={data.items}
          rowKey={(row) => row.id}
          paging={{ page: Math.min(page, pages), pageSize: PAGE, total: data.total, onPageChange: setPage }}
          empty={
            nobody ? (
              <EmptyState icon={<Group />} title="No users yet" hint="Invite someone to get started." />
            ) : (
              <EmptyState icon={<Group />} title="Nobody matches" hint="Try another search or filter." />
            )
          }
        />
      </section>

      <AlertDialog open={dialog !== undefined} onOpenChange={(open) => !open && setDialog(undefined)}>
        <AlertDialogContent className={dialog?.kind === "link" ? DIALOG.link : DIALOG.narrow}>
          {dialog?.kind === "invite" && (
            <InviteForm
              initial={dialog}
              onCancel={() => setDialog(undefined)}
              onDone={(invitation, email) => {
                refresh();
                setDialog({ kind: "link", title: `Invitation link for ${email}`, what: "invitation link", link: invitation });
              }}
            />
          )}
          {dialog?.kind === "link" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{dialog.title}</AlertDialogTitle>
                <AlertDialogDescription>Copy it now: it is shown only once, and anyone with it can set the password.</AlertDialogDescription>
              </AlertDialogHeader>
              <LinkShown link={dialog.link} what={dialog.what} />
              <AlertDialogFooter>
                <Button size="sm" variant="primary" onClick={() => setDialog(undefined)}>
                  Done
                </Button>
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
                <Button size="sm" variant="ghost" onClick={() => setDialog(undefined)}>
                  Cancel
                </Button>
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
function InviteForm({ initial, onCancel, onDone }: { initial: { email?: string; name?: string }; onCancel: () => void; onDone: (invitation: AdminChatInvitation, email: string) => void }) {
  const [email, setEmail] = useState(initial.email ?? "");
  const [name, setName] = useState(initial.name ?? "");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<Error>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setFailed(undefined);
    try {
      onDone(await post<AdminChatInvitation>(`${BASE}/invitations`, { email: email.trim(), ...(name.trim() !== "" && { name: name.trim() }) }), email.trim());
    } catch (thrown) {
      setFailed(refusal(thrown));
      setSending(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="contents">
      <AlertDialogHeader>
        <AlertDialogTitle>{initial.email === undefined ? "Invite someone" : "Invite again"}</AlertDialogTitle>
        <AlertDialogDescription>They get a link to set their password.</AlertDialogDescription>
      </AlertDialogHeader>
      <div className="flex flex-col gap-4">
        <Field label="Email" required>
          {(control) => <input {...control} type="email" maxLength={254} autoFocus autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="ana@example.com" className={fieldClass} />}
        </Field>
        <Field label="Name" required={false}>
          {(control) => <input {...control} type="text" maxLength={120} autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ana López" className={fieldClass} />}
        </Field>
      </div>
      {failed !== undefined && <ErrorNote error={failed} title="Not invited" />}
      <AlertDialogFooter>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={sending || email.trim() === ""}>
          {sending ? "Inviting" : "Invite"}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

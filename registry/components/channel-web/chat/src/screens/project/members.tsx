/**
 * A project's Members: who is in it (initials, the owner first), added by email by any member (a user
 * of this chat, or a person the App's directory knows; never an address from outside). The owner hands
 * the project to a member and removes others; anyone leaves (the owner only after handing it over). A
 * member kept in step with a linked space (a Google Chat space) follows it, and is not removed here.
 */

import { LogOut, Plus, Trash, UserCrown } from "iconoir-react";
import { useState } from "react";
import { ActionsMenu, type ActionsMenuItem } from "@/components/bui/ActionsMenu";
import { Badge } from "@/components/bui/Badge";
import { Button } from "@/components/bui/Button";
import { Section } from "@/components/bui/Page";
import { ConfirmDialog } from "@/components/chat/dialog";
import { TextField } from "@/components/chat/field";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ChatMember, type ChatPage, memberKey } from "@/lib/chat-api";
import { post, request, useGet } from "@/lib/client";
import { go } from "@/lib/location";
import { principalName, projectApi } from "@/lib/project";
import { PROJECTS_PATH } from "@/lib/routes";
import { useSession } from "@/lib/session";
import type { TabProps } from "./index";
import { AuthorLine, Avatar, useAction } from "./parts";

export function MembersTab({ overview, changed }: TabProps) {
  const { me } = useSession();
  const { project } = overview;
  const read = useGet<ChatPage<ChatMember>>(projectApi(project.id, "/members?limit=100"));
  const [email, setEmail] = useState("");
  const [leaving, setLeaving] = useState(false);
  const action = useAction();
  const owner = project.role === "owner";
  const after = () => {
    read.reload();
    changed();
  };
  const remove = (member: ChatMember) =>
    action.run(async () => {
      await request("DELETE", projectApi(project.id, `/members/${encodeURIComponent(memberKey(member.principal))}`));
      if (member.you) go(PROJECTS_PATH, true);
      else after();
    });

  const actionsOf = (member: ChatMember): ActionsMenuItem[] => {
    if (member.you) return member.role === "owner" ? [] : [{ key: "leave", label: "Leave the project", icon: <LogOut />, danger: true, onSelect: () => setLeaving(true) }];
    if (!owner) return [];
    return [
      ...(member.source === "manual"
        ? [
            {
              key: "owner",
              label: "Make them the owner",
              icon: <UserCrown />,
              onSelect: () =>
                void action.run(async () => {
                  await post(projectApi(project.id, "/owner"), { channel: member.principal.channel, id: member.principal.id });
                  after();
                }),
            },
            { key: "remove", label: "Remove from the project", icon: <Trash />, danger: true, onSelect: () => void remove(member) },
          ]
        : []),
    ];
  };

  return (
    <Section title="Members" meta={String(project.members)}>
      <p className="text-[12.5px] text-ink-3">Every member reads and changes everything in the project, and its chats. Any member adds people; the owner removes them, chooses the project's assistants and archives it.</p>
      {action.error !== undefined && <ErrorNote error={action.error} title="That did not work" />}
      {read.error !== undefined && <ErrorNote error={read.error} title="The members cannot be read" />}
      <ul className="records-shell flex flex-col divide-y divide-line">
        {(read.data?.items ?? []).map((member) => {
          const actions = actionsOf(member);
          return (
            <li key={`${member.principal.channel}:${member.principal.id}`} className="flex items-center gap-3 px-3.5 py-2.5">
              <Avatar name={principalName(member.principal)} size={30} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 text-[13.5px] text-ink">
                  <span className="truncate">{principalName(member.principal)}</span>
                  {member.you && <span className="text-[12px] text-ink-3">you</span>}
                  {member.role === "owner" && <Badge tone="accent">Owner</Badge>}
                  {member.source !== "manual" && <Badge title={`Kept in step with ${member.source}`}>Linked</Badge>}
                  {!member.current && <Badge tone="orange">Not checked lately</Badge>}
                </span>
                <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
                  {member.principal.channel === "web" ? "This chat" : member.principal.channel} · added by <AuthorLine by={member.by} at={member.at} me={me.user.id} />
                </span>
              </div>
              {actions.length > 0 && !project.archived && <ActionsMenu actions={actions} label={`Actions for ${principalName(member.principal)}`} className="btn btn-ghost btn-icon size-7 text-ink-3 hover:text-ink aria-expanded:text-ink" />}
            </li>
          );
        })}
      </ul>
      {!project.archived && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (email.trim() === "") return;
            void action.run(async () => {
              await post(projectApi(project.id, "/members"), { email: email.trim() });
              setEmail("");
              after();
            });
          }}
        >
          <div className="min-w-[240px] flex-1">
            <TextField label="Add someone by email" type="email" value={email} onChange={setEmail} placeholder="ana@example.com" help="Someone who uses this chat (or the App knows)." />
          </div>
          <Button type="submit" disabled={email.trim() === "" || action.busy}>
            <Plus width={14} height={14} strokeWidth={2} aria-hidden /> Add
          </Button>
        </form>
      )}
      <ConfirmDialog
        open={leaving}
        title="Leave this project?"
        description={<>You no longer see “{project.name}”, its chats or its files. A member can add you again.</>}
        action="Leave"
        onClose={() => setLeaving(false)}
        onConfirm={() => {
          const mine = read.data?.items.find((each) => each.you);
          if (mine !== undefined) void remove(mine);
        }}
      />
    </Section>
  );
}

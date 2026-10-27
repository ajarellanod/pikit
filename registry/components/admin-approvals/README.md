# admin-approvals

The dashboard's routes for `approvals`: an operator lists approvals and approves or rejects one. An
operator decides as `{ channel: "dashboard", id: <operator id> }`, held to the approvers the proposer
gave like anyone (`dashboard:*` lets every operator decide). No view yet: the routes are the API a
view would read.

- **Provides:** `http.route`.
- **Requires:** `approvals` (approvals-sql), `actor.mailbox`, `actor.inbox`, `agent.runtime` (the Worker
  half: `approvals` and `actor.mailbox`); `admin.auth` optional (without it nobody is an operator). It
  carries an identical copy of `contract.ts`.
- **Targets:** `server` and `durable` (as approvals-sql). On `durable` the Worker half (`worker.ts`,
  `admin-approvals-worker`) serves the routes over approvals-sql's Worker half; the default export,
  in every object, dispatches the decisions told to its conversation.

## Routes
Every route asks `admin.auth` first: `401` otherwise, and `approvals` is not asked.

| Route | Answer |
|---|---|
| `GET /admin/api/approvals?status=&cursor=&limit=` | `{ items, next? }`, newest first; `400` for a bad status, cursor or limit |
| `POST /admin/api/approvals/:id/decision` `{ "verdict": "approve" \| "reject" }` | `{ approval }`; `404 not_found`, `403 forbidden`, `409 not_pending` / `expired`, `400` for another body |

After a decision taken from the dashboard, the conversation that asked (`requestedBy.conversation`:
for an approval a delegated agent asked through extension-approvals, the chat its task comes from)
gets one message:
`[approvals] Approval <id> ("<title>") was approved by dashboard:<operator>.`, dispatched with the
request id `approval-decided:<id>`, so a repeated click, or a click after a crash between the decision
and the message, never tells it twice. A decision taken in the chat is not told again (the answer
was the message). Decisions are logged with the operator.

The message goes through the asking conversation's actor (`actor.mailbox.send` to its key,
`admin-approvals.decided`), whose App dispatches it: on a server this App, on `durable` the
conversation's object. That handler dispatches only a decision for its own key's conversation, under an
`approval-decided:` request id.

## Tests
`admin-approvals.test.ts` (copied with it): what setup declares, `401` without an operator. The
repository's `app.test.ts`, over approvals-sql: listed and approved as `dashboard:ops`, told with a
stable request id on every click, the other verdict `409`; an operator the approvers do not name
`403`, nothing recorded or told; a chat decision not told again; `404` and `400`; a decision message
for another key, or under another request id, dispatches nothing (checked against a handler without
the key check). The workerd lane (`tests/workerd/test/approvals.workerd.ts`): asked in a conversation's
object, the owner evicted, approved twice through the Worker's routes, told once.

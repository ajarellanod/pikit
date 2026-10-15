# tool-ask-user

The `askUser` tool, for the agents that name it: the agent asks the person it talks to one question,
with fields to answer, and its turn ends there. Where the chat can draw it (Google Chat), the
question is buttons or a form; anywhere else it is text, answered in a reply.

- **Provides:** `agent.tool`, under the key `askUser`.
- **Requires:** nothing.
- **Targets:** `server` and `durable`: it imports nothing platform-specific.
- **Installs to:** `src/pikit/tool-ask-user/` (`index.ts` the component and the tool, `tool-ask-user.test.ts`).

```ts
defineAgent({ name: "assistant", model: "openrouter/z-ai/glm-5.3-flash", tools: ["askUser"] })
```

## What it does

The model gives a `title`, a `description` when the person needs one, and `fields`, each with a
`kind`, a `name` (the answer's key) and a `label`, `required` when it must be answered:

| Kind | Answered with |
|---|---|
| `confirm` | yes or no |
| `select` | one of its `options` (`{ value, label }`) |
| `multiselect` | any of its `options` |
| `text` | free text |
| `date` | a day, `YYYY-MM-DD` |

The call checks the question (`questionProblem` from `@pikit/contracts`: a malformed one is an error
the model reads) and returns it as a `question` part of the run's answer (`AgentResult.parts`, given
with `withParts`), with `control.terminate`: **the run ends with the question, and never waits for
the answer**. A run that waited would hold its conversation (on Cloudflare a Durable Object) for as
long as the person takes.

- **Drawn or folded.** A channel that draws `question` parts (`ChannelTransport.draws`; Google
  Chat: one `confirm` or `select` field as buttons, anything else as a form in a dialog) shows it; any
  other sends its fallback text, which lists the fields and their options and asks for a reply.
- **The answer is a message.** A click, a submitted form, or a reply typed to the fallback arrives as
  an ordinary message. A channel that drew the question writes it with `answerText`
  (`Answer to "<title>" (question <id>):` and each field's label and value); a reply typed to the
  fallback is the person's own words. It starts a new run, which reads it like any message.
- **The model is told the outcome only.** The tool's description says the person may answer with a
  form or in their own words, and that the answer arrives later as a new message; never how a channel
  draws a question (buttons, a dialog) or words its answer. The asker does not know the drawer
  (`@pikit/contracts`' `question.ts`): a channel that draws questions differently, or not at all,
  changes nothing here.
- **The question's id** is `<conversation id>:<request id>:<tool call id>`: the conversation, the
  request that started the run, the call. Unique, and named in a drawn answer's text, so the model
  knows which question an answer is to.
- **A field's name** is `QUESTION_FIELD_NAME` from `@pikit/contracts` (a letter, then letters,
  digits, `_` or `-`): the tool's schema states the pattern `questionProblem` checks, one definition.
- **Replay is `safe`**: a call made again after a crash builds the same part with the same id, and
  sends nothing itself.

Who may answer and how often is the channel's: Google Chat takes the first answer from anyone it
admits in that conversation, once, and none once the conversation was reset (`/new`): a question
belongs to the conversation it was asked in. Several questions may be open in a conversation; each
is answered once.

## Use it with

- **A channel that draws questions** for buttons and forms: `channel-google-chat`. With any other
  channel (Telegram, HTTP, the dashboard) the question is its fallback text, and the person answers
  in a reply, which the model reads as any message.
- **An agent that names it** (`tools: ["askUser"]`), told in its instructions when to ask rather than
  guess. Since the run ends at the question, ask last: what the model writes after the call is never
  said.

## Tests

`tool-ask-user.test.ts` (copied with the component): the tool called directly, in a run and outside
one; its description and parameters naming no drawer; its field name the contracts' pattern; the
component in an App; a Harness turn (`runToolCalls`) where the call ends the run.
`app.test.ts` (in the registry, beside `files/`): runtime-pi runs it, the run ends with the question
in `AgentResult.parts`, and the answer sent as a message starts a run that reads it.

`component.json` is generated from `setup` (`bun run registry generate`); the test "what setup
declares" pins it.

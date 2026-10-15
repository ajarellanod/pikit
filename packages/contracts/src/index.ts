// Public surface of @pikit/contracts (SPEC §3): the vocabulary components share. Types, identities,
// names of events and pipelines, capability interfaces, two protocol functions (`admitInbound` in,
// `startAnswerDelivery` out: the paths every channel must get right, written and tested once, with
// `answerContent`, delivery's rule of what a run's answer is, for a channel to read rather than copy), how a
// message's parts fold into its text for a transport (`foldParts`, `messagePieces`), the `question` part
// shared by who asks and who draws it (`questionPart`, `answerText`), the check of what the contracts take as a JSON object (`isJsonObject`), the grammar of `http.route`
// keys (`parseHttpRouteKey`, `matchesHttpRoute`) and the envelopes of an actor's call and stream
// (`answerCall`, `callResult`, `answerStream`, `streamResult`), so that no provider has its own. No policy: what a protocol waits, retries and says
// is its caller's, passed in. Each contract has a stability level (SPEC K8); the capabilities'
// levels are in the catalogue (`packages/cli/src/registry/capabilities.ts`). What only Cloudflare
// components use (`WORKERS_HOST`) is in `@pikit/contracts/cloudflare`, not here.

export { defineAgent, SKILL_TOOL, skillsProblem, stewardProblem } from "./agent.ts";
export type {
  Admission,
  AgentConversations,
  AgentDefinition,
  AgentImage,
  AgentMessage,
  AgentPayloads,
  AgentRequest,
  AgentResult,
  AgentRuntime,
  AgentTool,
  ConversationRef,
  PrepareContext,
  Sender,
  TurnConfig,
  Usage,
} from "./agent.ts";
export type { AgentSkill } from "./skill.ts";
export { defineSkill, isSkillName, skillProblem } from "./skill.ts";
export type { RunRequest, RunRequests } from "./run-requests.ts";
export { RUN_REQUESTS } from "./run-requests.ts";

export type { AgentDirectory, DirectoryAgent } from "./agent-directory.ts";

export type { AgentCommand, CommandInfo, CommandLookup, CommandOutcome } from "./command.ts";
export { COMMAND_NAME, isCommandName, listAgentCommands, runAgentCommand } from "./command.ts";
export type { CompletionRequest, ModelComplete } from "./model.ts";

export { AgentUnavailableError, admitInbound, isAgentUnavailable } from "./inbound.ts";
export type { AdmitOptions, InboundMessage, InboundOutcome, RouteDecision } from "./inbound.ts";

export type { AgentState } from "./agent-state.ts";
export { AGENT_STATE } from "./agent-state.ts";
export { CONVERSATION } from "./conversation-context.ts";
export type { ConversationRegistry, ConversationReset } from "./conversations.ts";
export type { HttpRoute, HttpRouteKey } from "./http.ts";
export { CLIENT_ADDRESS_HEADER, compareHttpRoutes, matchesHttpRoute, parseHttpRouteKey, withClientAddress } from "./http.ts";
export type { SecretStore } from "./secrets.ts";
export { redactSecrets, SECRET_NAME_PATTERN, secretLikePaths } from "./secrets.ts";
export type { AgentObserver, ObservedConversation, ObservedEvent, TranscriptEntry } from "./observe.ts";
export type { Page, PageRequest } from "./page.ts";
export type { AdminAuth, AdminSessions, Operator } from "./admin.ts";
export { ADMIN_CLIENT_HEADER } from "./admin.ts";
export type { ComponentHealth, HealthRegistry, HealthReporter, HealthSnapshot, HealthStatus } from "./health.ts";
export type { Settings, SettingsErrorCode, SettingsSchema, SettingsValue } from "./settings.ts";
export { credentialSettingProblem, SettingsError, secretSettingProblem } from "./settings.ts";
export type { GitHubAccess } from "./github.ts";
export type { EmailErrorCode, EmailMessage, EmailReceipt, EmailSender } from "./email.ts";
export { EmailError, emailErrorDetail, emailMessageProblem, isEmailAddress, isEmailFrom } from "./email.ts";
export { GITHUB_REPOSITORY, GITHUB_TOKEN_MIN_LIFE_MS, GitHubNotConnectedError, isGitHubNotConnected } from "./github.ts";
export type {
  ActionRefusal,
  ApproveOutcome,
  ApproveRequest,
  DeployRecord,
  ProposalCheck,
  ProposalChecks,
  ProposalDeploy,
  ProposalDetail,
  ProposalFile,
  ProposalList,
  Proposals,
  ProposalsCheck,
  ProposalsErrorCode,
  ProposalsRemote,
  ProposalsStatus,
  ProposalState,
  ProposalSummary,
  RejectOutcome,
  RejectRequest,
} from "./proposals.ts";
export { ProposalsError } from "./proposals.ts";
export type { JsonValue } from "./json.ts";
export { isJsonObject } from "./json.ts";
export type { KeyValueStorage, KeyValueStore, SqlDatabase, SqlRow, SqlStatements, SqlValue } from "./storage.ts";
export type { Feed, FeedItem, FeedPage } from "./feed.ts";
export type {
  ActorCallErrorCode,
  ActorCallHandler,
  ActorCallOutcome,
  ActorInbox,
  ActorInboxHandler,
  ActorMailbox,
  ActorScope,
  ActorStreamHandler,
  ActorStreamOutcome,
} from "./actor.ts";
export { ActorCallError, answerCall, answerStream, callResult, streamResult } from "./actor.ts";
export type { WakeupHandler, Wakeups } from "./wakeups.ts";
export type { AgentSubmissions, PendingConversation, RunSettlement, SubmissionStatus } from "./submissions.ts";
export type {
  ChannelTransport,
  DeliveryErrorKind,
  DeliveryReceipt,
  OutboundMessage,
  OutboundPiece,
  OutboundQueue,
  PendingPiece,
} from "./outbound.ts";
export { answerKey, DeliveryError } from "./outbound.ts";
export type { AppMessageParts, MessageContent, MessagePart } from "./parts.ts";
export { foldParts, messagePieces } from "./parts.ts";
export type { Question, QuestionAnswer, QuestionField, QuestionOption, QuestionPart, QuestionValue } from "./question.ts";
export { answerProblem, answerText, QUESTION_FIELD_KINDS, QUESTION_FIELD_NAME, questionPart, questionProblem } from "./question.ts";
export type { AnswerDelivery, AnswerDeliveryOptions, DeliveryPolicy } from "./delivery.ts";
export { answerContent, answersOnlyTheDashboard, DASHBOARD_REQUEST_PREFIX, isDashboardRequest, startAnswerDelivery } from "./delivery.ts";

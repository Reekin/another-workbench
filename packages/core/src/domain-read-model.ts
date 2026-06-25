import type {
  AgentParticipant,
  ApprovalRequest,
  ChatSession,
  Conversation,
  DomainSnapshot,
  MessageBlock,
  RuntimeInteraction,
  SessionRelation,
  TerminalStream,
  ThreadGoal,
  ToolCall,
  Turn
} from "@another-workbench/shared";
import type {
  ListApprovalRequestsOptions,
  ListMessageBlocksOptions,
  ListParticipantsOptions,
  ListRuntimeInteractionsOptions,
  ListSessionRelationsOptions,
  ListSessionsOptions,
  ListTerminalStreamsOptions,
  ListThreadGoalsOptions,
  ListToolCallsOptions,
  ListTurnsOptions
} from "./domain-store.js";

export type DomainReadModel = {
  getRevision(): number;
  isDisposed(): boolean;
  getSnapshot(): DomainSnapshot;
  getConversationSnapshot(conversationId: string): DomainSnapshot;
  getSessionSnapshot(sessionId: string): DomainSnapshot;
  getConversation(conversationId: string): Conversation | undefined;
  listConversations(): Conversation[];
  getSession(sessionId: string): ChatSession | undefined;
  listSessions(options?: ListSessionsOptions): ChatSession[];
  getTurn(turnId: string): Turn | undefined;
  listTurns(options?: ListTurnsOptions): Turn[];
  getMessageBlock(blockId: string): MessageBlock | undefined;
  listMessageBlocks(options?: ListMessageBlocksOptions): MessageBlock[];
  getToolCall(toolCallId: string): ToolCall | undefined;
  listToolCalls(options?: ListToolCallsOptions): ToolCall[];
  getTerminalStream(terminalId: string): TerminalStream | undefined;
  listTerminalStreams(options?: ListTerminalStreamsOptions): TerminalStream[];
  getApprovalRequest(requestId: string): ApprovalRequest | undefined;
  listApprovalRequests(options?: ListApprovalRequestsOptions): ApprovalRequest[];
  getRuntimeInteraction(requestId: string): RuntimeInteraction | undefined;
  listRuntimeInteractions(options?: ListRuntimeInteractionsOptions): RuntimeInteraction[];
  getParticipant(participantId: string): AgentParticipant | undefined;
  listParticipants(options?: ListParticipantsOptions): AgentParticipant[];
  getThreadGoal(sessionId: string): ThreadGoal | undefined;
  listThreadGoals(options?: ListThreadGoalsOptions): ThreadGoal[];
  getSessionRelation(relationId: string): SessionRelation | undefined;
  listSessionRelations(options?: ListSessionRelationsOptions): SessionRelation[];
  getSessionChildren(sessionId: string): string[];
  getSessionParent(sessionId: string): string | undefined;
  resolveConversationIdBySessionId(sessionId: string): string | undefined;
};

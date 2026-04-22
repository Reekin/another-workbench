import type {
  ApprovalRequest,
  ChatInteractionCapabilitiesRpc,
  SkillDescriptorRpc,
} from "@another-workbench/shared";
import type {
  ComposerAttachment
} from "../composer-attachments.js";
import type { ComposerStatusModel } from "../composer-status.js";

export type ComposerIntent = "send" | "steer" | "queue";

export type ComposerSkillReference = {
  id: string;
  name: string;
  path: string;
  scope: string;
  enabled: boolean;
  shortDescription?: string;
  description?: string;
};

export type QueuedComposerMessage = {
  id: string;
  text: string;
  skills: ComposerSkillReference[];
  attachments: ComposerAttachment[];
  createdAt: string;
  source: "user-queue" | "steer-fallback";
};

export type ComposerSuggestionTrigger = "/" | "$";

export type ComposerSuggestionQuery = {
  trigger: ComposerSuggestionTrigger;
  query: string;
  start: number;
  end: number;
};

export type SlashSuggestionItem = {
  id: string;
  kind: "slash";
  label: string;
  detail: string;
  replacement?: string;
  action?: "create-session" | "resume-session" | "interrupt";
};

export type SkillSuggestionItem = {
  id: string;
  kind: "skill";
  label: string;
  detail: string;
  insertionText: string;
  skill: SkillDescriptorRpc;
};

export type ComposerSuggestionItem = SlashSuggestionItem | SkillSuggestionItem;

export type ComposerSuggestionState = {
  query: ComposerSuggestionQuery;
  items: ComposerSuggestionItem[];
  highlightedIndex: number;
  loading: boolean;
};

export type ComposerViewModel = {
  draft: string;
  selectedSkills: ComposerSkillReference[];
  attachments: ComposerAttachment[];
  queue: QueuedComposerMessage[];
  status: ComposerStatusModel;
  intent: ComposerIntent;
  capabilities: ChatInteractionCapabilitiesRpc;
  suggestions: ComposerSuggestionState | undefined;
  isDispatching: boolean;
  canSubmit: boolean;
  canQueue: boolean;
  canStop: boolean;
  activeTurnId?: string;
};

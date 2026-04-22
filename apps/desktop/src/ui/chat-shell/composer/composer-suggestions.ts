import type {
  ChatInteractionCapabilitiesRpc,
  ComposerSlashSuggestionRpc
} from "@another-workbench/shared";
import type { SlashSuggestionItem } from "./composer-types.js";

const matchesSlashQuery = (label: string, query: string): boolean =>
  label.toLowerCase().includes(`/${query.trim().toLowerCase()}`);

const toSlashSuggestionItem = (
  suggestion: ComposerSlashSuggestionRpc
): SlashSuggestionItem => ({
  id: `slash:${suggestion.id}`,
  kind: "slash",
  label: suggestion.label,
  detail: suggestion.detail,
  replacement: suggestion.replacement
});

export const resolveSlashSuggestionItems = (input: {
  capabilities: ChatInteractionCapabilitiesRpc;
  query: string;
  canCreateSession: boolean;
  canResumeSession: boolean;
  canInterrupt: boolean;
}): SlashSuggestionItem[] => {
  const items: SlashSuggestionItem[] = [];
  const seenLabels = new Set<string>();

  const append = (item: SlashSuggestionItem): void => {
    const normalizedLabel = item.label.toLowerCase();
    if (seenLabels.has(normalizedLabel)) {
      return;
    }
    seenLabels.add(normalizedLabel);
    items.push(item);
  };

  if (input.canResumeSession) {
    append({
      id: "slash:resume-session",
      kind: "slash",
      label: "/resume",
      detail: "Reload the current thread window",
      action: "resume-session"
    });
  }

  if (input.canCreateSession) {
    append({
      id: "slash:create-session",
      kind: "slash",
      label: "/new",
      detail: "Create a new session in the active workspace",
      action: "create-session"
    });
  }

  for (const suggestion of input.capabilities.slashSuggestions) {
    append(toSlashSuggestionItem(suggestion));
  }

  if (input.canInterrupt) {
    append({
      id: "slash:interrupt",
      kind: "slash",
      label: "/interrupt",
      detail: "Interrupt the active turn",
      action: "interrupt"
    });
  }

  return items.filter((item) => matchesSlashQuery(item.label, input.query));
};

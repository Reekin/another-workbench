import type {
  AgentParticipant,
  ParticipantRole
} from "@another-workbench/shared";

export type ActorRefLike =
  | {
      participantId?: string;
      agentId?: string;
    }
  | undefined;

export type ParticipantIdentity = {
  label: string;
  detail: string;
  kind: "participant" | "agent" | "role" | "unknown";
  participantId?: string;
  agentId?: string;
  role?: ParticipantRole;
  capabilities: string[];
};

export type ParticipantDirectory = {
  byParticipantId: Record<string, AgentParticipant>;
  byAgentId: Record<string, AgentParticipant[]>;
};

const unique = (items: readonly string[]): string[] => [...new Set(items)];

const formatCapabilities = (capabilities: readonly string[]): string =>
  capabilities.length > 0 ? capabilities.join(", ") : "no declared capabilities";

const formatRoleDetail = (role: ParticipantRole | undefined, fallback: string): string =>
  role ? `${role} · ${fallback}` : fallback;

export const buildParticipantDirectory = (
  participants: AgentParticipant[]
): ParticipantDirectory => {
  const byParticipantId: Record<string, AgentParticipant> = {};
  const byAgentId: Record<string, AgentParticipant[]> = {};

  for (const participant of participants) {
    byParticipantId[participant.participantId] = participant;
    const existing = byAgentId[participant.agentId] ?? [];
    byAgentId[participant.agentId] = [...existing, participant];
  }

  return {
    byParticipantId,
    byAgentId
  };
};

export const resolveParticipantIdentity = (
  directory: ParticipantDirectory,
  actor: ActorRefLike,
  fallbackLabel = "unknown actor"
): ParticipantIdentity => {
  if (actor?.participantId) {
    const participant = directory.byParticipantId[actor.participantId];
    if (participant) {
      return {
        label: participant.agentId,
        detail: formatRoleDetail(
          participant.role,
          formatCapabilities(unique(participant.capabilities))
        ),
        kind: "participant",
        participantId: participant.participantId,
        agentId: participant.agentId,
        role: participant.role,
        capabilities: unique(participant.capabilities)
      };
    }
  }

  if (actor?.agentId) {
    const candidates = directory.byAgentId[actor.agentId] ?? [];
    const participant = candidates[0];
    if (participant) {
      return {
        label: participant.agentId,
        detail: formatRoleDetail(
          participant.role,
          formatCapabilities(unique(participant.capabilities))
        ),
        kind: "participant",
        participantId: participant.participantId,
        agentId: participant.agentId,
        role: participant.role,
        capabilities: unique(participant.capabilities)
      };
    }

    return {
      label: actor.agentId,
      detail: "agent identity only",
      kind: "agent",
      agentId: actor.agentId,
      capabilities: []
    };
  }

  if (fallbackLabel.trim()) {
    return {
      label: fallbackLabel,
      detail: "role fallback",
      kind: "role",
      capabilities: []
    };
  }

  return {
    label: "unknown actor",
    detail: "identity unavailable",
    kind: "unknown",
    capabilities: []
  };
};

export const summarizeParticipant = (
  participant: AgentParticipant
): ParticipantIdentity => ({
  label: participant.agentId,
  detail: formatRoleDetail(
    participant.role,
    formatCapabilities(unique(participant.capabilities))
  ),
  kind: "participant",
  participantId: participant.participantId,
  agentId: participant.agentId,
  role: participant.role,
  capabilities: unique(participant.capabilities)
});

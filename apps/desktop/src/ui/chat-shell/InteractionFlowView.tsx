import { startTransition, useState, type ReactElement } from "react";
import type { RuntimeInteraction } from "@another-workbench/shared";
import { Button } from "./Button.js";
import { ParticipantIdentityBadge } from "./ParticipantIdentityBadge.js";
import {
  buildParticipantDirectory,
  type ParticipantDirectory,
  resolveParticipantIdentity
} from "./participant-directory.js";

export type InteractionAction = "accept" | "decline" | "cancel" | "submit" | "defer";

export type InteractionResponseInput = {
  sessionId: string;
  requestId: string;
  action: InteractionAction;
  response?: Record<string, unknown>;
  answers?: Record<string, string[]>;
  content?: unknown;
};

export type InteractionFlowViewProps = {
  interactions: RuntimeInteraction[];
  participantDirectory?: ParticipantDirectory;
  onRespond?: (input: InteractionResponseInput) => Promise<void>;
};

const defaultDirectory = buildParticipantDirectory([]);

const canRespond = (interaction: RuntimeInteraction): boolean =>
  interaction.status === "pending";

const questionIdFor = (question: unknown, index: number): string =>
  question && typeof question === "object" && "id" in question && typeof question.id === "string"
    ? question.id
    : String(index);

const questionLabelFor = (question: unknown, index: number): string =>
  question &&
  typeof question === "object" &&
  "question" in question &&
  typeof question.question === "string"
    ? question.question
    : `Question ${index + 1}`;

const parseJsonObject = (value: string): Record<string, unknown> | undefined => {
  if (!value.trim()) {
    return undefined;
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Response must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
};

export const InteractionFlowView = ({
  interactions,
  participantDirectory = defaultDirectory,
  onRespond
}: InteractionFlowViewProps): ReactElement => {
  const [answerByKey, setAnswerByKey] = useState<Record<string, string>>({});
  const [contentByRequestId, setContentByRequestId] = useState<Record<string, string>>({});
  const [inFlightByRequestId, setInFlightByRequestId] = useState<Record<string, boolean>>({});
  const [errorByRequestId, setErrorByRequestId] = useState<Record<string, string | undefined>>({});

  const setPending = (requestId: string, pending: boolean): void => {
    startTransition(() => {
      setInFlightByRequestId((current) => ({
        ...current,
        [requestId]: pending
      }));
    });
  };

  const setError = (requestId: string, message?: string): void => {
    startTransition(() => {
      setErrorByRequestId((current) => ({
        ...current,
        [requestId]: message
      }));
    });
  };

  const onAction = async (
    interaction: RuntimeInteraction,
    action: InteractionAction
  ): Promise<void> => {
    if (!onRespond || !canRespond(interaction)) {
      return;
    }
    setPending(interaction.requestId, true);
    setError(interaction.requestId, undefined);

    try {
      if (interaction.interactionKind === "tool_user_input") {
        const questions = Array.isArray(interaction.payload.questions)
          ? interaction.payload.questions
          : [];
        const answers = Object.fromEntries(
          questions.map((question, index) => {
            const questionId = questionIdFor(question, index);
            const key = `${interaction.requestId}:${questionId}`;
            return [questionId, [answerByKey[key] ?? ""]];
          })
        );
        await onRespond({
          sessionId: interaction.sessionId,
          requestId: interaction.requestId,
          action: "submit",
          answers
        });
        return;
      }

      const content =
        action === "accept" || action === "submit"
          ? parseJsonObject(contentByRequestId[interaction.requestId] ?? "{}")
          : undefined;
      await onRespond({
        sessionId: interaction.sessionId,
        requestId: interaction.requestId,
        action,
        content,
        response: content ? { content } : undefined
      });
    } catch (error) {
      setError(interaction.requestId, (error as Error).message);
    } finally {
      setPending(interaction.requestId, false);
    }
  };

  if (interactions.length === 0) {
    return <p className="awb-detail__empty">No interaction request in this turn.</p>;
  }

  return (
    <div className="awb-approval-list">
      {interactions.map((interaction) => {
        const inFlight = inFlightByRequestId[interaction.requestId] ?? false;
        const requestError = errorByRequestId[interaction.requestId];
        const disabled = !onRespond || !canRespond(interaction) || inFlight;
        const identity = resolveParticipantIdentity(
          participantDirectory,
          interaction.actor,
          interaction.interactionKind
        );
        const questions = Array.isArray(interaction.payload.questions)
          ? interaction.payload.questions
          : [];

        return (
          <article key={interaction.requestId} className="awb-timeline-item awb-approval-item">
            <header className="awb-timeline-item__header">
              <div className="awb-timeline-item__meta">
                <strong>{interaction.title}</strong>
                <ParticipantIdentityBadge identity={identity} compact />
              </div>
              <span className={`awb-badge is-${interaction.status}`}>{interaction.status}</span>
            </header>
            <p className="awb-approval-item__kind">{interaction.interactionKind}</p>
            {interaction.details && (
              <p className="awb-approval-item__details">{interaction.details}</p>
            )}
            {interaction.interactionKind === "tool_user_input" ? (
              <div className="awb-approval-item__details">
                {questions.map((question, index) => {
                  const questionId = questionIdFor(question, index);
                  const key = `${interaction.requestId}:${questionId}`;
                  return (
                    <label key={questionId}>
                      <span>{questionLabelFor(question, index)}</span>
                      <input
                        value={answerByKey[key] ?? ""}
                        disabled={disabled}
                        onChange={(event) =>
                          setAnswerByKey((current) => ({
                            ...current,
                            [key]: event.currentTarget.value
                          }))
                        }
                      />
                    </label>
                  );
                })}
              </div>
            ) : (
              <label className="awb-approval-item__details">
                <span>Response content</span>
                <textarea
                  value={contentByRequestId[interaction.requestId] ?? "{}"}
                  disabled={disabled}
                  onChange={(event) =>
                    setContentByRequestId((current) => ({
                      ...current,
                      [interaction.requestId]: event.currentTarget.value
                    }))
                  }
                />
              </label>
            )}
            {interaction.interactionKind === "tool_user_input" ? (
              <div className="awb-approval-item__actions">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={disabled}
                  onClick={() => void onAction(interaction, "submit")}
                >
                  Submit
                </Button>
              </div>
            ) : (
              <div className="awb-approval-item__actions">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={disabled}
                  onClick={() => void onAction(interaction, "submit")}
                >
                  Submit
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={disabled}
                  onClick={() => void onAction(interaction, "decline")}
                >
                  Decline
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => void onAction(interaction, "cancel")}
                >
                  Cancel
                </Button>
              </div>
            )}
            {requestError && <p className="awb-approval-item__error">{requestError}</p>}
          </article>
        );
      })}
    </div>
  );
};

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type ChangeEvent as ReactChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from "react";
import type {
  ApprovalRequest,
  ChatInteractionCapabilitiesRpc,
  ChatSession,
  SkillDescriptorRpc,
  ThreadGoal,
  Turn
} from "@another-workbench/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import {
  createComposerAttachments,
  mergeComposerAttachments,
  releaseComposerAttachments,
  type ComposerAttachment
} from "./composer-attachments.js";
import {
  resolveComposerStatusModel,
  statusNoticeErrorDetails,
  type ComposerStatusNotice
} from "./composer-status.js";
import { resolveSlashSuggestionItems } from "./composer/composer-suggestions.js";
import type {
  ComposerSkillReference,
  ComposerIntent,
  ComposerSuggestionItem,
  ComposerSuggestionQuery,
  ComposerSuggestionState,
  ComposerViewModel,
  QueuedComposerMessage
} from "./composer/composer-types.js";

const createOpaqueId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const hasFileTransfer = (dataTransfer: DataTransfer | null): boolean =>
  Array.from(dataTransfer?.types ?? []).includes("Files");

const hasStringTransfer = (dataTransfer: DataTransfer | null): boolean =>
  Array.from(dataTransfer?.items ?? []).some((item) => item.kind === "string");

const collectPastedImageFiles = (dataTransfer: DataTransfer | null): File[] => {
  if (!dataTransfer) {
    return [];
  }
  return Array.from(dataTransfer.items)
    .filter(
      (item) =>
        item.kind === "file" && item.type.toLowerCase().startsWith("image/")
    )
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
};

const filterSkills = (
  skills: SkillDescriptorRpc[],
  query: string
): SkillDescriptorRpc[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return skills;
  }
  return skills.filter((skill) =>
    [skill.name, skill.shortDescription, skill.description, skill.scope]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(normalized))
  );
};

const dedupeSkills = (skills: SkillDescriptorRpc[]): SkillDescriptorRpc[] => {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = `${skill.path}:${skill.name}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const toComposerSkillReference = (
  skill: SkillDescriptorRpc
): ComposerSkillReference => ({
  id: `${skill.path}:${skill.name}`,
  name: skill.name,
  path: skill.path,
  scope: skill.scope,
  enabled: skill.enabled,
  shortDescription: skill.shortDescription ?? undefined,
  description: skill.description
});

const serializeComposerContent = (
  text: string,
  skills: ComposerSkillReference[]
): string => {
  const normalizedText = text.trim();
  const serializedSkills = skills
    .map((skill) => `[$${skill.name}](${skill.path})`)
    .join("\n");

  if (serializedSkills && normalizedText) {
    return `${serializedSkills}\n\n${normalizedText}`;
  }
  if (serializedSkills) {
    return serializedSkills;
  }
  return normalizedText;
};

export const parseGoalSlashCommand = (
  text: string
):
  | { kind: "set"; objective: string }
  | { kind: "clear" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "edit" }
  | { kind: "empty" }
  | undefined => {
  const trimmed = text.trim();
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const argument = (match[1] ?? "").trim();
  if (!argument) {
    return { kind: "empty" };
  }
  switch (argument.toLocaleLowerCase()) {
    case "clear":
      return { kind: "clear" };
    case "pause":
      return { kind: "pause" };
    case "resume":
      return { kind: "resume" };
    case "edit":
      return { kind: "edit" };
    default:
      return { kind: "set", objective: argument };
  }
};

export const goalCommandBlockedReason = (
  command: ReturnType<typeof parseGoalSlashCommand>,
  threadGoal?: ThreadGoal
): string | undefined => {
  if (command?.kind === "set" && threadGoal) {
    return "A goal is already set. Use /goal clear before setting a new goal.";
  }
  if (command?.kind === "edit") {
    return "Goal editing is not available here yet. Use /goal clear before setting a new goal.";
  }
  return undefined;
};

export const extractComposerSuggestionQuery = (
  text: string,
  cursor: number
): ComposerSuggestionQuery | undefined => {
  const before = text.slice(0, cursor);
  const match = /(?:^|\s)([/$])([^\s/$]*)$/u.exec(before);
  if (!match) {
    return undefined;
  }
  const trigger = match[1] as ComposerSuggestionQuery["trigger"];
  const query = match[2] ?? "";
  return {
    trigger,
    query,
    start: cursor - query.length - 1,
    end: cursor
  };
};

export const resolveComposerIntent = (input: {
  activeSession?: ChatSession;
  supportsSteer: boolean;
  activeTurnId?: string;
}): ComposerIntent => {
  if (
    input.activeSession?.status === "running" ||
    input.activeSession?.status === "awaiting_approval"
  ) {
    if (input.supportsSteer && input.activeTurnId) {
      return "steer";
    }
    return "queue";
  }
  return "send";
};

type UseComposerControllerInput = {
  transport?: DesktopTransport;
  activeSession?: ChatSession;
  activeSessionId?: string;
  threadGoal?: ThreadGoal;
  displayedSessionId?: string;
  selectedEngineId: string;
  activeWorkspaceId?: string;
  activeWorkspaceRootPath?: string;
  turns: Turn[];
  allowSessionLastTurnFallback?: boolean;
  approvals: ApprovalRequest[];
  isOpeningSelectedSession: boolean;
  statusNotice?: ComposerStatusNotice;
  onStatusNotice: (notice: ComposerStatusNotice | undefined) => void;
  onCreateSession?: (workspaceId: string, engineId: string) => Promise<void>;
  onOpenSession?: (sessionId: string) => Promise<void>;
  onRequestTranscriptBottom?: (sessionId: string) => void;
};

export type UseComposerControllerResult = ComposerViewModel & {
  composerFileInputRef: RefObject<HTMLInputElement | null>;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  isDropTarget: boolean;
  onDraftChange: (
    value: string,
    selectionStart?: number | null
  ) => void;
  onTextareaSelect: (selectionStart: number) => void;
  onPrimaryAction: () => Promise<void>;
  onQueueCurrent: () => void;
  onStop: () => Promise<void>;
  onSuggestionHover: (index: number) => void;
  onSuggestionSelect: (item: ComposerSuggestionItem) => Promise<void>;
  onInputKeyDown: (
    event: ReactKeyboardEvent<HTMLTextAreaElement>
  ) => Promise<void>;
  onComposerInputChange: (
    event: ReactChangeEvent<HTMLInputElement>
  ) => void;
  onComposerPaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  onComposerDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  onComposerDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onComposerDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onComposerDrop: (event: ReactDragEvent<HTMLElement>) => void;
  onRemoveSkill: (skillId: string) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onPickAttachments: () => void;
  onEditQueuedMessage: (messageId: string) => void;
  onDeleteQueuedMessage: (messageId: string) => void;
  onSendQueuedMessageNow: (messageId: string) => Promise<void>;
  onSteerQueuedMessageNow: (messageId: string) => Promise<void>;
};

export const useComposerController = (
  input: UseComposerControllerInput
): UseComposerControllerResult => {
  const [draftBySessionId, setDraftBySessionId] = useState<Record<string, string>>({});
  const [detachedDraft, setDetachedDraft] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<ComposerSkillReference[]>([]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [queueBySessionId, setQueueBySessionId] = useState<
    Record<string, QueuedComposerMessage[]>
  >({});
  const [isDispatching, setIsDispatching] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [capabilities, setCapabilities] = useState<ChatInteractionCapabilitiesRpc>({
    supportsSteer: false,
    supportsAttachments: false,
    slashSuggestions: []
  });
  const [availableSkills, setAvailableSkills] = useState<SkillDescriptorRpc[]>([]);
  const [isSkillsLoading, setIsSkillsLoading] = useState(false);
  const [highlightedSuggestionIndex, setHighlightedSuggestionIndex] = useState(0);
  const mountedRef = useRef(true);
  const selectedSkillsRef = useRef<ComposerSkillReference[]>([]);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const queueRef = useRef<Record<string, QueuedComposerMessage[]>>({});
  const dragDepthRef = useRef(0);
  const previousSessionIdRef = useRef<string | undefined>(undefined);
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const activeTurnId = useMemo(() => {
    const latestTurn = [...input.turns]
      .reverse()
      .find((turn) => turn.status !== "completed");
    return latestTurn?.turnId ??
      (input.allowSessionLastTurnFallback ? input.activeSession?.lastTurnId : undefined);
  }, [
    input.turns,
    input.allowSessionLastTurnFallback,
    input.activeSession?.lastTurnId
  ]);

  const draft = input.activeSessionId
    ? (draftBySessionId[input.activeSessionId] ?? "")
    : detachedDraft;
  const queue = input.activeSessionId
    ? (queueBySessionId[input.activeSessionId] ?? [])
    : [];
  const intent = resolveComposerIntent({
    activeSession: input.activeSession,
    supportsSteer: capabilities.supportsSteer,
    activeTurnId
  });

  const status = resolveComposerStatusModel({
    transportAvailable: Boolean(input.transport),
    selectedEngineId: input.selectedEngineId,
    activeSession: input.activeSession,
    approvals: input.approvals,
    notice: input.statusNotice,
    queuedCount: queue.length,
    supportsSteer: capabilities.supportsSteer
  });

  const hasComposedInput =
    draft.trim().length > 0 ||
    selectedSkills.length > 0 ||
    attachments.length > 0;
  const canSubmit =
    hasComposedInput &&
    Boolean(input.transport && input.activeSessionId) &&
    !input.isOpeningSelectedSession &&
    !isDispatching;
  const canQueue =
    Boolean(input.activeSessionId) &&
    !input.isOpeningSelectedSession &&
    !isDispatching &&
    (draft.trim().length > 0 ||
      selectedSkills.length > 0 ||
      attachments.length > 0) &&
    Boolean(
      input.activeSession?.status === "running" ||
        input.activeSession?.status === "awaiting_approval"
    );
  const canStop =
    Boolean(input.transport && input.activeSessionId && activeTurnId) &&
    (input.activeSession?.status === "running" ||
      input.activeSession?.status === "awaiting_approval");

  useEffect(() => {
    selectedSkillsRef.current = selectedSkills;
  }, [selectedSkills]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    queueRef.current = queueBySessionId;
  }, [queueBySessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      selectedSkillsRef.current = [];
      releaseComposerAttachments(attachmentsRef.current);
      for (const queuedMessages of Object.values(queueRef.current)) {
        for (const item of queuedMessages) {
          releaseComposerAttachments(item.attachments);
        }
      }
    };
  }, []);

  useEffect(() => {
    if (previousSessionIdRef.current === input.activeSessionId) {
      return;
    }
    previousSessionIdRef.current = input.activeSessionId;
    selectedSkillsRef.current = [];
    setSelectedSkills([]);
    releaseComposerAttachments(attachmentsRef.current);
    attachmentsRef.current = [];
    setAttachments([]);
  }, [input.activeSessionId]);

  useEffect(() => {
    if (!input.transport || !input.activeSessionId) {
      setCapabilities({
        supportsSteer: false,
        supportsAttachments: false,
        slashSuggestions: []
      });
      return;
    }
    let cancelled = false;
    void input.transport.chat
      .getCapabilities(input.activeSessionId)
      .then((nextCapabilities) => {
        if (!cancelled) {
          setCapabilities(nextCapabilities);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setCapabilities({
            supportsSteer: false,
            supportsAttachments: false,
            slashSuggestions: []
          });
          input.onStatusNotice({
            message: `Capability lookup failed: ${(error as Error).message}`,
            source: "send",
            ...statusNoticeErrorDetails(error)
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [input.activeSessionId, input.onStatusNotice, input.transport]);

  useEffect(() => {
    if (!input.transport) {
      setAvailableSkills([]);
      setIsSkillsLoading(false);
      return;
    }

    let cancelled = false;
    setIsSkillsLoading(true);
    void input.transport.skills
      .list({
        cwds: input.activeWorkspaceRootPath
          ? [input.activeWorkspaceRootPath]
          : undefined
      })
      .then((skills) => {
        if (cancelled) {
          return;
        }
        setAvailableSkills(dedupeSkills(skills));
        setIsSkillsLoading(false);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setAvailableSkills([]);
        setIsSkillsLoading(false);
        input.onStatusNotice({
          message: `Skills lookup failed: ${(error as Error).message}`,
          persistent: true,
          source: "send",
          ...statusNoticeErrorDetails(error)
        });
      });

    return () => {
      cancelled = true;
    };
  }, [input.activeWorkspaceRootPath, input.onStatusNotice, input.transport]);

  const setDraft = (value: string): void => {
    if (input.activeSessionId) {
      setDraftBySessionId((current) => ({
        ...current,
        [input.activeSessionId!]: value
      }));
      return;
    }
    setDetachedDraft(value);
  };

  const onDraftChange = (
    value: string,
    selectionStart?: number | null
  ): void => {
    setDraft(value);
    if (typeof selectionStart === "number") {
      setCursorPosition(selectionStart);
      return;
    }
    setCursorPosition(value.length);
  };

  const replaceSelectedSkills = (nextSkills: ComposerSkillReference[]): void => {
    selectedSkillsRef.current = nextSkills;
    setSelectedSkills(nextSkills);
  };

  const suggestionQuery = useMemo(() => {
    if (input.isOpeningSelectedSession) {
      return undefined;
    }
    return extractComposerSuggestionQuery(draft, cursorPosition);
  }, [cursorPosition, draft, input.isOpeningSelectedSession]);

  const suggestions = useMemo<ComposerSuggestionState | undefined>(() => {
    if (!suggestionQuery) {
      return undefined;
    }

    if (suggestionQuery.trigger === "/") {
      const items: ComposerSuggestionItem[] = resolveSlashSuggestionItems({
        capabilities,
        query: suggestionQuery.query,
        canCreateSession: Boolean(
          input.activeWorkspaceId && input.selectedEngineId && input.onCreateSession
        ),
        canResumeSession: Boolean(input.displayedSessionId && input.onOpenSession),
        canInterrupt: canStop
      });
      return {
        query: suggestionQuery,
        items,
        highlightedIndex:
          items.length === 0
            ? 0
            : Math.min(highlightedSuggestionIndex, items.length - 1),
        loading: false
      };
    }

    const items = filterSkills(availableSkills, suggestionQuery.query).map(
      (skill): ComposerSuggestionItem => ({
        id: `skill:${skill.path}`,
        kind: "skill",
        label: `$${skill.name}`,
        detail:
          skill.shortDescription ??
          `${skill.description} · ${skill.scope} · ${skill.enabled ? "enabled" : "disabled"}`,
        insertionText: `[${`$${skill.name}`}](${skill.path})`,
        skill
      })
    );
    return {
      query: suggestionQuery,
      items,
      highlightedIndex:
        items.length === 0
          ? 0
          : Math.min(highlightedSuggestionIndex, items.length - 1),
      loading: isSkillsLoading
    };
  }, [
    availableSkills,
    capabilities,
    canStop,
    highlightedSuggestionIndex,
    input.activeWorkspaceId,
    input.displayedSessionId,
    input.onCreateSession,
    input.onOpenSession,
    input.selectedEngineId,
    isSkillsLoading,
    suggestionQuery
  ]);

  useEffect(() => {
    setHighlightedSuggestionIndex(0);
  }, [suggestionQuery?.trigger, suggestionQuery?.query]);

  const replaceAttachments = (
    nextAttachments: ComposerAttachment[],
    options: {
      releaseCurrent?: boolean;
    } = {}
  ): void => {
    if (options.releaseCurrent ?? true) {
      releaseComposerAttachments(attachmentsRef.current);
    }
    attachmentsRef.current = nextAttachments;
    setAttachments(nextAttachments);
  };

  const appendQueueItem = (
    item: Omit<QueuedComposerMessage, "id" | "createdAt">
  ): void => {
    if (!input.activeSessionId) {
      return;
    }
    const queuedItem: QueuedComposerMessage = {
      id: createOpaqueId("queued"),
      createdAt: new Date().toISOString(),
      ...item
    };
    setQueueBySessionId((current) => ({
      ...current,
      [input.activeSessionId!]: [...(current[input.activeSessionId!] ?? []), queuedItem]
    }));
  };

  const removeQueueItem = (
    messageId: string,
    options: { release: boolean }
  ): QueuedComposerMessage | undefined => {
    if (!input.activeSessionId) {
      return undefined;
    }
    const items = queueRef.current[input.activeSessionId] ?? [];
    const removed = items.find((item) => item.id === messageId);
    if (!removed) {
      return undefined;
    }
    setQueueBySessionId((current) => ({
      ...current,
      [input.activeSessionId!]: (current[input.activeSessionId!] ?? []).filter(
        (item) => item.id !== messageId
      )
    }));
    if (options.release) {
      releaseComposerAttachments(removed.attachments);
    }
    return removed;
  };

  const setTextareaCursorToEnd = (value: string): void => {
    queueMicrotask(() => {
      const element = composerTextareaRef.current;
      if (!element) {
        return;
      }
      const position = value.length;
      element.focus();
      element.setSelectionRange(position, position);
      setCursorPosition(position);
    });
  };

  const moveCurrentInputToQueue = (source: QueuedComposerMessage["source"]): void => {
    const text = draft.trim();
    const currentSkills = selectedSkillsRef.current;
    const currentAttachments = attachmentsRef.current;
    if (!text && currentSkills.length === 0 && currentAttachments.length === 0) {
      return;
    }
    appendQueueItem({
      text,
      skills: currentSkills,
      attachments: currentAttachments,
      source
    });
    replaceSelectedSkills([]);
    attachmentsRef.current = [];
    setAttachments([]);
    onDraftChange("");
    input.onStatusNotice({
      message: "Queued follow-up.",
      source: "send"
    });
  };

  const dispatchPayload = async (payload: {
    text: string;
    payloadSkills: ComposerSkillReference[];
    payloadAttachments: ComposerAttachment[];
    mode: "send" | "steer";
    turnId?: string;
  }): Promise<boolean> => {
    if (!input.transport || !input.activeSessionId) {
      return false;
    }
    const content = serializeComposerContent(payload.text, payload.payloadSkills);
    if (!content && payload.payloadAttachments.length === 0) {
      return false;
    }
    setIsDispatching(true);
    input.onStatusNotice({
      message:
        payload.mode === "steer" ? "Steering active turn…" : "Sending…",
      persistent: true,
      source: "send"
    });
    try {
      if (payload.mode === "steer" && payload.turnId) {
        const receipt = await input.transport.chat.steer({
          sessionId: input.activeSessionId,
          turnId: payload.turnId,
          content,
          attachments: payload.payloadAttachments.map((item) => item.attachment)
        });
        if (!receipt.accepted) {
          throw new Error("The current runtime does not accept steer requests.");
        }
      } else {
        const receipt = await input.transport.chat.send({
          sessionId: input.activeSessionId,
          content,
          attachments: payload.payloadAttachments.map((item) => item.attachment)
        });
        if (!receipt.accepted) {
          throw new Error("The current runtime rejected the send request.");
        }
      }
      input.onStatusNotice({
        message: payload.mode === "steer" ? "Steer sent." : "Message sent.",
        source: "send"
      });
      input.onRequestTranscriptBottom?.(input.activeSessionId);
      return true;
    } catch (error) {
      input.onStatusNotice({
        message: `Send failed: ${(error as Error).message}`,
        persistent: true,
        source: "send",
        ...statusNoticeErrorDetails(error)
      });
      return false;
    } finally {
      setIsDispatching(false);
    }
  };

  const dispatchGoalCommand = async (
    command:
      | { kind: "set"; objective: string }
      | { kind: "clear" }
      | { kind: "pause" }
      | { kind: "resume" }
  ): Promise<boolean> => {
    if (!input.transport || !input.activeSessionId) {
      return false;
    }
    const actionLabel =
      command.kind === "clear"
        ? "Clearing goal"
        : command.kind === "pause"
          ? "Pausing goal"
          : command.kind === "resume"
            ? "Resuming goal"
            : "Setting goal";
    setIsDispatching(true);
    input.onStatusNotice({
      message: `${actionLabel}…`,
      persistent: true,
      source: "send"
    });
    try {
      const receipt =
        command.kind === "clear"
          ? await input.transport.chat.clearGoal({
              sessionId: input.activeSessionId
            })
          : await input.transport.chat.setGoal({
              sessionId: input.activeSessionId,
              objective: command.kind === "set" ? command.objective : undefined,
              status:
                command.kind === "pause"
                  ? "paused"
                  : command.kind === "resume"
                    ? "active"
                    : "active"
            });
      if (!receipt.accepted) {
        throw new Error("The current runtime rejected the goal request.");
      }
      input.onStatusNotice({
        message:
          command.kind === "clear"
            ? "Goal cleared."
            : command.kind === "pause"
              ? "Goal paused."
              : command.kind === "resume"
                ? "Goal resumed."
                : "Goal set.",
        source: "send"
      });
      return true;
    } catch (error) {
      input.onStatusNotice({
        message: `Goal failed: ${(error as Error).message}`,
        persistent: true,
        source: "send",
        ...statusNoticeErrorDetails(error)
      });
      return false;
    } finally {
      setIsDispatching(false);
    }
  };

  const onPrimaryAction = async (): Promise<void> => {
    if (!canSubmit) {
      return;
    }
    const goalCommand = parseGoalSlashCommand(draft);
    if (goalCommand?.kind === "empty") {
      input.onStatusNotice({
        message: "Add a goal after /goal.",
        source: "send"
      });
      return;
    }
    const goalBlockReason = goalCommandBlockedReason(goalCommand, input.threadGoal);
    if (goalBlockReason) {
      input.onStatusNotice({
        message: goalBlockReason,
        source: "send"
      });
      return;
    }
    if (goalCommand?.kind === "edit") {
      return;
    }
    if (goalCommand) {
      if (
        selectedSkillsRef.current.length > 0 ||
        attachmentsRef.current.length > 0
      ) {
        input.onStatusNotice({
          message: "Goal commands only use the text after /goal.",
          source: "send"
        });
        return;
      }
      const succeeded = await dispatchGoalCommand(goalCommand);
      if (!succeeded) {
        return;
      }
      onDraftChange("");
      return;
    }
    if (intent === "queue") {
      moveCurrentInputToQueue("user-queue");
      return;
    }
    const currentAttachments = attachmentsRef.current;
    const currentDraft = draft;
    const succeeded = await dispatchPayload({
      text: currentDraft,
      payloadSkills: selectedSkillsRef.current,
      payloadAttachments: currentAttachments,
      mode: intent,
      turnId: activeTurnId
    });
    if (!succeeded) {
      return;
    }
    onDraftChange("");
    replaceSelectedSkills([]);
    replaceAttachments([], { releaseCurrent: true });
  };

  const onQueueCurrent = (): void => {
    if (!canQueue) {
      return;
    }
    moveCurrentInputToQueue(intent === "steer" ? "steer-fallback" : "user-queue");
  };

  const onStop = async (): Promise<void> => {
    if (!input.transport || !input.activeSessionId || !activeTurnId || !canStop) {
      return;
    }
    setIsDispatching(true);
    try {
      await input.transport.chat.interrupt({
        sessionId: input.activeSessionId,
        turnId: activeTurnId
      });
      input.onStatusNotice({
        message: "Interrupt requested.",
        source: "send"
      });
    } catch (error) {
      input.onStatusNotice({
        message: `Stop failed: ${(error as Error).message}`,
        persistent: true,
        source: "send",
        ...statusNoticeErrorDetails(error)
      });
    } finally {
      setIsDispatching(false);
    }
  };

  const replaceRangeInDraft = (
    start: number,
    end: number,
    value: string
  ): void => {
    const nextDraft = `${draft.slice(0, start)}${value}${draft.slice(end)}`;
    onDraftChange(nextDraft, start + value.length);
    setTextareaCursorToEnd(nextDraft);
  };

  const onSuggestionSelect = async (
    item: ComposerSuggestionItem
  ): Promise<void> => {
    if (!suggestions) {
      return;
    }
    if (item.kind === "skill") {
      replaceSelectedSkills(
        selectedSkillsRef.current.some((skill) => skill.id === `${item.skill.path}:${item.skill.name}`)
          ? selectedSkillsRef.current
          : [...selectedSkillsRef.current, toComposerSkillReference(item.skill)]
      );
      replaceRangeInDraft(
        suggestions.query.start,
        suggestions.query.end,
        ""
      );
      return;
    }
    if (item.action === "create-session") {
      if (input.activeWorkspaceId && input.selectedEngineId && input.onCreateSession) {
        await input.onCreateSession(input.activeWorkspaceId, input.selectedEngineId);
      }
      return;
    }
    if (item.action === "resume-session") {
      if (input.displayedSessionId && input.onOpenSession) {
        await input.onOpenSession(input.displayedSessionId);
      }
      return;
    }
    if (item.action === "interrupt") {
      await onStop();
      return;
    }
    replaceRangeInDraft(
      suggestions.query.start,
      suggestions.query.end,
      `${item.replacement ?? ""} `
    );
  };

  const onInputKeyDown = async (
    event: ReactKeyboardEvent<HTMLTextAreaElement>
  ): Promise<void> => {
    if (suggestions && suggestions.items.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedSuggestionIndex(
          (current) => (current + 1) % suggestions.items.length
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedSuggestionIndex(
          (current) => (current - 1 + suggestions.items.length) % suggestions.items.length
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const item = suggestions.items[suggestions.highlightedIndex];
        if (item) {
          await onSuggestionSelect(item);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCursorPosition(-1);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      await onPrimaryAction();
    }
  };

  const appendComposerAttachments = async (
    files: Iterable<File>,
    origin: "picker" | "drop" | "paste"
  ): Promise<void> => {
    if (input.isOpeningSelectedSession || isDispatching) {
      return;
    }
    if (!capabilities.supportsAttachments) {
      input.onStatusNotice({
        message: "Attachments are unavailable for this session.",
        source: "send"
      });
      return;
    }
    const nextAttachments = await createComposerAttachments(files, origin);
    if (!mountedRef.current) {
      releaseComposerAttachments(nextAttachments);
      return;
    }
    if (nextAttachments.length === 0) {
      return;
    }
    const result = mergeComposerAttachments(attachmentsRef.current, nextAttachments);
    releaseComposerAttachments([...result.replaced, ...result.skipped]);
    attachmentsRef.current = result.attachments;
    setAttachments(result.attachments);
  };

  const onComposerInputChange = (
    event: ReactChangeEvent<HTMLInputElement>
  ): void => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) {
      return;
    }
    void appendComposerAttachments(files, "picker").catch((error) => {
      input.onStatusNotice({
        message: `Attachment failed: ${(error as Error).message}`,
        persistent: true,
        source: "send",
        ...statusNoticeErrorDetails(error)
      });
    });
  };

  const onComposerPaste = (
    event: ReactClipboardEvent<HTMLTextAreaElement>
  ): void => {
    const files = collectPastedImageFiles(event.clipboardData);
    if (files.length === 0) {
      return;
    }
    if (!hasStringTransfer(event.clipboardData)) {
      event.preventDefault();
    }
    void appendComposerAttachments(files, "paste").catch((error) => {
      input.onStatusNotice({
        message: `Paste attachment failed: ${(error as Error).message}`,
        persistent: true,
        source: "send",
        ...statusNoticeErrorDetails(error)
      });
    });
  };

  const onComposerDragEnter = (event: ReactDragEvent<HTMLElement>): void => {
    if (!hasFileTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDropTarget(true);
  };

  const onComposerDragOver = (event: ReactDragEvent<HTMLElement>): void => {
    if (!hasFileTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDropTarget(true);
  };

  const onComposerDragLeave = (event: ReactDragEvent<HTMLElement>): void => {
    if (!hasFileTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDropTarget(false);
    }
  };

  const onComposerDrop = (event: ReactDragEvent<HTMLElement>): void => {
    if (!hasFileTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDropTarget(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) {
      return;
    }
    void appendComposerAttachments(files, "drop").catch((error) => {
      input.onStatusNotice({
        message: `Drop attachment failed: ${(error as Error).message}`,
        persistent: true,
        source: "send",
        ...statusNoticeErrorDetails(error)
      });
    });
  };

  const onRemoveAttachment = (attachmentId: string): void => {
    const removed = attachmentsRef.current.find(
      (attachment) => attachment.attachment.attachmentId === attachmentId
    );
    if (!removed) {
      return;
    }
    releaseComposerAttachments([removed]);
    const next = attachmentsRef.current.filter(
      (attachment) => attachment.attachment.attachmentId !== attachmentId
    );
    attachmentsRef.current = next;
    setAttachments(next);
  };

  const onRemoveSkill = (skillId: string): void => {
    replaceSelectedSkills(
      selectedSkillsRef.current.filter((skill) => skill.id !== skillId)
    );
  };

  const onPickAttachments = (): void => {
    composerFileInputRef.current?.click();
  };

  const onEditQueuedMessage = (messageId: string): void => {
    const item = removeQueueItem(messageId, { release: false });
    if (!item) {
      return;
    }
    onDraftChange(item.text);
    replaceSelectedSkills(item.skills);
    replaceAttachments(item.attachments, { releaseCurrent: true });
    setTextareaCursorToEnd(item.text);
  };

  const onDeleteQueuedMessage = (messageId: string): void => {
    removeQueueItem(messageId, { release: true });
  };

  const dispatchQueuedMessage = async (
    messageId: string,
    mode: "send" | "steer"
  ): Promise<void> => {
    const item = queue.find((candidate) => candidate.id === messageId);
    if (!item) {
      return;
    }
    const succeeded = await dispatchPayload({
      text: item.text,
      payloadSkills: item.skills,
      payloadAttachments: item.attachments,
      mode,
      turnId: activeTurnId
    });
    if (succeeded) {
      removeQueueItem(messageId, { release: true });
    }
  };

  const onSendQueuedMessageNow = async (messageId: string): Promise<void> => {
    await dispatchQueuedMessage(messageId, "send");
  };

  const onSteerQueuedMessageNow = async (messageId: string): Promise<void> => {
    await dispatchQueuedMessage(messageId, "steer");
  };

  useEffect(() => {
    if (
      !input.activeSessionId ||
      !input.transport ||
      isDispatching ||
      input.activeSession?.status !== "idle" ||
      queue.length === 0
    ) {
      return;
    }
    const nextQueued = queue[0];
    let cancelled = false;
    void (async () => {
      const succeeded = await dispatchPayload({
        text: nextQueued.text,
        payloadSkills: nextQueued.skills,
        payloadAttachments: nextQueued.attachments,
        mode: "send"
      });
      if (!cancelled && succeeded) {
        removeQueueItem(nextQueued.id, { release: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    input.activeSession?.status,
    input.activeSessionId,
    input.transport,
    isDispatching,
    queue
  ]);

  return {
    draft,
    selectedSkills,
    attachments,
    queue,
    status,
    intent,
    capabilities,
    suggestions,
    isDispatching,
    canSubmit,
    canQueue,
    canStop,
    activeTurnId,
    composerFileInputRef,
    composerTextareaRef,
    isDropTarget,
    onDraftChange,
    onTextareaSelect: setCursorPosition,
    onPrimaryAction,
    onQueueCurrent,
    onStop,
    onSuggestionHover: setHighlightedSuggestionIndex,
    onSuggestionSelect,
    onInputKeyDown,
    onComposerInputChange,
    onComposerPaste,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
    onRemoveSkill,
    onRemoveAttachment,
    onPickAttachments,
    onEditQueuedMessage,
    onDeleteQueuedMessage,
    onSendQueuedMessageNow,
    onSteerQueuedMessageNow
  };
};

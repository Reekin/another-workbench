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
  EngineModelCatalogRpc,
  EngineModelRpc,
  EngineSurfaceRpc,
  SessionExecutionProfile,
  SkillDescriptorRpc,
  ThreadGoal,
  Turn
} from "@another-workbench/shared";
import { readSessionExecutionProfile } from "@another-workbench/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import {
  createComposerAttachments,
  extractPastedMessageImages,
  mergeComposerAttachments,
  releaseComposerAttachments,
  writeComposerAttachmentDraft,
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
  ComposerExecutionSelection,
  ComposerModelExecutionPreferences,
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

export const resolveComposerModels = (input: {
  catalog?: EngineModelCatalogRpc;
  allowedModelIds?: string[];
  customModelReasoningOptionIds?: Record<string, string[]>;
}): EngineModelRpc[] => {
  if (!input.catalog) {
    return [];
  }
  const configuredIds = input.allowedModelIds ?? [];
  if (configuredIds.length === 0) {
    return input.catalog.models;
  }
  const catalogById = new Map(
    input.catalog.models.map((model) => [model.modelId, model] as const)
  );
  return configuredIds.map(
    (modelId): EngineModelRpc =>
      catalogById.get(modelId) ?? {
        modelId,
        displayName: modelId,
        reasoningOptions: (
          input.customModelReasoningOptionIds?.[modelId] ?? []
        ).map((optionId) => ({ optionId, displayName: optionId })),
        serviceTiers: [],
        isDefault: false
      }
  );
};

export const snapshotComposerExecution = (
  execution?: ComposerExecutionSelection
): ComposerExecutionSelection | undefined =>
  execution ? { ...execution } : undefined;

const resolveComposerServiceTierId = (
  model: EngineModelRpc,
  preferredServiceTierId: string | null | undefined
): string | null | undefined => {
  if (model.serviceTiers.length === 0) {
    return undefined;
  }
  if (preferredServiceTierId === null) {
    return null;
  }
  if (
    preferredServiceTierId &&
    model.serviceTiers.some((tier) => tier.tierId === preferredServiceTierId)
  ) {
    return preferredServiceTierId;
  }
  if (
    model.defaultServiceTierId &&
    model.serviceTiers.some((tier) => tier.tierId === model.defaultServiceTierId)
  ) {
    return model.defaultServiceTierId;
  }
  return null;
};

export const resolveComposerExecutionSelection = (input: {
  models: EngineModelRpc[];
  currentModelId?: string;
  persistedProfile?: SessionExecutionProfile;
  lastExecution?: ComposerExecutionSelection;
  modelExecutionPreferences?: ComposerModelExecutionPreferences;
}): ComposerExecutionSelection | undefined => {
  const currentModel = input.currentModelId
    ? input.models.find((model) => model.modelId === input.currentModelId)
    : undefined;
  const persistedModel = input.persistedProfile?.modelId
    ? input.models.find(
        (model) => model.modelId === input.persistedProfile?.modelId
      )
    : undefined;
  const lastModel = input.lastExecution
    ? input.models.find((model) => model.modelId === input.lastExecution?.modelId)
    : undefined;
  const defaultModel =
    currentModel ??
    persistedModel ??
    lastModel ??
    input.models.find((model) => model.isDefault) ??
    input.models[0];
  if (!defaultModel) {
    return undefined;
  }
  const modelPreference =
    input.modelExecutionPreferences?.[defaultModel.modelId];
  const fallbackProfile = currentModel
    ? undefined
    : persistedModel
      ? input.persistedProfile
      : input.lastExecution;
  const preferredReasoningOptionId =
    modelPreference && Object.hasOwn(modelPreference, "reasoningOptionId")
      ? modelPreference.reasoningOptionId ?? undefined
      : fallbackProfile?.reasoningOptionId;
  const preferredServiceTierId =
    modelPreference && Object.hasOwn(modelPreference, "serviceTierId")
      ? modelPreference.serviceTierId
      : fallbackProfile?.serviceTierId;
  const serviceTierId = resolveComposerServiceTierId(
    defaultModel,
    preferredServiceTierId
  );
  return {
    modelId: defaultModel.modelId,
    reasoningOptionId: defaultModel.reasoningOptions.some(
      (option) => option.optionId === preferredReasoningOptionId
    )
      ? preferredReasoningOptionId
      : undefined,
    ...(serviceTierId !== undefined ? { serviceTierId } : {})
  };
};

export const resolveInterruptTurnId = (input: {
  activeSession?: ChatSession;
  turns: Turn[];
}): string | undefined => {
  const activeTurn = [...input.turns]
    .reverse()
    .find((turn) => turn.status !== "completed");
  if (activeTurn) {
    return activeTurn.turnId;
  }
  return input.activeSession?.status === "running" ||
    input.activeSession?.status === "awaiting_approval"
    ? input.activeSession.lastTurnId
    : undefined;
};

type UseComposerControllerInput = {
  transport?: DesktopTransport;
  activeSession?: ChatSession;
  activeSessionId?: string;
  threadGoal?: ThreadGoal;
  displayedSessionId?: string;
  selectedEngineId: string;
  engineSurface?: EngineSurfaceRpc;
  allowedModelIds?: string[];
  customModelReasoningOptionIds?: Record<string, string[]>;
  modelExecutionPreferences?: ComposerModelExecutionPreferences;
  lastExecution?: ComposerExecutionSelection;
  activeWorkspaceId?: string;
  activeWorkspaceRootPath?: string;
  turns: Turn[];
  interruptTurns: Turn[];
  allowSessionLastTurnFallback?: boolean;
  approvals: ApprovalRequest[];
  isOpeningSelectedSession: boolean;
  statusNotice?: ComposerStatusNotice;
  onStatusNotice: (notice: ComposerStatusNotice | undefined) => void;
  onCreateSession?: (workspaceId: string, engineId: string) => Promise<void>;
  onOpenSession?: (sessionId: string) => Promise<void>;
  onRequestTranscriptBottom?: (sessionId: string) => void;
  onExecutionPreferenceChange?: (
    engineId: string,
    execution: ComposerExecutionSelection
  ) => void;
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
  onModelChange: (modelId: string) => void;
  onReasoningOptionChange: (reasoningOptionId: string) => void;
  onServiceTierChange: (serviceTierId: string) => void;
};

export const useComposerController = (
  input: UseComposerControllerInput
): UseComposerControllerResult => {
  const [draftBySessionId, setDraftBySessionId] = useState<Record<string, string>>({});
  const [detachedDraft, setDetachedDraft] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<ComposerSkillReference[]>([]);
  const [attachmentDrafts, setAttachmentDrafts] = useState<
    Record<string, ComposerAttachment[]>
  >({});
  const [queueBySessionId, setQueueBySessionId] = useState<
    Record<string, QueuedComposerMessage[]>
  >({});
  const [modelIdBySessionId, setModelIdBySessionId] = useState<
    Record<string, string | undefined>
  >({});
  const [detachedModelId, setDetachedModelId] = useState<string>();
  const [modelCatalog, setModelCatalog] = useState<EngineModelCatalogRpc>();
  const [isExecutionLoading, setIsExecutionLoading] = useState(false);
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
  const attachmentDraftsRef = useRef<Record<string, ComposerAttachment[]>>({});
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
  const interruptTurnId = useMemo(
    () =>
      resolveInterruptTurnId({
        activeSession: input.activeSession,
        turns: input.interruptTurns
      }),
    [input.activeSession, input.interruptTurns]
  );

  const draft = input.activeSessionId
    ? (draftBySessionId[input.activeSessionId] ?? "")
    : detachedDraft;
  const attachments = input.activeSessionId
    ? (attachmentDrafts[input.activeSessionId] ?? [])
    : [];
  const queue = input.activeSessionId
    ? (queueBySessionId[input.activeSessionId] ?? [])
    : [];
  const currentModelId = input.activeSessionId
    ? modelIdBySessionId[input.activeSessionId]
    : detachedModelId;
  const supportsTurnConfiguration = Boolean(
    input.engineSurface?.sharedCapabilities.includes("turnConfiguration")
  );
  const models = useMemo<EngineModelRpc[]>(() => {
    if (!supportsTurnConfiguration || !modelCatalog) {
      return [];
    }
    return resolveComposerModels({
      catalog: modelCatalog,
      allowedModelIds: input.allowedModelIds,
      customModelReasoningOptionIds: input.customModelReasoningOptionIds
    });
  }, [
    input.allowedModelIds,
    input.customModelReasoningOptionIds,
    modelCatalog,
    supportsTurnConfiguration
  ]);
  const execution = useMemo(
    () =>
      resolveComposerExecutionSelection({
        models,
        currentModelId,
        persistedProfile: readSessionExecutionProfile(input.activeSession?.metadata),
        lastExecution: input.lastExecution,
        modelExecutionPreferences: input.modelExecutionPreferences
      }),
    [
      currentModelId,
      input.activeSession?.metadata,
      input.lastExecution,
      input.modelExecutionPreferences,
      models
    ]
  );
  const selectedModel = models.find((model) => model.modelId === execution?.modelId);
  const reasoningOptions = selectedModel?.reasoningOptions ?? [];
  const serviceTiers = selectedModel?.serviceTiers ?? [];
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
  const isTurnActive = Boolean(
    input.activeSession?.status === "running" ||
      input.activeSession?.status === "awaiting_approval"
  );
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
    isTurnActive;
  const canStop =
    Boolean(input.transport && input.activeSessionId && interruptTurnId) &&
    isTurnActive;

  useEffect(() => {
    selectedSkillsRef.current = selectedSkills;
  }, [selectedSkills]);

  useEffect(() => {
    queueRef.current = queueBySessionId;
  }, [queueBySessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      selectedSkillsRef.current = [];
      for (const draftAttachments of Object.values(attachmentDraftsRef.current)) {
        releaseComposerAttachments(draftAttachments);
      }
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
  }, [input.activeSessionId]);

  useEffect(() => {
    if (!input.transport || !input.selectedEngineId || !supportsTurnConfiguration) {
      setModelCatalog(undefined);
      setIsExecutionLoading(false);
      return;
    }
    let cancelled = false;
    setModelCatalog(undefined);
    setIsExecutionLoading(true);
    void input.transport.engine
      .listModels(input.selectedEngineId)
      .then((catalog) => {
        if (!cancelled) {
          setModelCatalog(catalog);
          setIsExecutionLoading(false);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setModelCatalog(undefined);
          setIsExecutionLoading(false);
          input.onStatusNotice({
            message: `Model catalog failed: ${(error as Error).message}`,
            source: "settings",
            ...statusNoticeErrorDetails(error)
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    input.onStatusNotice,
    input.selectedEngineId,
    input.transport,
    supportsTurnConfiguration
  ]);

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

  const getAttachmentsForSession = (
    sessionId = input.activeSessionId
  ): ComposerAttachment[] =>
    sessionId ? (attachmentDraftsRef.current[sessionId] ?? []) : [];

  const replaceAttachmentsForSession = (
    sessionId: string | undefined,
    nextAttachments: ComposerAttachment[],
    options: {
      releaseCurrent?: boolean;
    } = {}
  ): void => {
    if (!sessionId) {
      return;
    }
    const currentAttachments = getAttachmentsForSession(sessionId);
    if (options.releaseCurrent ?? true) {
      releaseComposerAttachments(currentAttachments);
    }
    const nextDrafts = writeComposerAttachmentDraft(
      attachmentDraftsRef.current,
      sessionId,
      nextAttachments
    );
    attachmentDraftsRef.current = nextDrafts;
    setAttachmentDrafts(nextDrafts);
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

  const setTextareaCursor = (position: number): void => {
    queueMicrotask(() => {
      const element = composerTextareaRef.current;
      if (!element) {
        return;
      }
      element.focus();
      element.setSelectionRange(position, position);
      setCursorPosition(position);
    });
  };

  const moveCurrentInputToQueue = (source: QueuedComposerMessage["source"]): void => {
    const text = draft.trim();
    const currentSkills = selectedSkillsRef.current;
    const currentAttachments = getAttachmentsForSession();
    if (!text && currentSkills.length === 0 && currentAttachments.length === 0) {
      return;
    }
    appendQueueItem({
      text,
      skills: currentSkills,
      attachments: currentAttachments,
      execution: snapshotComposerExecution(execution),
      source
    });
    replaceSelectedSkills([]);
    if (input.activeSessionId) {
      replaceAttachmentsForSession(input.activeSessionId, [], {
        releaseCurrent: false
      });
    }
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
    execution?: ComposerExecutionSelection;
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
          attachments: payload.payloadAttachments.map((item) => item.attachment),
          execution: payload.execution
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
        getAttachmentsForSession().length > 0
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
    const currentAttachments = getAttachmentsForSession();
    const currentDraft = draft;
    const succeeded = await dispatchPayload({
      text: currentDraft,
      payloadSkills: selectedSkillsRef.current,
      payloadAttachments: currentAttachments,
      mode: intent,
      turnId: activeTurnId,
      execution: intent === "steer" ? undefined : execution
    });
    if (!succeeded) {
      return;
    }
    onDraftChange("");
    replaceSelectedSkills([]);
    replaceAttachmentsForSession(input.activeSessionId, [], {
      releaseCurrent: true
    });
  };

  const onQueueCurrent = (): void => {
    if (!canQueue) {
      return;
    }
    moveCurrentInputToQueue(intent === "steer" ? "steer-fallback" : "user-queue");
  };

  const onStop = async (): Promise<void> => {
    if (!input.transport || !input.activeSessionId || !interruptTurnId || !canStop) {
      return;
    }
    setIsDispatching(true);
    try {
      await input.transport.chat.interrupt({
        sessionId: input.activeSessionId,
        turnId: interruptTurnId
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
    setTextareaCursor(nextDraft.length);
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
    const targetSessionId = input.activeSessionId;
    if (!targetSessionId || input.isOpeningSelectedSession || isDispatching) {
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
    const currentAttachments = getAttachmentsForSession(targetSessionId);
    const result = mergeComposerAttachments(currentAttachments, nextAttachments);
    releaseComposerAttachments([...result.replaced, ...result.skipped]);
    replaceAttachmentsForSession(targetSessionId, result.attachments, {
      releaseCurrent: false
    });
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
    const extracted = extractPastedMessageImages(
      event.clipboardData.getData("text/plain")
    );
    const files =
      extracted?.files ?? collectPastedImageFiles(event.clipboardData);
    if (files.length === 0) {
      return;
    }
    if (extracted) {
      event.preventDefault();
      const start = event.currentTarget.selectionStart ?? draft.length;
      const end = event.currentTarget.selectionEnd ?? start;
      const nextDraft = `${draft.slice(0, start)}${extracted.text}${draft.slice(end)}`;
      const nextCursor = start + extracted.text.length;
      onDraftChange(nextDraft, nextCursor);
      setTextareaCursor(nextCursor);
    } else if (!hasStringTransfer(event.clipboardData)) {
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
    if (!input.activeSessionId) {
      return;
    }
    const currentAttachments = getAttachmentsForSession();
    const removed = currentAttachments.find(
      (attachment) => attachment.attachment.attachmentId === attachmentId
    );
    if (!removed) {
      return;
    }
    releaseComposerAttachments([removed]);
    const next = currentAttachments.filter(
      (attachment) => attachment.attachment.attachmentId !== attachmentId
    );
    replaceAttachmentsForSession(input.activeSessionId, next, {
      releaseCurrent: false
    });
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
    replaceAttachmentsForSession(input.activeSessionId, item.attachments, {
      releaseCurrent: true
    });
    if (item.execution) {
      setExecution(item.execution);
    }
    setTextareaCursor(item.text.length);
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
      turnId: activeTurnId,
      execution: mode === "send" ? item.execution : undefined
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
        mode: "send",
        execution: nextQueued.execution
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

  function setExecution(nextExecution: ComposerExecutionSelection): void {
    if (input.selectedEngineId) {
      input.onExecutionPreferenceChange?.(input.selectedEngineId, nextExecution);
    }
    if (input.activeSessionId) {
      setModelIdBySessionId((current) => ({
        ...current,
        [input.activeSessionId!]: nextExecution.modelId
      }));
      return;
    }
    setDetachedModelId(nextExecution.modelId);
  }

  const onModelChange = (modelId: string): void => {
    if (!supportsTurnConfiguration || intent === "steer") {
      return;
    }
    const nextExecution = resolveComposerExecutionSelection({
      models,
      lastExecution: { modelId },
      modelExecutionPreferences: input.modelExecutionPreferences
    });
    if (nextExecution) {
      setExecution(nextExecution);
    }
  };

  const onReasoningOptionChange = (reasoningOptionId: string): void => {
    if (!supportsTurnConfiguration || intent === "steer" || !execution?.modelId) {
      return;
    }
    setExecution({
      modelId: execution.modelId,
      reasoningOptionId: reasoningOptionId || undefined,
      serviceTierId: execution.serviceTierId
    });
  };

  const onServiceTierChange = (serviceTierId: string): void => {
    if (!supportsTurnConfiguration || intent === "steer" || !execution?.modelId) {
      return;
    }
    setExecution({
      modelId: execution.modelId,
      reasoningOptionId: execution.reasoningOptionId,
      serviceTierId: serviceTierId || null
    });
  };

  return {
    draft,
    selectedSkills,
    attachments,
    queue,
    status,
    intent,
    capabilities,
    models,
    execution,
    reasoningOptions,
    serviceTiers,
    isExecutionLoading,
    isExecutionDisabled: intent === "steer" || isDispatching,
    suggestions,
    isDispatching,
    hasComposedInput,
    isTurnActive,
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
    onSteerQueuedMessageNow,
    onModelChange,
    onReasoningOptionChange,
    onServiceTierChange
  };
};

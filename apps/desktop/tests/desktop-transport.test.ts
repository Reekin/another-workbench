import { describe, expect, it, vi } from "vitest";
import type {
  WorkbenchClientApi,
  WorkbenchEventPush,
  WorkbenchRpcRequest,
  WorkbenchRpcResponse
} from "@another-workbench/shared";
import {
  safeParseWorkbenchRpcRequest,
  safeParseWorkbenchRpcResponse
} from "@another-workbench/shared";
import {
  WorkbenchRuntimeService,
  createLocalDesktopPreloadApi
} from "@another-workbench/desktop-server";
import {
  DesktopTransportError,
  createDesktopTransport
} from "../src/transport/desktop-transport.js";
import { connectDesktopTransportToStore } from "../src/transport/store-bridge.js";
import { createRendererStore } from "../src/store/store.js";

type PreloadMock = {
  api: WorkbenchClientApi;
  request: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  emitPush: (push: WorkbenchEventPush) => void;
};

const createPreloadMock = (config?: {
  onRequest?: (request: WorkbenchRpcRequest) => Promise<WorkbenchRpcResponse>;
  onUnsubscribe?: (emitPush: (push: WorkbenchEventPush) => void) => Promise<void> | void;
}): PreloadMock => {
  let subscribedHandler: ((push: WorkbenchEventPush) => void) | undefined;
  const unsubscribe = vi.fn(async () => {
    await config?.onUnsubscribe?.((push) => {
      subscribedHandler?.(push);
    });
  });
  const request = vi.fn(async (payload: WorkbenchRpcRequest) => {
    if (config?.onRequest) {
      return config.onRequest(payload);
    }
    if (payload.method === "engine.list") {
      return {
        id: payload.id,
        method: "engine.list",
        ok: true,
        result: {
          engines: []
        }
      } as const;
    }
    if (payload.method === "engine.getSurface") {
      return {
        id: payload.id,
        method: "engine.getSurface",
        ok: true,
        result: {
          surface: {
            engineId: payload.params.engineId,
            sharedCapabilities: [],
            extensions: []
          }
        }
      } as const;
    }
    if (payload.method === "engine.listModels") {
      return {
        id: payload.id,
        method: "engine.listModels",
        ok: true,
        result: {
          catalog: {
            engineId: payload.params.engineId,
            models: []
          }
        }
      } as const;
    }
    if (payload.method === "engine.select") {
      return {
        id: payload.id,
        method: "engine.select",
        ok: true,
        result: {
          selectedEngineId: payload.params.engineId
        }
      } as const;
    }
    if (payload.method === "settings.get") {
      return {
        id: payload.id,
        method: "settings.get",
        ok: true,
        result: {}
      } as const;
    }
    if (payload.method === "settings.update") {
      return {
        id: payload.id,
        method: "settings.update",
        ok: true,
        result: payload.params
      } as const;
    }
    if (payload.method === "session.list") {
      return {
        id: payload.id,
        method: "session.list",
        ok: true,
        result: {
          sessions: []
        }
      } as const;
    }
    if (payload.method === "domain.snapshot") {
      return {
        id: payload.id,
        method: "domain.snapshot",
        ok: true,
        result: {
          snapshot: {
            conversations: [],
            sessions: [],
            turns: [],
            messageBlocks: [],
            toolCalls: [],
            terminalStreams: [],
            approvalRequests: [],
            participants: [],
            sessionRelations: []
          },
          cursor: "cursor-0"
        }
      } as const;
    }
    if (payload.method === "events.replay") {
      return {
        id: payload.id,
        method: "events.replay",
        ok: true,
        result: {
          status: "ok",
          replayed: 0,
          fromCursor: payload.params.fromCursor,
          toCursor: payload.params.toCursor,
          envelopes: []
        }
      } as const;
    }
    if (payload.method === "errorLog.write") {
      return {
        id: payload.id,
        method: "errorLog.write",
        ok: true,
        result: {
          logged: true,
          entryId: "error-1",
          logPath: "I:\\logs\\errors-2026-04-26.jsonl"
        }
      } as const;
    }
    if (payload.method === "diagnostics.write") {
      return {
        id: payload.id,
        method: "diagnostics.write",
        ok: true,
        result: {
          logged: true,
          entryId: "diagnostic-1",
          logPath: "I:\\logs\\perf-2026-04-26.jsonl"
        }
      } as const;
    }
    if (payload.method === "codex.turnChanges.get") {
      return {
        id: payload.id,
        method: "codex.turnChanges.get",
        ok: true,
        result: {
          engineId: "codex",
          sessionId: payload.params.sessionId,
          turnId: payload.params.turnId,
          changedFiles: [],
          canUndo: false
        }
      } as const;
    }
    if (payload.method === "codex.turnChanges.undo") {
      return {
        id: payload.id,
        method: "codex.turnChanges.undo",
        ok: true,
        result: {
          engineId: "codex",
          sessionId: payload.params.sessionId,
          turnId: payload.params.turnId,
          undone: true,
          displayPath: "I:\\repo"
        }
      } as const;
    }
    return {
      id: payload.id,
      method: "runtime.command",
      ok: true,
      result: {
        commandId: payload.params.envelope.commandId,
        commandType: payload.params.envelope.command.type,
        accepted: true
      }
    } as const;
  });

  const subscribe = vi.fn(async (params, handler) => {
    subscribedHandler = handler;
    return {
      subscriptionId: params.subscriptionId ?? "sub-1",
      unsubscribe
    };
  });

  return {
    api: {
      request,
      subscribe
    } satisfies WorkbenchClientApi,
    request,
    subscribe,
    emitPush: (push: WorkbenchEventPush) => {
      subscribedHandler?.(push);
    }
  };
};

describe("Desktop transport facade", () => {
  it("keeps session.list as typed read contract with default includeArchived", () => {
    const parsedRequest = safeParseWorkbenchRpcRequest({
      id: "req-session-list",
      method: "session.list",
      params: {}
    });

    expect(parsedRequest.success).toBe(true);
    if (!parsedRequest.success) {
      return;
    }
    expect(parsedRequest.data.params.includeArchived).toBe(false);

    const parsedResponse = safeParseWorkbenchRpcResponse({
      id: "req-session-list",
      method: "session.list",
      ok: true,
      result: {
        sessions: []
      }
    });

    expect(parsedResponse.success).toBe(true);
    if (!parsedResponse.success || !parsedResponse.data.ok) {
      return;
    }
    expect(parsedResponse.data.method).toBe("session.list");
    expect(Array.isArray(parsedResponse.data.result.sessions)).toBe(true);
  });

  it("maps high-level session.create to runtime.command", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api, {
      createId: () => "fixed-id",
      now: () => "2026-04-17T00:00:00.000Z"
    });

    const receipt = await transport.session.create({
      engineId: "agent-1",
      conversationId: "conversation-1",
      sessionProfile: {
        modeId: "danger-full-access"
      }
    });

    expect(receipt.commandType).toBe("createSession");
    const request = preload.request.mock.calls[0][0] as WorkbenchRpcRequest;
    expect(request.method).toBe("runtime.command");
    if (request.method !== "runtime.command") {
      throw new Error("Expected runtime.command request.");
    }
    expect(request.params.envelope.command.type).toBe("createSession");
    expect(request.params.envelope.command.engineId).toBe("agent-1");
    expect(request.params.envelope.command.sessionProfile).toEqual({
      modeId: "danger-full-access"
    });
  });

  it("maps engine discovery RPCs to dedicated typed contracts", async () => {
    const preload = createPreloadMock({
      onRequest: async (request) => {
        if (request.method === "engine.list") {
          return {
            id: request.id,
            method: request.method,
            ok: true,
            result: {
              engines: [
                {
                  engineId: "codex",
                  displayName: "Codex",
                  integrationTier: "native"
                }
              ]
            }
          } as const;
        }
        if (request.method === "engine.getSurface") {
          return {
            id: request.id,
            method: request.method,
            ok: true,
            result: {
              surface: {
                engineId: request.params.engineId,
                sharedCapabilities: ["chat", "terminal"],
                extensions: []
              }
            }
          } as const;
        }
        if (request.method === "engine.listModels") {
          return {
            id: request.id,
            method: request.method,
            ok: true,
            result: {
              catalog: {
                engineId: request.params.engineId,
                models: [
                  {
                    modelId: "gpt-5.5-codex",
                    displayName: "GPT-5.5 Codex",
                    reasoningOptions: [
                      {
                        optionId: "xhigh",
                        displayName: "Extra high"
                      }
                    ],
                    defaultReasoningOptionId: "xhigh",
                    isDefault: true
                  }
                ]
              }
            }
          } as const;
        }
        throw new Error(`Unexpected method: ${request.method}`);
      }
    });
    const transport = createDesktopTransport(preload.api);

    await expect(transport.engine.list()).resolves.toEqual([
      {
        engineId: "codex",
        displayName: "Codex",
        integrationTier: "native"
      }
    ]);
    await expect(transport.engine.getSurface("codex")).resolves.toEqual({
      engineId: "codex",
      sharedCapabilities: ["chat", "terminal"],
      extensions: []
    });
    await expect(transport.engine.listModels("codex")).resolves.toEqual({
      engineId: "codex",
      models: [
        expect.objectContaining({
          modelId: "gpt-5.5-codex",
          reasoningOptions: [expect.objectContaining({ optionId: "xhigh" })]
        })
      ]
    });
  });

  it("writes renderer error logs through the typed RPC contract", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api, {
      createId: () => "fixed-id"
    });

    const result = await transport.errorLog.write({
      message: "Send failed: boom",
      severity: "error",
      source: "send",
      stack: "Error: boom\n    at send"
    });

    expect(result).toEqual({
      logged: true,
      entryId: "error-1",
      logPath: "I:\\logs\\errors-2026-04-26.jsonl"
    });
    expect(preload.request).toHaveBeenCalledWith({
      id: "fixed-id",
      method: "errorLog.write",
      params: {
        message: "Send failed: boom",
        severity: "error",
        source: "send",
        stack: "Error: boom\n    at send"
      }
    });
  });

  it("maps engine.select to the engine-scoped RPC contract", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api);

    await expect(
      transport.engine.select({
        engineId: "codex",
        config: {
          approvalPolicy: "auto"
        }
      })
    ).resolves.toEqual({
      selectedEngineId: "codex"
    });

    const request = preload.request.mock.calls[0][0] as WorkbenchRpcRequest;
    expect(request).toMatchObject({
      method: "engine.select",
      params: {
        engineId: "codex",
        config: {
          approvalPolicy: "auto"
        }
      }
    });
  });

  it("maps Codex extension RPCs to explicit codex transport methods", async () => {
    const preload = createPreloadMock({
      onRequest: async (request) => {
        if (request.method === "codex.hookActivity.get") {
          return {
            id: request.id,
            method: request.method,
            ok: true,
            result: {
              engineId: "codex",
              sessionId: request.params.sessionId,
              turnId: request.params.turnId,
              runs: [
                {
                  id: "hook-1",
                  eventName: "preToolUse",
                  handlerType: "command",
                  executionMode: "sync",
                  scope: "turn",
                  sourcePath: "I:\\repo\\.codex\\hooks.json",
                  source: "project",
                  displayOrder: 1,
                  status: "completed",
                  statusMessage: null,
                  startedAt: 1700000000000,
                  completedAt: 1700000000025,
                  durationMs: 25,
                  entries: [
                    {
                      kind: "warning",
                      text: "checked command policy"
                    }
                  ]
                }
              ]
            }
          } as const;
        }
        if (request.method === "codex.turnChanges.get") {
          return {
            id: request.id,
            method: request.method,
            ok: true,
            result: {
              engineId: "codex",
              sessionId: request.params.sessionId,
              turnId: request.params.turnId,
              changedFiles: [
                {
                  path: "I:\\repo\\src\\foo.ts",
                  displayPath: "I:\\repo\\src\\foo.ts",
                  fileUrl: "file:///I:/repo/src/foo.ts",
                  label: "foo.ts",
                  fileName: "foo.ts",
                  extension: "ts",
                  isImage: false,
                  source: "inline_path",
                  changeKind: "update",
                  diff: `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new`
                }
              ],
              canUndo: true
            }
          } as const;
        }
        if (request.method === "codex.turnChanges.undo") {
          return {
            id: request.id,
            method: request.method,
            ok: true,
            result: {
              engineId: "codex",
              sessionId: request.params.sessionId,
              turnId: request.params.turnId,
              undone: true,
              displayPath: "I:\\repo"
            }
          } as const;
        }
        throw new Error(`Unexpected method: ${request.method}`);
      }
    });
    const transport = createDesktopTransport(preload.api);

    await expect(
      transport.codex.getHookActivity({
        sessionId: "session-1",
        turnId: "turn-1"
      })
    ).resolves.toMatchObject({
      engineId: "codex",
      sessionId: "session-1",
      turnId: "turn-1",
      runs: [
        expect.objectContaining({
          eventName: "preToolUse",
          status: "completed"
        })
      ]
    });
    await expect(
      transport.codex.getTurnChanges({
        sessionId: "session-1",
        turnId: "turn-1"
      })
    ).resolves.toMatchObject({
      engineId: "codex",
      sessionId: "session-1",
      turnId: "turn-1",
      changedFiles: [expect.objectContaining({ changeKind: "update" })],
      canUndo: true
    });
    await expect(
      transport.codex.undoTurnChanges({
        sessionId: "session-1",
        turnId: "turn-1"
      })
    ).resolves.toEqual({
      engineId: "codex",
      sessionId: "session-1",
      turnId: "turn-1",
      undone: true,
      displayPath: "I:\\repo"
    });
  });

  it("maps session.list to dedicated session.list read path", async () => {
    const preload = createPreloadMock({
      onRequest: async (request) => {
        if (request.method === "session.list") {
          return {
            id: request.id,
            method: "session.list",
            ok: true,
            result: {
              sessions: [
                {
                  sessionId: "session-1",
                  conversationId: "conversation-1",
                  engineId: "agent-1",
                  status: "idle",
                  createdAt: "2026-04-17T00:00:00.000Z",
                  updatedAt: "2026-04-17T00:00:00.000Z"
                }
              ]
            }
          } as const;
        }
        throw new Error(`Unexpected method: ${request.method}`);
      }
    });
    const transport = createDesktopTransport(preload.api);

    const sessions = await transport.session.list({
      conversationId: "conversation-1"
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe("session-1");

    const request = preload.request.mock.calls[0][0] as WorkbenchRpcRequest;
    expect(request.method).toBe("session.list");
    if (request.method !== "session.list") {
      throw new Error("Expected session.list request.");
    }
    expect(request.params.conversationId).toBe("conversation-1");
    expect(request.params.includeArchived).toBe(false);
  });

  it("maps shell settings through typed get/update RPC contracts", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api);

    await expect(transport.settings.get()).resolves.toEqual({});
    await expect(
      transport.settings.update({
        defaultNewSessionEngineId: "codex",
        allowedModelIdsByEngineId: {
          codex: ["gpt-5.5-codex", "custom-model"]
        },
        customModelReasoningOptionIdsByEngineId: {
          codex: { "custom-model": ["low", "high"] }
        },
        executionPreferencesByEngineId: {
          codex: {
            selectedModelId: "gpt-5.5-codex",
            modelPreferences: {
              "gpt-5.5-codex": { reasoningOptionId: "xhigh" }
            }
          }
        }
      })
    ).resolves.toEqual({
      defaultNewSessionEngineId: "codex",
      allowedModelIdsByEngineId: {
        codex: ["gpt-5.5-codex", "custom-model"]
      },
      customModelReasoningOptionIdsByEngineId: {
        codex: { "custom-model": ["low", "high"] }
      },
      executionPreferencesByEngineId: {
        codex: {
          selectedModelId: "gpt-5.5-codex",
          modelPreferences: {
            "gpt-5.5-codex": { reasoningOptionId: "xhigh" }
          }
        }
      }
    });

    const getRequest = preload.request.mock.calls[0][0] as WorkbenchRpcRequest;
    const updateRequest = preload.request.mock.calls[1][0] as WorkbenchRpcRequest;
    expect(getRequest.method).toBe("settings.get");
    expect(updateRequest.method).toBe("settings.update");
    if (updateRequest.method !== "settings.update") {
      throw new Error("Expected settings.update request.");
    }
    expect(updateRequest.params.executionPreferencesByEngineId).toEqual({
      codex: {
        selectedModelId: "gpt-5.5-codex",
        modelPreferences: {
          "gpt-5.5-codex": { reasoningOptionId: "xhigh" }
        }
      }
    });
  });

  it("maps steer, chat capabilities, and skills list through the new composer contracts", async () => {
    const preload = createPreloadMock({
      onRequest: async (request) => {
        if (request.method === "runtime.command") {
          return {
            id: request.id,
            method: request.method,
            ok: true,
            result: {
              commandId: request.params.envelope.commandId,
              commandType: request.params.envelope.command.type,
              accepted: true
            }
          } as const;
        }
        if (request.method === "chat.getCapabilities") {
          return {
            id: request.id,
            method: request.method,
            ok: true,
            result: {
              capabilities: {
                supportsSteer: true,
                supportsAttachments: true,
                slashSuggestions: [
                  {
                    id: "status",
                    label: "/status",
                    detail: "Summarize the current session state",
                    replacement:
                      "Summarize the current session status and the next best action."
                  }
                ]
              }
            }
          } as const;
        }
        if (request.method === "skills.list") {
          return {
            id: request.id,
            method: request.method,
            ok: true,
            result: {
              skills: [
                {
                  cwd: "I:/repo",
                  name: "task-breakdown",
                  description: "Split work into tasks.",
                  shortDescription: "Roadmap helper",
                  path: "C:/Users/TestUser/.codex/skills/task-breakdown/SKILL.md",
                  scope: "user",
                  enabled: true
                }
              ]
            }
          } as const;
        }
        throw new Error(`Unexpected method: ${request.method}`);
      }
    });
    const transport = createDesktopTransport(preload.api, {
      createId: () => "fixed-id"
    });

    await expect(
      transport.chat.steer({
        sessionId: "session-1",
        turnId: "turn-1",
        content: "Focus on the failing test",
        attachments: []
      })
    ).resolves.toMatchObject({
      commandType: "steerTurn",
      accepted: true
    });
    await expect(transport.chat.getCapabilities("session-1")).resolves.toEqual({
      supportsSteer: true,
      supportsAttachments: true,
      slashSuggestions: [
        {
          id: "status",
          label: "/status",
          detail: "Summarize the current session state",
          replacement:
            "Summarize the current session status and the next best action."
        }
      ]
    });
    await expect(
      transport.skills.list({
        cwds: ["I:/repo"],
        forceReload: true
      })
    ).resolves.toEqual([
      expect.objectContaining({
        name: "task-breakdown",
        enabled: true
      })
    ]);

    const steerRequest = preload.request.mock.calls[0][0] as WorkbenchRpcRequest;
    expect(steerRequest.method).toBe("runtime.command");
    if (steerRequest.method !== "runtime.command") {
      throw new Error("Expected runtime.command request.");
    }
    expect(steerRequest.params.envelope.command).toMatchObject({
      type: "steerTurn",
      sessionId: "session-1",
      turnId: "turn-1",
      content: "Focus on the failing test"
    });

    const capabilitiesRequest = preload.request.mock.calls[1][0] as WorkbenchRpcRequest;
    expect(capabilitiesRequest).toMatchObject({
      method: "chat.getCapabilities",
      params: {
        sessionId: "session-1"
      }
    });

    const skillsRequest = preload.request.mock.calls[2][0] as WorkbenchRpcRequest;
    expect(skillsRequest).toMatchObject({
      method: "skills.list",
      params: {
        cwds: ["I:/repo"],
        forceReload: true
      }
    });
  });

  it("maps chat goal commands through runtime.command", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api, {
      createId: () => "fixed-id"
    });

    await expect(
      transport.chat.setGoal({
        sessionId: "session-1",
        objective: "Wire up Codex goals",
        status: "active",
        tokenBudget: 9000
      })
    ).resolves.toMatchObject({
      commandType: "setThreadGoal",
      accepted: true
    });
    await expect(
      transport.chat.setGoal({
        sessionId: "session-1",
        status: "paused"
      })
    ).resolves.toMatchObject({
      commandType: "setThreadGoal",
      accepted: true
    });
    await expect(
      transport.chat.clearGoal({
        sessionId: "session-1"
      })
    ).resolves.toMatchObject({
      commandType: "clearThreadGoal",
      accepted: true
    });

    const setRequest = preload.request.mock.calls[0][0] as WorkbenchRpcRequest;
    const pauseRequest = preload.request.mock.calls[1][0] as WorkbenchRpcRequest;
    const clearRequest = preload.request.mock.calls[2][0] as WorkbenchRpcRequest;
    expect(setRequest.method).toBe("runtime.command");
    expect(pauseRequest.method).toBe("runtime.command");
    expect(clearRequest.method).toBe("runtime.command");
    if (
      setRequest.method !== "runtime.command" ||
      pauseRequest.method !== "runtime.command" ||
      clearRequest.method !== "runtime.command"
    ) {
      throw new Error("Expected runtime.command requests.");
    }
    expect(setRequest.params.envelope.command).toMatchObject({
      type: "setThreadGoal",
      sessionId: "session-1",
      objective: "Wire up Codex goals",
      status: "active",
      tokenBudget: 9000
    });
    expect(pauseRequest.params.envelope.command).toMatchObject({
      type: "setThreadGoal",
      sessionId: "session-1",
      status: "paused"
    });
    expect(pauseRequest.params.envelope.command).not.toHaveProperty("objective");
    expect(clearRequest.params.envelope.command).toMatchObject({
      type: "clearThreadGoal",
      sessionId: "session-1"
    });
  });

  it("throws DesktopTransportError when low-level request fails", async () => {
    const preload = createPreloadMock({
      onRequest: async (request) => {
        if (request.method === "runtime.command") {
          return {
            id: request.id,
            method: request.method,
            ok: false,
            error: {
              code: "PERMISSION_DENIED",
              message: "not allowed"
            }
          } as const;
        }
        return {
          id: request.id,
          method: "engine.list",
          ok: true,
          result: {
            engines: []
          }
        } as const;
      }
    });
    const transport = createDesktopTransport(preload.api);

    await expect(
      transport.chat.interrupt({
        sessionId: "session-1",
        turnId: "turn-1"
      })
    ).rejects.toBeInstanceOf(DesktopTransportError);
  });

  it("bridges event envelopes into renderer store ingestion", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api, {
      scheduleEventDrain: (callback) => {
        callback();
        return () => undefined;
      }
    });
    const store = createRendererStore();

    await connectDesktopTransportToStore({
      transport,
      store
    });

    expect(preload.subscribe).toHaveBeenCalledTimes(1);
    expect(preload.subscribe.mock.calls[0][0].fromCursor).toBe("cursor-0");

    preload.emitPush({
      channel: "workbench.events",
      subscriptionId: "sub-1",
      envelope: {
        eventId: "evt-1",
        cursor: "cursor-11",
        occurredAt: "2026-04-17T00:00:01.000Z",
        event: {
          type: "turn.started",
          sessionId: "session-1",
          turnId: "turn-1"
        }
      }
    });

    const nextState = store.getState();
    expect(nextState.eventStream.lastEventId).toBe("evt-1");
    expect(nextState.eventStream.lastCursor).toBe("cursor-11");
    expect(store.getDomainReadModel().getTurn("turn-1")?.sessionId).toBe("session-1");
  });

  it("subscribes without a conversation filter by default so renderer state stays globally mirrored", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api);
    const store = createRendererStore();

    await connectDesktopTransportToStore({
      transport,
      store
    });

    expect(preload.subscribe).toHaveBeenCalledTimes(1);
    expect(preload.subscribe.mock.calls[0][0].filter).toBeUndefined();
  });

  it("still forwards an explicit event filter for specialized consumers", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api);
    const store = createRendererStore();

    await connectDesktopTransportToStore({
      transport,
      store,
      filter: {
        conversationId: "conversation-2"
      }
    });

    expect(preload.subscribe).toHaveBeenCalledTimes(1);
    expect(preload.subscribe.mock.calls[0][0].filter).toEqual({
      conversationId: "conversation-2"
    });
  });

  it("uses typed events.replay wrapper instead of raw request()", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api);

    const replay = await transport.events.replay({
      fromCursor: "cursor-20",
      toCursor: "cursor-30"
    });

    expect(replay.fromCursor).toBe("cursor-20");
    expect(replay.status).toBe("ok");
    expect(replay.envelopes).toEqual([]);
    const request = preload.request.mock.calls[0][0] as WorkbenchRpcRequest;
    expect(request.method).toBe("events.replay");
  });

  it("maps file actions to the typed RPC contract", async () => {
    const preload = createPreloadMock({
      onRequest: async (request) => {
        if (request.method === "file.runAction") {
          return {
            id: request.id,
            method: request.method,
            ok: true,
            result: {
              result: {
                action: request.params.action,
                ok: true,
                displayPath: request.params.path,
                fileUrl: "file:///I:/repo/docs/README.md"
              }
            }
          } as const;
        }
        throw new Error(`Unexpected method: ${request.method}`);
      }
    });
    const transport = createDesktopTransport(preload.api);

    await expect(
      transport.file.runAction({
        path: "I:\\repo\\docs\\README.md",
        action: "reveal"
      })
    ).resolves.toEqual({
      action: "reveal",
      ok: true,
      displayPath: "I:\\repo\\docs\\README.md",
      fileUrl: "file:///I:/repo/docs/README.md"
    });

    const actionRequest = preload.request.mock.calls[0][0] as WorkbenchRpcRequest;
    expect(actionRequest.method).toBe("file.runAction");
    if (actionRequest.method === "file.runAction") {
      expect(actionRequest.params).toEqual({
        path: "I:\\repo\\docs\\README.md",
        action: "reveal"
      });
    }
  });

  it("preflights replay when store already has domain state and reuses lastCursor for subscription", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api, {
      scheduleEventDrain: (callback) => {
        callback();
        return () => undefined;
      }
    });
    const store = createRendererStore();
    store.ingestEnvelope({
      eventId: "evt-10",
      cursor: "cursor-10",
      occurredAt: "2026-04-17T00:00:00.000Z",
      event: {
        type: "session.created",
        conversationId: "conversation-1",
        sessionId: "session-1",
        engineId: "agent-1",
        status: "idle"
      }
    });

    await connectDesktopTransportToStore({
      transport,
      store
    });

    expect(preload.request).toHaveBeenCalledTimes(1);
    expect(preload.request.mock.calls[0][0]).toMatchObject({
      method: "events.replay",
      params: {
        fromCursor: "cursor-10"
      }
    });
    expect(preload.subscribe).toHaveBeenCalledTimes(1);
    expect(preload.subscribe.mock.calls[0][0].fromCursor).toBe("cursor-10");

    preload.emitPush({
      channel: "workbench.events",
      subscriptionId: "sub-1",
      envelope: {
        eventId: "evt-live-1",
        cursor: "cursor-12",
        occurredAt: "2026-04-17T00:00:02.000Z",
        event: {
          type: "turn.completed",
          sessionId: "session-1",
          turnId: "turn-replay-1",
          finishReason: "completed"
        }
      }
    });

    const finalState = store.getState();
    expect(store.getDomainReadModel().getTurn("turn-replay-1")?.status).toBe("completed");
    expect(finalState.eventStream.lastCursor).toBe("cursor-12");
  });

  it("hydrates a fresh snapshot and resumes from its cursor when replay reports a gap", async () => {
    const preload = createPreloadMock({
      onRequest: async (request) => {
        if (request.method === "events.replay") {
          return {
            id: request.id,
            method: "events.replay",
            ok: true,
            result: {
              status: "gap",
              reason: "cursor_not_found",
              replayed: 0,
              fromCursor: request.params.fromCursor,
              toCursor: request.params.toCursor,
              envelopes: []
            }
          } as const;
        }
        if (request.method === "domain.snapshot") {
          return {
            id: request.id,
            method: "domain.snapshot",
            ok: true,
            result: {
              snapshot: {
                conversations: [
                  {
                    conversationId: "conversation-snapshot",
                    createdAt: "2026-04-17T00:00:00.000Z",
                    updatedAt: "2026-04-17T00:00:00.000Z",
                    sessionIds: ["session-snapshot"],
                    activeSessionId: "session-snapshot",
                    participantEngineIds: []
                  }
                ],
                sessions: [
                  {
                    sessionId: "session-snapshot",
                    conversationId: "conversation-snapshot",
                    engineId: "agent-1",
                    title: "Recovered",
                    status: "idle",
                    createdAt: "2026-04-17T00:00:00.000Z",
                    updatedAt: "2026-04-17T00:00:00.000Z"
                  }
                ],
                turns: [],
                messageBlocks: [],
                toolCalls: [],
                terminalStreams: [],
                approvalRequests: [],
                participants: [],
                sessionRelations: []
              },
              cursor: "cursor-30"
            }
          } as const;
        }
        throw new Error(`Unexpected request ${request.method}`);
      }
    });
    const transport = createDesktopTransport(preload.api);
    const store = createRendererStore();
    store.ingestEnvelope({
      eventId: "evt-10",
      cursor: "cursor-10",
      occurredAt: "2026-04-17T00:00:00.000Z",
      event: {
        type: "session.created",
        conversationId: "conversation-stale",
        sessionId: "session-stale",
        engineId: "agent-1",
        status: "idle"
      }
    });

    await connectDesktopTransportToStore({
      transport,
      store
    });

    expect(preload.request.mock.calls.map((call) => call[0].method)).toEqual([
      "events.replay",
      "domain.snapshot"
    ]);
    expect(preload.subscribe).toHaveBeenCalledTimes(1);
    expect(preload.subscribe.mock.calls[0][0].fromCursor).toBe("cursor-30");
    expect(store.getState().eventStream.lastCursor).toBe("cursor-30");
    expect(store.getDomainReadModel().getSession("session-snapshot")?.title).toBe(
      "Recovered"
    );
  });

  it("recovers a stale cursor through local runtime snapshot fallback", async () => {
    const service = new WorkbenchRuntimeService({
      now: (() => {
        let tick = 0;
        return () => `2026-04-17T00:00:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createConversationId: () => "conversation-runtime",
      createSessionId: () => "session-runtime",
      createEventId: (() => {
        let tick = 0;
        return () => `evt-runtime-${++tick}`;
      })(),
      engines: [
        {
          engineId: "codex",
          displayName: "Codex",
          capabilities: ["chat"]
        }
      ]
    });
    await service.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex"
      }
    });
    const runtimeSnapshot = service.getSnapshotResult();
    const transport = createDesktopTransport(
      createLocalDesktopPreloadApi(service, {
        createSubscriptionId: () => "sub-local-runtime"
      }),
      {
        scheduleEventDrain: (callback) => {
          callback();
          return () => undefined;
        }
      }
    );
    const store = createRendererStore();
    store.ingestEnvelope({
      eventId: "evt-stale",
      cursor: "cursor-stale",
      occurredAt: "2026-04-17T00:00:00.000Z",
      event: {
        type: "session.created",
        conversationId: "conversation-stale",
        sessionId: "session-stale",
        engineId: "codex",
        status: "idle"
      }
    });

    const subscription = await connectDesktopTransportToStore({
      transport,
      store
    });

    expect(store.getState().eventStream.lastCursor).toBe(runtimeSnapshot.cursor);
    expect(store.getDomainReadModel().getSession("session-runtime")?.engineId).toBe(
      "codex"
    );
    expect(store.getDomainReadModel().getSession("session-stale")).toBeUndefined();
    expect(subscription.subscriptionId).toBe("sub-local-runtime");

    await subscription.unsubscribe();
    await service.dispose();
  });

  it("drains live event pushes in scheduled batches", async () => {
    const scheduled: Array<() => void> = [];
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api, {
      eventBatchMaxSize: 10,
      scheduleEventDrain: (callback) => {
        scheduled.push(callback);
        return () => undefined;
      }
    });
    const store = createRendererStore();
    const actions: string[] = [];
    store.subscribe((_state, action) => {
      actions.push(action.type);
    });

    await connectDesktopTransportToStore({
      transport,
      store,
      fromCursor: "cursor-0"
    });

    preload.emitPush({
      channel: "workbench.events",
      subscriptionId: "sub-1",
      envelope: {
        eventId: "evt-session-created",
        cursor: "cursor-session-created",
        occurredAt: "2026-04-17T00:00:00.000Z",
        event: {
          type: "session.created",
          conversationId: "conversation-1",
          sessionId: "session-1",
          engineId: "agent-1",
          status: "idle"
        }
      }
    });

    for (let index = 1; index <= 3; index += 1) {
      preload.emitPush({
        channel: "workbench.events",
        subscriptionId: "sub-1",
        envelope: {
          eventId: `evt-${index}`,
          cursor: `cursor-${index}`,
          occurredAt: "2026-04-17T00:00:01.000Z",
          event: {
            type: "message.delta",
            sessionId: "session-1",
            turnId: "turn-1",
            messageId: "message-1",
            delta: String(index)
          }
        }
      });
    }

    expect(store.getState().eventStream.lastCursor).toBe("cursor-0");
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();

    expect(store.getState().eventStream.lastCursor).toBe("cursor-3");
    expect(store.getDomainReadModel().getMessageBlock("message-1:md")?.text).toBe("123");
    expect(actions).toEqual(["store/hydrateSnapshot", "store/ingestEnvelopes"]);
  });

  it("forwards provider-native turn execution options only on ordinary sends", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api, {
      createId: () => "fixed-id"
    });

    await transport.chat.send({
      sessionId: "session-1",
      content: "Use the selected model",
      execution: {
        modelId: "gpt-5.5-codex",
        reasoningOptionId: "xhigh",
        serviceTierId: "ultrafast"
      }
    });
    await transport.chat.steer({
      sessionId: "session-1",
      turnId: "turn-1",
      content: "Keep going"
    });

    const sendRequest = preload.request.mock.calls[0][0] as WorkbenchRpcRequest;
    const steerRequest = preload.request.mock.calls[1][0] as WorkbenchRpcRequest;
    if (
      sendRequest.method !== "runtime.command" ||
      steerRequest.method !== "runtime.command"
    ) {
      throw new Error("Expected runtime.command requests.");
    }
    expect(sendRequest.params.envelope.command).toMatchObject({
      type: "sendUserMessage",
      execution: {
        modelId: "gpt-5.5-codex",
        reasoningOptionId: "xhigh",
        serviceTierId: "ultrafast"
      }
    });
    expect(steerRequest.params.envelope.command).toMatchObject({
      type: "steerTurn"
    });
    expect(steerRequest.params.envelope.command).not.toHaveProperty("execution");
  });

  it("bounds renderer drain batches by serialized bytes", async () => {
    const scheduled: Array<() => void> = [];
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api, {
      eventBatchMaxSize: 100,
      eventBatchMaxBytes: 700,
      scheduleEventDrain: (callback) => {
        scheduled.push(callback);
        return () => undefined;
      }
    });
    const batches: EventEnvelope[][] = [];

    await transport.events.subscribe({
      fromCursor: "cursor-0",
      onEnvelope: () => undefined,
      onEnvelopes: (envelopes) => batches.push(envelopes)
    });
    for (let index = 1; index <= 3; index += 1) {
      preload.emitPush({
        channel: "workbench.events",
        subscriptionId: "sub-1",
        envelope: {
          eventId: `evt-byte-${index}`,
          cursor: `cursor-${index}`,
          occurredAt: "2026-07-19T00:00:00.000Z",
          event: {
            type: "message.delta",
            sessionId: "session-1",
            turnId: "turn-1",
            messageId: "message-1",
            delta: "x".repeat(400)
          }
        }
      });
    }

    scheduled.shift()?.();
    scheduled.shift()?.();
    scheduled.shift()?.();
    expect(batches.map((batch) => batch.length)).toEqual([1, 1, 1]);
  });

  it("reports backlog pressure for queued stream events", async () => {
    const scheduled: Array<() => void> = [];
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api, {
      eventBacklogPressurePendingThreshold: 2,
      eventBacklogPressureStreamThreshold: 2,
      scheduleEventDrain: (callback) => {
        scheduled.push(callback);
        return () => undefined;
      }
    });
    const pressures: unknown[] = [];

    await transport.events.subscribe({
      fromCursor: "cursor-0",
      onEnvelope: () => undefined,
      onBacklogPressure: (pressure) => pressures.push(pressure)
    });

    for (let index = 1; index <= 2; index += 1) {
      preload.emitPush({
        channel: "workbench.events",
        subscriptionId: "sub-1",
        envelope: {
          eventId: `evt-pressure-${index}`,
          cursor: `cursor-${index}`,
          occurredAt: "2026-04-17T00:00:01.000Z",
          event: {
            type: "message.delta",
            sessionId: "session-a",
            turnId: "turn-a",
            messageId: "message-a",
            delta: String(index)
          }
        }
      });
    }

    expect(scheduled).toHaveLength(1);
    expect(pressures).toEqual([
      {
        pendingCount: 2,
        streamPendingCount: 2,
        lastCursor: "cursor-2",
        sessions: {
          "session-a": {
            streamPendingCount: 2,
            lastCursor: "cursor-2"
          }
        }
      }
    ]);
  });

  it("flushes queued event pushes after upstream unsubscribe drains pending batches", async () => {
    const scheduled: Array<() => void> = [];
    const cancelled = new Set<() => void>();
    const preload = createPreloadMock({
      onUnsubscribe: (emitPush) => {
        emitPush({
          channel: "workbench.events",
          subscriptionId: "sub-1",
          envelope: {
            eventId: "evt-unsubscribe-2",
            cursor: "cursor-2",
            occurredAt: "2026-04-17T00:00:02.000Z",
            event: {
              type: "message.delta",
              sessionId: "session-1",
              turnId: "turn-1",
              messageId: "message-1",
              delta: "2"
            }
          }
        });
      }
    });
    const transport = createDesktopTransport(preload.api, {
      eventBatchMaxSize: 10,
      scheduleEventDrain: (callback) => {
        scheduled.push(callback);
        return () => {
          cancelled.add(callback);
        };
      }
    });
    const store = createRendererStore();
    const actions: string[] = [];
    store.subscribe((_state, action) => {
      actions.push(action.type);
    });

    const subscription = await connectDesktopTransportToStore({
      transport,
      store,
      fromCursor: "cursor-0"
    });

    preload.emitPush({
      channel: "workbench.events",
      subscriptionId: "sub-1",
      envelope: {
        eventId: "evt-session-created",
        cursor: "cursor-session-created",
        occurredAt: "2026-04-17T00:00:00.000Z",
        event: {
          type: "session.created",
          conversationId: "conversation-1",
          sessionId: "session-1",
          engineId: "agent-1",
          status: "idle"
        }
      }
    });

    preload.emitPush({
      channel: "workbench.events",
      subscriptionId: "sub-1",
      envelope: {
        eventId: "evt-unsubscribe-1",
        cursor: "cursor-1",
        occurredAt: "2026-04-17T00:00:01.000Z",
        event: {
          type: "message.delta",
          sessionId: "session-1",
          turnId: "turn-1",
          messageId: "message-1",
          delta: "1"
        }
      }
    });

    expect(scheduled).toHaveLength(1);
    expect(store.getState().eventStream.lastCursor).toBe("cursor-0");

    await subscription.unsubscribe();

    expect(cancelled.has(scheduled[0]!)).toBe(true);
    expect(store.getState().eventStream.lastCursor).toBe("cursor-2");
    expect(store.getDomainReadModel().getMessageBlock("message-1:md")?.text).toBe("12");
    expect(actions).toEqual(["store/hydrateSnapshot", "store/ingestEnvelopes"]);
  });
});

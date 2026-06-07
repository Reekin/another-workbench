import type { DomainSnapshot } from "@another-workbench/shared";
import type { HostToolRegistration, HostToolResult } from "./host-tools.js";
import {
  buildReadSessionTranscript,
  defaultReadSessionMaxTextChars,
  defaultReadSessionTurnLimit,
  maxReadSessionMaxTextChars,
  maxReadSessionTurnLimit,
  serializeReadSessionTranscript
} from "./read-session-transcript.js";

export const readSessionToolNamespace = "another_workbench";
export const readSessionToolName = "read_session";

export type ReadSessionRuntime = {
  getSnapshot: () => DomainSnapshot;
  ensureSessionLoaded?: (
    sessionId: string,
    options?: { force?: boolean }
  ) => Promise<boolean> | boolean;
  isSessionPartiallyHydrated?: (sessionId: string) => boolean;
};

type ReadSessionArgs = {
  sessionId: string;
  limit?: number;
  maxChars?: number;
};

const textResult = (text: string, success = true): HostToolResult => ({
  contentItems: [
    {
      type: "inputText",
      text
    }
  ],
  success
});

const parseArgs = (value: unknown): ReadSessionArgs => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object with a non-empty sessionId.");
  }
  const record = value as Record<string, unknown>;
  const sessionId =
    typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  if (!sessionId) {
    throw new Error("sessionId is required.");
  }

  const limitValue = record.limit;
  let limit: number | undefined;
  if (
    limitValue !== undefined &&
    (typeof limitValue !== "number" ||
      !Number.isInteger(limitValue) ||
      limitValue <= 0 ||
      limitValue > maxReadSessionTurnLimit)
  ) {
    throw new Error(
      `limit must be a positive integer up to ${maxReadSessionTurnLimit} when provided.`
    );
  }
  if (typeof limitValue === "number") {
    limit = limitValue;
  }

  const maxCharsValue = record.maxChars;
  let maxChars: number | undefined;
  if (maxCharsValue !== undefined) {
    if (
      typeof maxCharsValue !== "number" ||
      !Number.isInteger(maxCharsValue) ||
      maxCharsValue <= 0 ||
      maxCharsValue > maxReadSessionMaxTextChars
    ) {
      throw new Error(
        `maxChars must be a positive integer up to ${maxReadSessionMaxTextChars} when provided.`
      );
    }
    maxChars = maxCharsValue;
  }
  return {
    sessionId,
    limit,
    maxChars
  };
};

const snapshotHasSession = (snapshot: DomainSnapshot, sessionId: string): boolean =>
  snapshot.sessions.some((session) => session.sessionId === sessionId);

export const createReadSessionHostTool = (
  runtime: ReadSessionRuntime
): HostToolRegistration => ({
  namespace: readSessionToolNamespace,
  name: readSessionToolName,
  description:
    "Read an AWB session by AWB sessionId and return the collapsed visible user/final-agent transcript as JSON.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        minLength: 1,
        description: "AWB ChatSession.sessionId to read."
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: maxReadSessionTurnLimit,
        default: defaultReadSessionTurnLimit,
        description:
          "Optional maximum number of latest turns to return after chronological sorting."
      },
      maxChars: {
        type: "integer",
        minimum: 1,
        maximum: maxReadSessionMaxTextChars,
        default: defaultReadSessionMaxTextChars,
        description:
          "Optional text character budget for user and agentFinal fields before truncation."
      }
    },
    required: ["sessionId"],
    additionalProperties: false
  },
  handle: async (invocation) => {
    try {
      const args = parseArgs(invocation.arguments);
      let snapshot = runtime.getSnapshot();
      const hadSession = snapshotHasSession(snapshot, args.sessionId);
      const needsFullHydration =
        hadSession && runtime.isSessionPartiallyHydrated?.(args.sessionId) === true;
      if ((!hadSession || needsFullHydration) && runtime.ensureSessionLoaded) {
        const loaded = await runtime.ensureSessionLoaded(args.sessionId, {
          force: needsFullHydration
        });
        if (loaded) {
          snapshot = runtime.getSnapshot();
        } else if (needsFullHydration) {
          throw new Error(`Session could not be fully loaded: ${args.sessionId}`);
        }
      } else if (needsFullHydration) {
        throw new Error(`Session could not be fully loaded: ${args.sessionId}`);
      }
      const transcript = buildReadSessionTranscript({
        snapshot,
        sessionId: args.sessionId,
        limit: args.limit,
        maxTextChars: args.maxChars
      });
      return textResult(serializeReadSessionTranscript(transcript));
    } catch (error) {
      return textResult(
        error instanceof Error ? error.message : "Failed to read session.",
        false
      );
    }
  }
});

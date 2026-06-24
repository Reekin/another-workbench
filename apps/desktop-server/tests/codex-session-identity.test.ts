import { describe, expect, it } from "vitest";
import {
  codexProviderKind,
  discoveredCodexSessionId,
  resolveCodexThreadId
} from "../src/codex-session-identity.js";

describe("codex session identity helpers", () => {
  it("keeps discovered session ids canonical", () => {
    expect(discoveredCodexSessionId("thread-1")).toBe("codex-thread:thread-1");
  });

  it("resolves canonical Codex provider handles", () => {
    expect(
      resolveCodexThreadId(
        {
          providerHandle: {
            providerKind: codexProviderKind,
            providerSessionId: "thread-handle"
          }
        }
      )
    ).toBe("thread-handle");
  });

  it("does not infer thread ids from unrelated or unnormalized context fields", () => {
    expect(
      resolveCodexThreadId(
        {
          providerHandle: {
            providerKind: "other-provider",
            providerSessionId: "thread-other"
          }
        }
      )
    ).toBeUndefined();
    expect(
      resolveCodexThreadId(
        {
          indexEntry: {
            providerSessionId: "thread-indexed"
          }
        } as never
      )
    ).toBeUndefined();
  });
});

import type { ProviderSessionHandle } from "@another-workbench/shared";

export const codexProviderKind = "codex-thread";

export const discoveredCodexSessionId = (threadId: string): string =>
  `${codexProviderKind}:${threadId}`;

export const resolveCodexThreadId = (
  input: {
    providerHandle?: ProviderSessionHandle;
  }
): string | undefined =>
  (input.providerHandle?.providerKind === codexProviderKind
    ? input.providerHandle.providerSessionId
    : undefined);

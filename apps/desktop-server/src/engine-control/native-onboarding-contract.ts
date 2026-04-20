export const nativeEngineOnboardingContract = {
  requiredTouchpoints: [
    "apps/desktop-server/src/engine-control/*",
    "packages/adapters/src/<engine>/*",
    "apps/desktop-server/src/prod-service.ts"
  ],
  optionalTouchpoints: [
    "apps/desktop-server/src/*-provider.ts",
    "apps/desktop/src/ui/chat-shell/*"
  ],
  protectedScopes: [
    "apps/desktop/src/store/*",
    "apps/desktop/src/ui/chat-shell/transcript*",
    "packages/core/*"
  ]
} as const;

export type NativeEngineOnboardingContract = typeof nativeEngineOnboardingContract;

import { describe, expect, it } from "vitest";
import { nativeEngineOnboardingContract } from "../src/engine-control/native-onboarding-contract.js";

describe("nativeEngineOnboardingContract", () => {
  it("defines required touchpoints and protected scopes for future native engines", () => {
    expect(nativeEngineOnboardingContract.requiredTouchpoints.length).toBeGreaterThan(0);
    expect(nativeEngineOnboardingContract.protectedScopes.length).toBeGreaterThan(0);
    expect(nativeEngineOnboardingContract.requiredTouchpoints).toContain(
      "apps/desktop-server/src/prod-service.ts"
    );
    expect(nativeEngineOnboardingContract.protectedScopes).toContain(
      "packages/core/*"
    );
  });
});

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeEngineOnboardingContract } from "../apps/desktop-server/src/engine-control/native-onboarding-contract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const repoRoot = resolve(__dirname, "..");

const requiredPaths = [
  "apps/desktop-server/src/engine-control",
  "apps/desktop-server/src/prod-service.ts",
  "packages/adapters/src"
];

const missingPaths = requiredPaths.filter(
  (relativePath) => !existsSync(resolve(repoRoot, relativePath))
);

if (nativeEngineOnboardingContract.requiredTouchpoints.length === 0) {
  throw new Error("Native engine onboarding contract must define required touchpoints.");
}

if (nativeEngineOnboardingContract.protectedScopes.length === 0) {
  throw new Error("Native engine onboarding contract must define protected scopes.");
}

if (missingPaths.length > 0) {
  throw new Error(`Missing required native-engine boundary paths: ${missingPaths.join(", ")}`);
}

console.log("Native engine onboarding boundaries are present.");
console.log(`Required touchpoints: ${nativeEngineOnboardingContract.requiredTouchpoints.join(", ")}`);
console.log(`Protected scopes: ${nativeEngineOnboardingContract.protectedScopes.join(", ")}`);

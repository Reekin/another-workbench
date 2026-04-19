import { describe, expect, it } from "vitest";
import * as browserEntry from "../src/browser.js";

describe("desktop-server browser entry", () => {
  it("exposes browser-safe demo helpers without node-only remote server exports", () => {
    expect(typeof browserEntry.createLocalDesktopPreloadApi).toBe("function");
    expect(typeof browserEntry.createRemoteRpcHandler).toBe("function");
    expect(typeof browserEntry.createDemoWorkbenchRuntimeService).toBe("function");
    expect("WorkbenchRemoteServer" in browserEntry).toBe(false);
    expect("isRemoteRequestAuthorized" in browserEntry).toBe(false);
  });
});

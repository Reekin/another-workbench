import { describe, expect, it } from "vitest";
import {
  resolveEngineProgramCommand,
  resolveEngineSpawnCommand
} from "../src/engine-program-resolution.js";

describe("resolveEngineProgramCommand", () => {
  it("prefers a custom path over configured and environment paths", () => {
    expect(
      resolveEngineProgramCommand("codex", {
        customPath: "C:\\custom\\codex.exe",
        configuredPath: "C:\\configured\\codex.exe",
        env: {
          AWB_CODEX_BIN: "C:\\env\\codex.exe"
        },
        platform: "win32"
      })
    ).toEqual({
      path: "C:\\custom\\codex.exe",
      source: "custom",
      args: ["app-server"]
    });
  });

  it("reports the first environment variable that resolved Codex", () => {
    expect(
      resolveEngineProgramCommand("codex", {
        env: {
          CODEX_BIN: "C:\\tools\\codex.exe",
          CODEX_PATH: "C:\\older\\codex.exe"
        },
        platform: "win32"
      })
    ).toEqual({
      path: "C:\\tools\\codex.exe",
      source: "environment",
      environmentVariable: "CODEX_BIN",
      args: ["app-server"]
    });
  });

  it("skips blank environment values and keeps Pi defaults for configured paths", () => {
    expect(
      resolveEngineProgramCommand("codex", {
        env: {
          AWB_CODEX_BIN: " ",
          CODEX_BIN: "C:\\tools\\codex.exe"
        },
        platform: "win32"
      })
    ).toMatchObject({
      path: "C:\\tools\\codex.exe",
      environmentVariable: "CODEX_BIN"
    });
    expect(
      resolveEngineProgramCommand("pi-acp", {
        configuredPath: "npx.cmd",
        env: {},
        platform: "win32"
      })
    ).toEqual({
      path: "npx.cmd",
      source: "configured",
      args: ["-y", "pi-acp"]
    });
  });

  it("uses npx with package arguments only for the Pi default command", () => {
    expect(
      resolveEngineProgramCommand("pi-acp", {
        env: {},
        platform: "win32"
      })
    ).toEqual({
      path: "npx.cmd",
      source: "default",
      args: ["-y", "pi-acp"]
    });
  });

  it("runs Windows command shims through cmd.exe", () => {
    expect(
      resolveEngineSpawnCommand(
        "C:\\Program Files\\Codex\\codex.cmd",
        ["app-server"],
        {
          platform: "win32",
          comspec: "C:\\Windows\\System32\\cmd.exe"
        }
      )
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "\"C:\\Program Files\\Codex\\codex.cmd\" app-server"
      ]
    });
  });
});

import type { EngineProgramResolutionRpc } from "@another-workbench/shared";

export type EngineProgramCommand = EngineProgramResolutionRpc & {
  args: string[];
};

type ResolveEngineProgramCommandOptions = {
  customPath?: string;
  configuredPath?: string;
  configuredArgs?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

type ProgramDefinition = {
  environmentVariables: string[];
  windowsDefault: string;
  default: string;
  defaultArgs: string[];
  explicitArgs: string[];
};

const programs: Record<string, ProgramDefinition> = {
  codex: {
    environmentVariables: ["AWB_CODEX_BIN", "CODEX_BIN", "CODEX_PATH"],
    windowsDefault: "codex.exe",
    default: "codex",
    defaultArgs: ["app-server"],
    explicitArgs: ["app-server"]
  },
  "pi-acp": {
    environmentVariables: ["AWB_PI_ACP_BIN", "PI_ACP_BIN"],
    windowsDefault: "npx.cmd",
    default: "npx",
    defaultArgs: ["-y", "pi-acp"],
    explicitArgs: []
  }
};

export const resolveEngineProgramCommand = (
  engineId: string,
  options: ResolveEngineProgramCommandOptions = {}
): EngineProgramCommand => {
  const program = programs[engineId];
  const customPath = options.customPath?.trim();
  if (customPath) {
    return {
      path: customPath,
      source: "custom",
      args: options.configuredArgs ?? program?.explicitArgs ?? []
    };
  }
  const configuredPath = options.configuredPath?.trim();
  if (configuredPath) {
    return {
      path: configuredPath,
      source: "configured",
      args: options.configuredArgs ?? program?.defaultArgs ?? []
    };
  }
  const env = options.env ?? process.env;
  const environmentVariable = program?.environmentVariables.find(
    (name) => env[name]?.trim()
  );
  if (environmentVariable) {
    return {
      path: env[environmentVariable]!.trim(),
      source: "environment",
      environmentVariable,
      args: options.configuredArgs ?? program?.explicitArgs ?? []
    };
  }
  const platform = options.platform ?? process.platform;
  return {
    path:
      platform === "win32"
        ? program?.windowsDefault ?? engineId
        : program?.default ?? engineId,
    source: "default",
    args: options.configuredArgs ?? program?.defaultArgs ?? []
  };
};

export const resolveEngineSpawnCommand = (
  commandPath: string,
  commandArgs: string[],
  options: {
    platform?: NodeJS.Platform;
    comspec?: string;
  } = {}
) => {
  if (
    (options.platform ?? process.platform) !== "win32" ||
    !/\.(cmd|bat)$/iu.test(commandPath)
  ) {
    return {
      command: commandPath,
      args: commandArgs
    };
  }

  return {
    command: options.comspec?.trim() || process.env.ComSpec?.trim() || "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      [commandPath, ...commandArgs].map(quoteForWindowsShell).join(" ")
    ]
  };
};

const quoteForWindowsShell = (value: string): string =>
  /[\s"]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;

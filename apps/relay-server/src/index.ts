import { pathToFileURL } from "node:url";
import { RelayServer } from "./server.js";

export const RELAY_SERVER_APP_NAME = "@another-workbench/relay-server";

export * from "./contracts.js";
export * from "./host-registry.js";
export * from "./server.js";

const isMainModule = (): boolean => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
};

const readArg = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
};

const resolvePort = (): number => {
  const value = readArg("--port") ?? process.env.RELAY_SERVER_PORT ?? "4417";
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid relay server port: ${value}`);
  }
  return parsed;
};

const resolveHost = (): string =>
  readArg("--host") ?? process.env.RELAY_SERVER_HOST ?? "127.0.0.1";

const startFromCli = async (): Promise<void> => {
  const server = new RelayServer({
    host: resolveHost(),
    port: resolvePort()
  });
  const listening = await server.listen();
  const baseUrl = `http://${listening.host}:${listening.port}`;

  console.log(`[relay-server] listening on ${baseUrl}`);

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
};

if (isMainModule()) {
  void startFromCli();
}

type CommandName = "bootstrap" | "pair" | "session-list";

type ParsedArgs = {
  command: CommandName;
  baseUrl: string;
  surface: "desktop-full" | "mobile-companion";
  code?: string;
  hostId?: string;
  sessionToken?: string;
};

const parseArgs = (): ParsedArgs => {
  const [, , rawCommand, ...rest] = process.argv;
  const command = (rawCommand ?? "bootstrap") as CommandName;
  if (!["bootstrap", "pair", "session-list"].includes(command)) {
    throw new Error(
      "Usage: pnpm remote:cli -- <bootstrap|pair|session-list> [--base-url=http://127.0.0.1:4317] [--surface=desktop-full] [--host-id=host-1] [--code=PAIR99] [--session-token=...]"
    );
  }

  const args = new Map<string, string>();
  for (const entry of rest) {
    const [key, value] = entry.split("=", 2);
    if (!key.startsWith("--") || !value) {
      continue;
    }
    args.set(key.slice(2), value);
  }

  return {
    command,
    baseUrl:
      args.get("base-url") ??
      process.env.AWB_REMOTE_BASE_URL ??
      "http://127.0.0.1:4317",
    surface:
      args.get("surface") === "mobile-companion"
        ? "mobile-companion"
        : "desktop-full",
    code: args.get("code"),
    hostId: args.get("host-id"),
    sessionToken: args.get("session-token")
  };
};

const withHostQuery = (url: URL, hostId: string | undefined): URL => {
  if (hostId) {
    url.searchParams.set("hostId", hostId);
  }
  return url;
};

const withHostHeaders = (
  headers: Record<string, string>,
  hostId: string | undefined
): Record<string, string> =>
  hostId
    ? {
        ...headers,
        "x-workbench-host-id": hostId
      }
    : headers;

const requestJson = async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<unknown> => {
  const response = await fetch(input, init);
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(JSON.stringify(payload, null, 2));
  }
  return payload;
};

const run = async (): Promise<void> => {
  const args = parseArgs();
  const baseUrl = new URL(args.baseUrl);

  switch (args.command) {
    case "bootstrap": {
      const payload = await requestJson(
        withHostQuery(
          new URL(`/bootstrap?clientSurface=${args.surface}`, baseUrl),
          args.hostId
        )
      );
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    case "pair": {
      const codePayload = args.code
        ? { code: args.code, clientSurface: args.surface }
        : await requestJson(withHostQuery(new URL("/pairing/code", baseUrl), args.hostId), {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              clientSurface: args.surface
            })
          });

      const code =
        typeof codePayload === "object" &&
        codePayload &&
        "pairing" in codePayload &&
        typeof (codePayload as { pairing?: { code?: unknown } }).pairing?.code ===
          "string"
          ? (codePayload as { pairing: { code: string } }).pairing.code
          : args.code;
      if (!code) {
        throw new Error("Failed to resolve pairing code.");
      }

      const sessionPayload = await requestJson(
        withHostQuery(new URL("/pairing/exchange", baseUrl), args.hostId),
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            code,
            clientSurface: args.surface
          })
        }
      );

      console.log(
        JSON.stringify(
          {
            pairing: codePayload,
            session: sessionPayload
          },
          null,
          2
        )
      );
      return;
    }
    case "session-list": {
      if (!args.sessionToken) {
        throw new Error("--session-token is required for session-list");
      }
      const payload = await requestJson(new URL("/rpc", baseUrl), {
        method: "POST",
        headers: withHostHeaders({
          authorization: `Bearer ${args.sessionToken}`,
          "content-type": "application/json"
        }, args.hostId),
        body: JSON.stringify({
          id: "cli-session-list",
          method: "session.list",
          params: {}
        })
      });
      console.log(JSON.stringify(payload, null, 2));
    }
  }
};

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

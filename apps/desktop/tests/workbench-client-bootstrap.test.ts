import { describe, expect, it, vi } from "vitest";
import type { WorkbenchClientApi } from "@another-workbench/shared";
import { resolveWorkbenchClientApi } from "../src/transport/workbench-client-bootstrap.js";

const createApiStub = (): WorkbenchClientApi => ({
  request: vi.fn(async () => {
    throw new Error("not implemented");
  }),
  subscribe: vi.fn(async () => ({
    subscriptionId: "sub-test",
    unsubscribe: async () => {}
  }))
});

describe("workbench client bootstrap", () => {
  it("prefers the local preload api when no remote mode is requested", () => {
    const localApi = createApiStub();

    const selection = resolveWorkbenchClientApi({
      window: {
        workbench: localApi,
        location: {
          search: ""
        }
      }
    });

    expect(selection.mode).toBe("local");
    expect(selection.api).toBe(localApi);
    expect(selection.label).toBe("local");
  });

  it("creates a remote client when remote mode is requested through env", () => {
    const remoteApi = createApiStub();
    const createRemoteClientApi = vi.fn(() => remoteApi);

    const selection = resolveWorkbenchClientApi(
      {
        env: {
          VITE_WORKBENCH_MODE: "remote",
          VITE_WORKBENCH_REMOTE_URL: "https://remote.example.test/awb",
          VITE_WORKBENCH_REMOTE_RPC_PATH: "rpc/v2",
          VITE_WORKBENCH_REMOTE_EVENTS_PATH: "events/live"
        },
        window: {
          workbench: createApiStub(),
          location: {
            search: ""
          }
        }
      },
      {
        createRemoteClientApi
      }
    );

    expect(selection.mode).toBe("remote");
    expect(selection.api).toBe(remoteApi);
    expect(selection.label).toBe("https://remote.example.test/awb");
    expect(createRemoteClientApi).toHaveBeenCalledWith({
      baseUrl: "https://remote.example.test/awb",
      rpcPath: "rpc/v2",
      eventsPath: "events/live",
      headers: undefined,
      websocketProtocols: undefined
    });
  });

  it("falls back to window remote bootstrap when local preload is absent", () => {
    const remoteApi = createApiStub();
    const createRemoteClientApi = vi.fn(() => remoteApi);

    const selection = resolveWorkbenchClientApi(
      {
        window: {
          location: {
            search: ""
          },
          workbenchRemoteBootstrap: {
            baseUrl: "http://127.0.0.1:8412",
            headers: {
              "x-awb-auth": "test"
            }
          }
        }
      },
      {
        createRemoteClientApi
      }
    );

    expect(selection.mode).toBe("remote");
    expect(selection.api).toBe(remoteApi);
    expect(createRemoteClientApi).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:8412",
      rpcPath: "rpc",
      eventsPath: "events",
      headers: {
        "x-awb-auth": "test"
      },
      websocketProtocols: undefined
    });
  });

  it("throws a clear error when remote mode is requested without a bootstrap url", () => {
    expect(() =>
      resolveWorkbenchClientApi({
        env: {
          VITE_WORKBENCH_MODE: "remote"
        },
        window: {
          location: {
            search: ""
          }
        }
      })
    ).toThrowError(/no remote bootstrap url/i);
  });
});

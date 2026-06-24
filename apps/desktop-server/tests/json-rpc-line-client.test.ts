import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JsonRpcLineClient,
  type JsonRpcLineRequestPayload
} from "../src/runtime/json-rpc-line-client.js";

class BackpressureOutput extends EventEmitter {
  public readonly chunks: string[] = [];
  public destroyed = false;
  public writableEnded = false;

  public write(chunk: string, _callback?: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk);
    return false;
  }
}

class FailingOutput extends EventEmitter {
  public destroyed = false;
  public writableEnded = false;

  public write(_chunk: string, callback?: (error?: Error | null) => void): boolean {
    callback?.(new Error("write exploded"));
    return true;
  }
}

const createClient = (options: {
  ids?: Array<string | number>;
  timeoutMs?: number;
  output?: Writable;
} = {}) => {
  const input = new PassThrough();
  const output = options.output ?? new PassThrough();
  const ids = [...(options.ids ?? ["1", "2", "3"])];
  const client = new JsonRpcLineClient({
    input,
    output,
    defaultTimeoutMs: options.timeoutMs ?? 1000,
    createRequestId: () => {
      const id = ids.shift();
      if (id === undefined) {
        throw new Error("missing test request id");
      }
      return id;
    }
  });
  return {
    client,
    input,
    output
  };
};

describe("JsonRpcLineClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves responses and removes pending requests", async () => {
    const { client, input } = createClient();

    const request = client.request("ping", {
      value: 1
    });
    expect(client.getPendingCount()).toBe(1);

    input.write(JSON.stringify({ id: "1", result: { ok: true } }) + "\n");

    await expect(request).resolves.toEqual({ ok: true });
    expect(client.getPendingCount()).toBe(0);
  });

  it("rejects JSON-RPC error responses and removes pending requests", async () => {
    const { client, input } = createClient();

    const request = client.request("ping");
    input.write(
      JSON.stringify({
        id: "1",
        error: {
          code: "boom",
          message: "provider failed",
          data: {
            retry: false
          }
        }
      }) + "\n"
    );

    await expect(request).rejects.toMatchObject({
      code: "runtime_protocol_error",
      details: {
        requestId: "1",
        method: "ping",
        jsonRpcCode: "boom",
        data: {
          retry: false
        }
      }
    });
    expect(client.getPendingCount()).toBe(0);
  });

  it("times out pending requests", async () => {
    vi.useFakeTimers();
    const { client } = createClient({
      timeoutMs: 10
    });

    const request = client.request("hang");
    const rejectedRequest = expect(request).rejects.toMatchObject({
      code: "runtime_request_timeout",
      details: {
        requestId: "1",
        method: "hang",
        timeoutMs: 10
      }
    });

    await vi.advanceTimersByTimeAsync(10);
    await rejectedRequest;
    expect(client.getPendingCount()).toBe(0);
  });

  it("aborts pending requests", async () => {
    const { client } = createClient();
    const controller = new AbortController();

    const request = client.request("abortable", undefined, {
      signal: controller.signal
    });
    controller.abort();

    await expect(request).rejects.toMatchObject({
      code: "runtime_request_aborted"
    });
    expect(client.getPendingCount()).toBe(0);
  });

  it("rejects all pending requests on demand", async () => {
    const { client } = createClient();

    const first = client.request("first");
    const second = client.request("second");
    client.rejectAll(new Error("runtime exited"));

    await expect(first).rejects.toThrow("runtime exited");
    await expect(second).rejects.toThrow("runtime exited");
    expect(client.getPendingCount()).toBe(0);
  });

  it("rejects and removes pending requests when writing fails", async () => {
    const { client } = createClient({
      output: new FailingOutput() as unknown as Writable
    });

    await expect(client.request("write-fails")).rejects.toMatchObject({
      code: "runtime_write_failed",
      details: {
        requestId: "1",
        method: "write-fails"
      }
    });
    expect(client.getPendingCount()).toBe(0);
  });

  it("rejects request id collisions without writing a second request", async () => {
    const output = new BackpressureOutput();
    const { client } = createClient({
      ids: ["same", "same"],
      output: output as unknown as Writable
    });

    const first = client.request("first");
    await expect(client.request("second")).rejects.toMatchObject({
      code: "runtime_protocol_error",
      details: {
        requestId: "same",
        method: "second"
      }
    });

    expect(output.chunks).toHaveLength(1);
    client.rejectAll(new Error("cleanup"));
    await expect(first).rejects.toThrow("cleanup");
  });

  it("keeps pending requests valid through stdin backpressure", async () => {
    const output = new BackpressureOutput();
    const { client, input } = createClient({
      output: output as unknown as Writable
    });

    const request = client.request("backpressure");
    expect(output.chunks).toHaveLength(1);
    expect(client.getPendingCount()).toBe(1);

    input.write(JSON.stringify({ id: "1", result: "ok" }) + "\n");
    await expect(request).resolves.toBe("ok");
    expect(client.getPendingCount()).toBe(0);

    output.emit("drain");
  });

  it("dispatches server requests, notifications, and parse errors", async () => {
    const { client, input } = createClient();
    const requests: JsonRpcLineRequestPayload[] = [];
    const notifications: string[] = [];
    const errors: string[] = [];
    client.onRequest((payload) => requests.push(payload));
    client.onNotification((payload) => notifications.push(payload.method));
    client.onProtocolError((error) => errors.push(error.message));

    input.write(
      JSON.stringify({ id: 7, method: "server/request", params: { a: 1 } }) +
        "\n"
    );
    input.write(JSON.stringify({ method: "server/notification" }) + "\n");
    input.write("{not json}\n");

    expect(requests).toEqual([
      expect.objectContaining({
        id: 7,
        method: "server/request",
        params: {
          a: 1
        }
      })
    ]);
    expect(notifications).toEqual(["server/notification"]);
    expect(errors).toHaveLength(1);
  });
});

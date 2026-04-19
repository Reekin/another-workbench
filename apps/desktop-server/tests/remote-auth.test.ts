import { describe, expect, it } from "vitest";
import {
  getRemoteAuthErrorBody,
  isRemoteRequestAuthorized
} from "../src/remote-auth.js";

describe("remote auth", () => {
  it("accepts bearer header tokens and websocket query tokens", () => {
    const config = {
      token: "secret-token"
    };

    expect(
      isRemoteRequestAuthorized(
        {
          headers: {
            authorization: "Bearer secret-token"
          }
        },
        config
      )
    ).toBe(true);

    expect(
      isRemoteRequestAuthorized(
        {
          headers: {},
          url: "/events?token=secret-token"
        },
        config
      )
    ).toBe(true);

    expect(
      isRemoteRequestAuthorized(
        {
          headers: {
            authorization: "Bearer wrong-token"
          },
          url: "/events?token=wrong-token"
        },
        config
      )
    ).toBe(false);
  });

  it("returns a stable shared error body", () => {
    expect(getRemoteAuthErrorBody()).toEqual({
      ok: false,
      error: {
        code: "REMOTE_UNAUTHORIZED",
        message: "Missing or invalid remote auth token"
      }
    });
  });
});

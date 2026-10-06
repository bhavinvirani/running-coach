import { ErrorCode } from "@running-coach/shared";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { ScreenLoadError } from "@/app/lazy-screen";
import {
  errorCodeMessage,
  errorMessage,
  errorMessages,
  logInErrorMessage,
  isVersionMismatch,
  networkErrorMessage,
  unknownErrorMessage,
  unreadWriteMessage,
  versionMismatchMessage,
} from "./errors";

describe("errorMessage", () => {
  it.each(Object.values(ErrorCode))("has a message for %s", (code) => {
    const message = errorMessages[code];
    expect(message, `add a message for "${code}" in src/lib/errors.ts`).toBeTypeOf("string");
    expect(message.length).toBeGreaterThan(10);
    expect(errorMessage(new ApiError({ status: 500, code }))).toBe(message);
  });

  it("has no message for a code that does not exist", () => {
    expect(Object.keys(errorMessages).sort()).toEqual(Object.values(ErrorCode).sort());
  });

  it("says this version does not match the server for an answer it cannot read and a screen whose code is gone", () => {
    const read = new ApiError({ status: 200, code: ErrorCode.internal, contractMismatch: "read" });
    expect(errorMessage(read)).toBe(versionMismatchMessage);
    expect(errorMessage(new ScreenLoadError("gone"))).toBe(versionMismatchMessage);
    expect(isVersionMismatch(read)).toBe(true);
    expect(isVersionMismatch(new ScreenLoadError("gone"))).toBe(true);
    expect(isVersionMismatch(new ApiError({ status: 500, code: ErrorCode.internal }))).toBe(false);
  });

  it("says a write it could not read may have gone through, so the runner checks before repeating it", () => {
    const write = new ApiError({
      status: 200,
      code: ErrorCode.internal,
      contractMismatch: "write",
    });
    expect(errorMessage(write)).toBe(unreadWriteMessage);
  });

  it("asks to check the connection when a screen's code did not load offline, also once back online", () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const offline = new ScreenLoadError("offline");
    expect(errorMessage(offline)).toBe(networkErrorMessage);
    onLine.mockReturnValue(true);
    expect(errorMessage(offline)).toBe(networkErrorMessage);
  });

  it("tells the user to reconnect when the Garmin login expired", () => {
    const error = new ApiError({ status: 401, code: ErrorCode.garminAuthExpired });
    expect(errorMessage(error)).toBe("Garmin login expired. Reconnect in Settings.");
  });

  it("tells the runner to use an API key when the Claude plan is not offered (409 claude_plan_unavailable)", () => {
    const error = new ApiError({ status: 409, code: ErrorCode.claudePlanUnavailable });
    expect(errorMessage(error)).toBe(
      "The Claude plan is not set up for this account. Use an API key instead.",
    );
  });

  it("says the coach waits for the reset when the Claude plan's usage limit is reached (claude_plan_limited)", () => {
    const error = new ApiError({ status: 429, code: ErrorCode.claudePlanLimited });
    expect(errorMessage(error)).toBe(
      "Your Claude plan has reached its usage limit. The coach tries again when the limit resets.",
    );
  });

  it("explains a network failure separately from a server error", () => {
    const error = new ApiError({ status: 0, code: ErrorCode.internal, network: true });
    expect(errorMessage(error)).toBe(networkErrorMessage);
  });

  it("falls back for anything that is not an ApiError", () => {
    expect(errorMessage(new Error("boom"))).toBe(unknownErrorMessage);
    expect(errorMessage("boom")).toBe(unknownErrorMessage);
    expect(errorMessage(undefined)).toBe(unknownErrorMessage);
  });
});

describe("errorCodeMessage", () => {
  it("uses the shared message for a stored error code", () => {
    expect(errorCodeMessage(ErrorCode.garminAuthExpired)).toBe(
      "Garmin login expired. Reconnect in Settings.",
    );
    expect(errorCodeMessage(ErrorCode.garminUnavailable)).toBe(errorMessages.garmin_unavailable);
  });

  it("falls back when no code was stored", () => {
    expect(errorCodeMessage(null)).toBe(unknownErrorMessage);
    expect(errorCodeMessage(undefined)).toBe(unknownErrorMessage);
  });
});

describe("logInErrorMessage", () => {
  it("says the credentials are wrong on a 401", () => {
    const error = new ApiError({ status: 401, code: ErrorCode.unauthorized });
    expect(logInErrorMessage(error)).toBe("Email or password is wrong. Check both and try again.");
  });

  it("uses the shared message for anything else", () => {
    const error = new ApiError({ status: 429, code: ErrorCode.rateLimited });
    expect(logInErrorMessage(error)).toBe(errorMessages.rate_limited);
  });
});

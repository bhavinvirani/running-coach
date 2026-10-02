import { ErrorCode } from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import {
  errorCodeMessage,
  errorMessage,
  errorMessages,
  logInErrorMessage,
  networkErrorMessage,
  unknownErrorMessage,
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

  it("tells the user to reconnect when the Garmin login expired", () => {
    const error = new ApiError({ status: 401, code: ErrorCode.garminAuthExpired });
    expect(errorMessage(error)).toBe("Garmin login expired. Reconnect in Settings.");
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

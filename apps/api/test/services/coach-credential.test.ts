import { afterEach, describe, expect, it } from "vitest";
import { encrypt } from "../../src/lib/crypto";
import { callCredential } from "../../src/services/coach-credential";
import { configureCoachService, FAKE_COACH_SECRET, PLAN_OWNER_EMAIL } from "../fake-coach-service";

// callCredential, what one coach call runs on. The coach service is only configured here, never called:
// the credential depends on whether the plan is offered, not on whether the service answers.

/** A coach service URL nothing is asked of in these tests. */
const COACH_SERVICE = { url: "http://127.0.0.1:9", secret: FAKE_COACH_SECRET };
const USER_ID = "0b6f3c1e-2d4a-4c8e-9f10-1a2b3c4d5e6f";
const KEY = "sk-ant-fake-test-key";

let restore: () => void = () => undefined;

afterEach(() => {
  restore();
  restore = () => undefined;
});

describe("callCredential", () => {
  it("returns the plan, without decrypting the saved key, for the owner who chose it while the coach service is set up", () => {
    restore = configureCoachService(COACH_SERVICE);

    expect(
      callCredential(USER_ID, {
        email: PLAN_OWNER_EMAIL,
        coachCredential: "plan",
        claudeKeyEnc: encrypt(KEY, USER_ID),
      }),
    ).toEqual({ kind: "plan" });
  });

  it("returns the saved key decrypted for this call for a user on their key", () => {
    expect(
      callCredential(USER_ID, {
        email: "other@example.com",
        coachCredential: "key",
        claudeKeyEnc: encrypt(KEY, USER_ID),
      }),
    ).toEqual({ kind: "key", apiKey: KEY });
  });

  it("falls back to the saved key when the plan is chosen but not offered to this email", () => {
    restore = configureCoachService(COACH_SERVICE);

    expect(
      callCredential(USER_ID, {
        email: "other@example.com",
        coachCredential: "plan",
        claudeKeyEnc: encrypt(KEY, USER_ID),
      }),
    ).toEqual({ kind: "key", apiKey: KEY });
  });

  it("returns null with neither a saved key nor the plan, also when the owner chose the plan but the coach service is not set up", () => {
    expect(
      callCredential(USER_ID, {
        email: "other@example.com",
        coachCredential: "key",
        claudeKeyEnc: null,
      }),
    ).toBeNull();
    expect(
      callCredential(USER_ID, {
        email: PLAN_OWNER_EMAIL,
        coachCredential: "plan",
        claudeKeyEnc: null,
      }),
    ).toBeNull();
  });
});

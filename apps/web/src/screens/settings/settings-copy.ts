import type { GarminStatus, Settings } from "@running-coach/shared";

/** The Garmin row's value: the connection's state in words. */
export const garminStatusNames: Record<GarminStatus, string> = {
  ok: "Connected",
  expired: "Login expired",
  not_connected: "Not connected",
};

/** The Claude row's value: what the coach runs on, or that it has nothing to run on. */
export function claudeValue(settings: Settings): string {
  if (settings.coachCredential === "plan") return "Claude plan";
  return settings.hasClaudeKey ? "Key saved" : "No key";
}

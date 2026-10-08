import type { GarminStatus, Settings, ShoesResponse } from "@running-coach/shared";
import { shoeName } from "@/lib/shoe-names";

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

/**
 * The Shoes row's value: the pair the sync puts on new runs, None without one, and nothing until the pairs
 * load (or when they fail to: the Shoes screen says why).
 */
export function shoesValue(shoes: ShoesResponse | undefined): string | undefined {
  if (shoes === undefined) return undefined;
  const active = shoes.shoes.find((shoe) => shoe.active);
  return active === undefined ? "None" : shoeName(active);
}

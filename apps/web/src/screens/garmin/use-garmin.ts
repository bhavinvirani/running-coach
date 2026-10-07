import { useMe } from "@/api/me";
import { screenState } from "@/api/screen-state";

/** Everything the Garmin screen reads: the connection and last sync, and the time zone to show it in. */
export function useGarminScreen() {
  return screenState(useMe());
}

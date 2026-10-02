import type { UpdateSettingsRequest } from "@running-coach/shared";
import { useNavigate } from "react-router";
import { useMe, useUpdateSettings } from "@/api/me";
import { screenState } from "@/api/screen-state";
import { useLogOut } from "@/api/session";

/**
 * Everything the Settings screen reads and does. Named useSettingsScreen so it never clashes with
 * useSettings() in src/api/me.ts, which other screens use to convert units.
 */
export function useSettingsScreen() {
  const me = useMe();
  const update = useUpdateSettings();
  const logOut = useLogOut();
  const navigate = useNavigate();

  return {
    ...screenState(me),
    /** The change in flight, shown at once so a tap never looks ignored. */
    pendingChanges: update.isPending ? update.variables : undefined,
    updateError: update.error,
    updateSettings: (changes: UpdateSettingsRequest) => update.mutate(changes),
    loggingOut: logOut.isPending,
    logOutError: logOut.error,
    logOut: () =>
      logOut.mutate(undefined, {
        onSuccess: () => void navigate("/login", { replace: true }),
      }),
  };
}

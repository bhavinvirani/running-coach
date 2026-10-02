import type { MeResponse, UpdateSettingsRequest } from "@running-coach/shared";
import type { UseQueryResult } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { useMe, useUpdateSettings } from "@/api/me";
import { useLogOut } from "@/api/session";

/** The query reduced to what a screen renders from, kept as a union so `status` narrows `data`. */
function screenState(me: UseQueryResult<MeResponse>) {
  switch (me.status) {
    case "pending":
      return { status: me.status, data: undefined, error: null, refetch: me.refetch } as const;
    case "error":
      return { status: me.status, data: me.data, error: me.error, refetch: me.refetch } as const;
    case "success":
      return { status: me.status, data: me.data, error: null, refetch: me.refetch } as const;
  }
}

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

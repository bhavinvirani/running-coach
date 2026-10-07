import { useNavigate } from "react-router";
import { useMe } from "@/api/me";
import { screenState } from "@/api/screen-state";
import { useLogOut } from "@/api/session";

/**
 * Everything the Settings screen reads and does. Named useSettingsScreen so it never clashes with
 * useSettings() in src/api/me.ts, which other screens use to convert units.
 */
export function useSettingsScreen() {
  const me = useMe();
  const logOut = useLogOut();
  const navigate = useNavigate();

  return {
    ...screenState(me),
    loggingOut: logOut.isPending,
    logOutError: logOut.error,
    logOut: () =>
      logOut.mutate(undefined, {
        onSuccess: () => void navigate("/login", { replace: true }),
      }),
  };
}

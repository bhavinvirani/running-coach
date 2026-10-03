import type { UpdateSettingsRequest } from "@running-coach/shared";
import { useNavigate } from "react-router";
import { useMe, useRemoveClaudeKey, useSaveClaudeKey, useUpdateSettings } from "@/api/me";
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
  const saveKey = useSaveClaudeKey();
  const removeKey = useRemoveClaudeKey();
  const navigate = useNavigate();

  return {
    ...screenState(me),
    /** The change in flight, shown at once so a tap never looks ignored. */
    pendingChanges: update.isPending ? update.variables : undefined,
    updateError: update.error,
    updateSettings: (changes: UpdateSettingsRequest) => update.mutate(changes),
    claudeKey: {
      saving: saveKey.isPending,
      saveError: saveKey.error,
      /** `onSaved` runs once the key is stored, so the section can let go of what was typed. */
      save: (key: string, onSaved: () => void) => {
        removeKey.reset();
        saveKey.mutate(key, { onSuccess: onSaved });
      },
      /** Cancel on Replace key: the last attempt's error belongs to the input that is closing. */
      clearSaveError: () => saveKey.reset(),
      removing: removeKey.isPending,
      removeError: removeKey.error,
      /** `onRemoved` runs once the key is gone, so the section can move focus to the empty field. */
      remove: (onRemoved: () => void) => {
        saveKey.reset();
        removeKey.mutate(undefined, { onSuccess: onRemoved });
      },
    },
    loggingOut: logOut.isPending,
    logOutError: logOut.error,
    logOut: () =>
      logOut.mutate(undefined, {
        onSuccess: () => void navigate("/login", { replace: true }),
      }),
  };
}

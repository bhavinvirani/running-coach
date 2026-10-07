import type { CoachCredentialChoice } from "@running-coach/shared";
import { useMe, useRemoveClaudeKey, useSaveClaudeKey, useUpdateSettings } from "@/api/me";
import { screenState } from "@/api/screen-state";

/** Everything the Claude screen reads and does: what the coach runs on, and the runner's key. */
export function useClaudeScreen() {
  const me = useMe();
  const chooseCredential = useUpdateSettings();
  const saveKey = useSaveClaudeKey();
  const removeKey = useRemoveClaudeKey();

  return {
    ...screenState(me),
    coachCredential: {
      /** The choice in flight, shown at once so a tap never looks ignored. */
      pending: chooseCredential.isPending ? chooseCredential.variables.coachCredential : undefined,
      error: chooseCredential.error,
      choose: (choice: CoachCredentialChoice) => {
        // The key form closes or opens with the choice: an error from its last try no longer applies.
        saveKey.reset();
        removeKey.reset();
        chooseCredential.mutate({ coachCredential: choice });
      },
    },
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
  };
}

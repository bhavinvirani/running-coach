import type { CoachCredentialChoice } from "@running-coach/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { CoachCredentialField } from "./coach-credential-field";
import { SettingsCard, SettingsRow } from "@/components/settings-card";

const HELPER =
  "The coach uses your own Claude API key, about $1 a month, paid to Anthropic. It is stored encrypted.";

const PLAN_LINE =
  "The coach runs on your Claude plan, through the coach service. Each review counts toward your plan's usage limits.";

/** The Claude plan, offered to the owner alone once the server runs the coach service. */
type CredentialChoice = {
  choice: CoachCredentialChoice;
  error: unknown;
  choose: (choice: CoachCredentialChoice) => void;
};

type ClaudeKeyProps = {
  hasKey: boolean;
  saving: boolean;
  saveError: unknown;
  save: (key: string, onSaved: () => void) => void;
  clearSaveError: () => void;
  removing: boolean;
  removeError: unknown;
  remove: (onRemoved: () => void) => void;
};

type ClaudeKeySectionProps = ClaudeKeyProps & {
  /** Undefined unless the plan is offered: the card is then the key alone, as for every other runner. */
  credential?: CredentialChoice;
};

/**
 * What the coach runs on. For everyone but the owner that is their own Claude API key; when the server
 * offers the owner's Claude plan, a choice comes first, and the plan replaces the key form with one line
 * while it is chosen (a saved key stays stored for when the choice goes back). The choice stays mounted
 * across the swap, so the focused radio keeps focus.
 */
export function ClaudeKeySection({ credential, ...key }: ClaudeKeySectionProps) {
  if (credential === undefined) {
    return (
      <SettingsCard title="Claude key">
        <ClaudeKey {...key} />
      </SettingsCard>
    );
  }

  return (
    <SettingsCard title="Claude">
      <div>
        <CoachCredentialField value={credential.choice} onChange={credential.choose} />
        {credential.error ? (
          <p role="alert" className="pb-4 text-body text-ink">
            {errorMessage(credential.error)}
          </p>
        ) : null}
      </div>
      {credential.choice === "plan" ? (
        <p className="py-4 text-body text-ink-2">{PLAN_LINE}</p>
      ) : (
        <ClaudeKey {...key} />
      )}
    </SettingsCard>
  );
}

/**
 * The runner's own Claude API key. The key is never shown again once saved: the API keeps it encrypted
 * and answers only whether one is set. A rejected key is not stored, and the field keeps what was typed so
 * a stray space or a half-copied key can be fixed in place. Swapping the field for the saved row takes away
 * the focused control, so focus follows: to the field on Replace key or once the key is removed, back to
 * Replace key on Cancel or once a key is saved.
 */
function ClaudeKey({
  hasKey,
  saving,
  saveError,
  save,
  clearSaveError,
  removing,
  removeError,
  remove,
}: ClaudeKeyProps) {
  const [replacing, setReplacing] = useState(false);
  const [draft, setDraft] = useState("");
  const keyField = useRef<HTMLInputElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  // Set with the swap, so only a render the runner caused moves focus, never a refetch. Kept until the
  // target is on screen: a saved or removed key can swap the view a render after the callback that set it.
  const focusAfterSwap = useRef<"field" | "replace" | null>(null);

  useEffect(() => {
    const wanted = focusAfterSwap.current;
    const target =
      wanted === "field" ? keyField.current : wanted === "replace" ? replaceButton.current : null;
    if (target === null) return;
    focusAfterSwap.current = null;
    target.focus();
  });

  const close = () => {
    focusAfterSwap.current = "replace";
    setDraft("");
    setReplacing(false);
  };

  if (hasKey && !replacing) {
    return (
      <>
        <SettingsRow label="Status">Saved</SettingsRow>
        <div className="flex flex-col items-start gap-3 py-4">
          {removeError ? (
            <p role="alert" className="text-body text-ink">
              {errorMessage(removeError)}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button
              ref={replaceButton}
              variant="secondary"
              onClick={() => {
                focusAfterSwap.current = "field";
                setReplacing(true);
              }}
            >
              Replace key
            </Button>
            <Button
              variant="ghost"
              disabled={removing}
              aria-busy={removing}
              onClick={() =>
                remove(() => {
                  focusAfterSwap.current = "field";
                })
              }
            >
              Remove key
            </Button>
          </div>
        </div>
      </>
    );
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft.trim() === "" || saving) return;
    save(draft, close);
  };

  return (
    <form onSubmit={submit} className="flex flex-col pb-4">
      <TextField
        ref={keyField}
        label="Claude API key"
        type="password"
        autoComplete="off"
        // Password managers would offer the app's password here, or save the API key as one.
        data-1p-ignore
        data-lpignore="true"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        value={draft}
        // Held while Claude checks it, so the key on screen is the key being checked.
        readOnly={saving}
        onChange={(event) => setDraft(event.target.value)}
        description={hasKey ? undefined : HELPER}
      />
      <div className="flex flex-col items-start gap-3">
        {saveError ? (
          <p role="alert" className="text-body text-ink">
            {errorMessage(saveError)}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={draft.trim() === "" || saving} aria-busy={saving}>
            {saving ? "Saving key…" : "Save key"}
          </Button>
          {hasKey ? (
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => {
                clearSaveError();
                close();
              }}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </div>
    </form>
  );
}

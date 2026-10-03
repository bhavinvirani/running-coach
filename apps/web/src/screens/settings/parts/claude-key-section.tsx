import { useEffect, useRef, useState, type FormEvent } from "react";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { Row, Section } from "./section";

const HELPER =
  "The coach uses your own Claude API key, about $1 a month, paid to Anthropic. It is stored encrypted.";

type ClaudeKeySectionProps = {
  hasKey: boolean;
  saving: boolean;
  saveError: unknown;
  save: (key: string, onSaved: () => void) => void;
  clearSaveError: () => void;
  removing: boolean;
  removeError: unknown;
  remove: (onRemoved: () => void) => void;
};

/**
 * The runner's own Claude API key, which the coach runs on. The key is never shown again once saved: the
 * API keeps it encrypted and answers only whether one is set. A rejected key is not stored, and the field
 * keeps what was typed so a stray space or a half-copied key can be fixed in place. Swapping the field for
 * the saved row takes away the focused control, so focus follows: to the field on Replace key or once the
 * key is removed, back to Replace key on Cancel or once a key is saved.
 */
export function ClaudeKeySection({
  hasKey,
  saving,
  saveError,
  save,
  clearSaveError,
  removing,
  removeError,
  remove,
}: ClaudeKeySectionProps) {
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
      <Section title="Claude key">
        <Row label="Status">Saved</Row>
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
      </Section>
    );
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft.trim() === "" || saving) return;
    save(draft, close);
  };

  return (
    <Section title="Claude key">
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
    </Section>
  );
}

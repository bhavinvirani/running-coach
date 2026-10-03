import { useState, type FormEvent } from "react";
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
  remove: () => void;
};

/**
 * The runner's own Claude API key, which the coach runs on. The key is never shown again once saved: the
 * API keeps it encrypted and answers only whether one is set. A rejected key is not stored, and the field
 * keeps what was typed so a stray space or a half-copied key can be fixed in place.
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

  const close = () => {
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
            <Button variant="secondary" onClick={() => setReplacing(true)}>
              Replace key
            </Button>
            <Button variant="ghost" disabled={removing} aria-busy={removing} onClick={remove}>
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
          label="Claude API key"
          type="password"
          autoComplete="off"
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
              {saving ? "Checking key…" : "Save key"}
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

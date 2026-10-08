import { SHOE_TEXT_MAX, type ShoeInput, type Units } from "@running-coach/shared";
import { useId, useState, type FormEvent } from "react";
import { CardSection } from "@/components/card-section";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { errorMessage } from "@/lib/errors";
import { retireHelp, shoeCopy, startDistanceHelp } from "../shoe-copy";
import { checkDraft, draftFromInput, type ShoeDraft } from "../shoe-draft";

type ShoeFormProps = {
  /** What the form starts from: a stored pair, or NEW_SHOE. */
  stored: ShoeInput;
  units: Units;
  /** A new pair only: whether Use for new runs starts checked. Edit has Make active instead. */
  startActive?: boolean;
  submit: { idle: string; pending: string };
  saving: boolean;
  saveError: unknown;
  /** `active` is the checkbox, undefined without one; `onSaved` runs once the pair is stored. */
  onSave: (input: ShoeInput, active: boolean | undefined, onSaved: () => void) => void;
};

/**
 * A pair's names and distances, typed in the runner's unit: the Pair card (brand, model, colour, nickname),
 * the Distance card (retire at, distance before this app), and for a new pair Use for new runs. The submit
 * checks the draft against the shared contract and says the first problem; a stored pair that comes back
 * with other values (saved, or read again) replaces what is typed.
 */
export function ShoeForm({
  stored,
  units,
  startActive,
  submit,
  saving,
  saveError,
  onSave,
}: ShoeFormProps) {
  const [shown, setShown] = useState({ stored, units });
  const [draft, setDraft] = useState(() => draftFromInput(stored, units));
  const [active, setActive] = useState(startActive);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const checkboxId = useId();

  if (!sameInput(stored, shown.stored) || units !== shown.units) {
    setShown({ stored, units });
    setDraft(draftFromInput(stored, units));
    setInvalid(null);
  }

  const edit = (changes: Partial<ShoeDraft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setInvalid(null);
    setSaved(false);
  };

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const checked = checkDraft(draft, stored, units);
    if (!checked.success) {
      setInvalid(checked.message);
      return;
    }
    setInvalid(null);
    onSave(checked.input, active, () => setSaved(true));
  };

  const alert = invalid ?? (saving || !saveError ? null : errorMessage(saveError));

  return (
    <form onSubmit={send} noValidate className="flex flex-col gap-4">
      <CardSection title={shoeCopy.pair}>
        <TextField
          label={shoeCopy.brand}
          name="brand"
          autoComplete="off"
          maxLength={SHOE_TEXT_MAX}
          value={draft.brand}
          onChange={(event) => edit({ brand: event.target.value })}
        />
        <TextField
          label={shoeCopy.model}
          name="model"
          autoComplete="off"
          maxLength={SHOE_TEXT_MAX}
          value={draft.model}
          onChange={(event) => edit({ model: event.target.value })}
        />
        <TextField
          label={shoeCopy.colour}
          name="colour"
          autoComplete="off"
          maxLength={SHOE_TEXT_MAX}
          description={shoeCopy.colourHelp}
          value={draft.colour}
          onChange={(event) => edit({ colour: event.target.value })}
        />
        <TextField
          label={shoeCopy.nickname}
          name="nickname"
          autoComplete="off"
          maxLength={SHOE_TEXT_MAX}
          description={shoeCopy.nicknameHelp}
          value={draft.nickname}
          onChange={(event) => edit({ nickname: event.target.value })}
        />
      </CardSection>
      <CardSection title={shoeCopy.distance}>
        <TextField
          label={shoeCopy.retireAt}
          name="retireAt"
          inputMode="decimal"
          autoComplete="off"
          className="w-28"
          description={retireHelp(units)}
          value={draft.retireAt}
          onChange={(event) => edit({ retireAt: event.target.value })}
        />
        <TextField
          label={shoeCopy.startDistance}
          name="startDistance"
          inputMode="decimal"
          autoComplete="off"
          className="w-28"
          description={startDistanceHelp(units)}
          value={draft.startDistance}
          onChange={(event) => edit({ startDistance: event.target.value })}
        />
      </CardSection>
      {active === undefined ? null : (
        <label htmlFor={checkboxId} className="flex min-h-11 cursor-pointer items-center gap-3">
          <Checkbox
            id={checkboxId}
            checked={active}
            onCheckedChange={(checked) => setActive(checked === true)}
          />
          <span className="text-body text-ink">{shoeCopy.useForNewRuns}</span>
        </label>
      )}
      {alert ? (
        <p role="alert" className="text-body text-ink">
          {alert}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-body text-ink-2">
          {shoeCopy.saved}
        </p>
      ) : null}
      <Button type="submit" className="self-start" disabled={saving} aria-busy={saving}>
        {saving ? submit.pending : submit.idle}
      </Button>
    </form>
  );
}

function sameInput(a: ShoeInput, b: ShoeInput): boolean {
  return (
    a.brand === b.brand &&
    a.model === b.model &&
    a.colour === b.colour &&
    a.nickname === b.nickname &&
    a.retireDistanceM === b.retireDistanceM &&
    a.startDistanceM === b.startDistanceM
  );
}

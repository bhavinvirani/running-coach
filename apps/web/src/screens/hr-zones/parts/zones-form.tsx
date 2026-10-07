import type { HrZones, HrZonesSource } from "@running-coach/shared";
import { useId, useRef, useState, type FormEvent } from "react";
import { CardSection } from "@/components/card-section";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { hrZonesCopy, sourceCaptions, zoneNames } from "../hr-zones-copy";
import {
  checkDraft,
  draftFromZones,
  withBpm,
  withMaxHr,
  withPercent,
  zoneRange,
  type ZonesDraft,
} from "../zones-draft";

// The only place outside the run's zones chart that the zone tokens appear (web-ui.md).
const ZONE_DOTS = ["bg-zone-1", "bg-zone-2", "bg-zone-3", "bg-zone-4", "bg-zone-5"] as const;

type ZonesFormProps = {
  source: HrZonesSource;
  /** Null before any run has a heart rate: max HR starts empty. */
  zones: HrZones | null;
  saving: boolean;
  saveError: unknown;
  save: (zones: HrZones, onSaved: () => void) => void;
  resetting: boolean;
  resetError: unknown;
  resetToGarmin: (onReset: () => void) => void;
};

/**
 * The zones in use, editable: max HR, then each zone's lower bound as a percent of max HR and in bpm,
 * either one moving the other, and the range it covers. Save checks the zones against the shared contract
 * before sending and says the first problem; new zones from the API (saved, reset, or read again with
 * other values) replace what is typed. Reset to Garmin's shows only while the zones are the runner's own.
 */
export function ZonesForm({
  source,
  zones,
  saving,
  saveError,
  save,
  resetting,
  resetError,
  resetToGarmin,
}: ZonesFormProps) {
  // The zones the draft was last taken from; undefined asks for the zones in use again (after a reset).
  const [shown, setShown] = useState<HrZones | null | undefined>(zones);
  const [draft, setDraft] = useState(() => draftFromZones(zones));
  const [invalid, setInvalid] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const caption = useRef<HTMLParagraphElement>(null);

  // The cache keeps the same object while the zones are equal, so only new values reset the form.
  if (zones !== shown) {
    setShown(zones);
    setDraft(draftFromZones(zones));
    setInvalid(null);
  }

  const edit = (next: ZonesDraft) => {
    setDraft(next);
    setInvalid(null);
    setSaved(false);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const checked = checkDraft(draft);
    if (!checked.success) {
      setInvalid(checked.message);
      return;
    }
    setInvalid(null);
    save(checked.zones, () => setSaved(true));
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {/* Focused after a reset: it names where the zones now come from. */}
      <p ref={caption} tabIndex={-1} className="text-caption text-ink-2">
        {sourceCaptions[source]}
      </p>
      <CardSection title={hrZonesCopy.zones}>
        <TextField
          label={hrZonesCopy.maxHr}
          description={hrZonesCopy.maxHrHelp}
          inputMode="numeric"
          autoComplete="off"
          className="w-24"
          value={draft.maxHr}
          onChange={(event) => edit(withMaxHr(draft, event.target.value))}
        />
        {zoneNames.map((name, index) => (
          <ZoneRow
            key={name}
            index={index}
            name={name}
            draft={draft}
            onPercent={(percent) => edit(withPercent(draft, index, percent))}
            onBpm={(bpm) => edit(withBpm(draft, index, bpm))}
          />
        ))}
      </CardSection>
      {invalid ? <Alert>{invalid}</Alert> : null}
      {saveError ? <Alert>{errorMessage(saveError)}</Alert> : null}
      {resetError ? <Alert>{errorMessage(resetError)}</Alert> : null}
      {saved ? (
        <p role="status" className="text-body text-ink-2">
          {hrZonesCopy.saved}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={saving} aria-busy={saving}>
          {saving ? hrZonesCopy.saving : hrZonesCopy.save}
        </Button>
        {source === "custom" ? (
          <Button
            variant="secondary"
            disabled={resetting}
            aria-busy={resetting}
            onClick={() => {
              setSaved(false);
              resetToGarmin(() => {
                // Garmin's zones replace what is typed, also when they equal the runner's.
                setShown(undefined);
                caption.current?.focus();
              });
            }}
          >
            {hrZonesCopy.reset}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function Alert({ children }: { children: string }) {
  return (
    <p role="alert" className="text-body text-ink">
      {children}
    </p>
  );
}

type ZoneRowProps = {
  index: number;
  name: string;
  draft: ZonesDraft;
  onPercent: (percent: string) => void;
  onBpm: (bpm: string) => void;
};

/** One zone: its dot, name and range on the left, its lower bound in percent and bpm on the right. */
function ZoneRow({ index, name, draft, onPercent, onBpm }: ZoneRowProps) {
  const zone = draft.zones[index];
  const number = index + 1;

  return (
    <div
      role="group"
      aria-label={`Zone ${number}, ${name}`}
      className="flex min-h-12 items-center justify-between gap-3 py-3"
    >
      <div className="flex min-w-0 items-start gap-2">
        {/* Centered on the name's 22 px line. */}
        <span
          aria-hidden="true"
          className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", ZONE_DOTS[index])}
        />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-body text-ink">{name}</span>
          <span className="text-caption text-ink-2">{zoneRange(draft, index)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <BoundField
          label={`Zone ${number} lower bound, percent of max`}
          unit="%"
          value={zone?.percent ?? ""}
          onChange={onPercent}
          className="w-14"
        />
        <BoundField
          label={`Zone ${number} lower bound, bpm`}
          unit="bpm"
          value={zone?.bpm ?? ""}
          onChange={onBpm}
          className="w-16"
        />
      </div>
    </div>
  );
}

type BoundFieldProps = {
  /** The whole name, read by screen readers: "Zone 2 lower bound, bpm". */
  label: string;
  /** Shown after the field; the label already says it. */
  unit: string;
  value: string;
  onChange: (value: string) => void;
  /** The field's width. */
  className: string;
};

function BoundField({ label, unit, value, onChange, className }: BoundFieldProps) {
  const id = useId();
  return (
    <div className="flex items-center gap-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn("px-2 text-right", className)}
      />
      <span aria-hidden="true" className="text-caption text-ink-2">
        {unit}
      </span>
    </div>
  );
}

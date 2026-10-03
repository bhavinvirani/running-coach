import { ChevronDown } from "lucide-react";
import { useId } from "react";
import { DURATION_PART_LABELS, type DurationParts } from "@/lib/duration-parts";
import { formatTwoDigits } from "@/lib/format";

/** Every race the app plans finishes inside 10 hours; a stored time past that still gets its hour. */
const HOURS_MAX = 9;
const SIXTY = Array.from({ length: 60 }, (_, value) => value);

type Part = keyof DurationParts;
const PARTS: readonly Part[] = ["hours", "minutes", "seconds"];

type DurationFieldProps = {
  /** The group's name: "Target time", "Time". */
  label: string;
  value: DurationParts;
  onChange: (value: DurationParts) => void;
  /**
   * A leading checkbox that sets the time aside, "No target": checked, the pickers and the description
   * hide, and the caller sends no time.
   */
  none?: { label: string; checked: boolean; onChange: (checked: boolean) => void };
  /** The caption under the pickers: the pace the time means. */
  description?: string | null;
};

/**
 * A time picked with the thumb: three native selects for hours, minutes and seconds side by side, so the
 * phone shows its own wheel and nothing is typed or misread. Styled like Input: surface-0 on the card,
 * line border, sm radius, at least 44 px high, no shadow; a chevron says each one opens.
 */
export function DurationField({ label, value, onChange, none, description }: DurationFieldProps) {
  const id = useId();
  const descriptionId = useId();
  const hidden = none?.checked === true;
  const describe = !hidden && description ? description : null;
  const options: Readonly<Record<Part, { value: number; label: string }[]>> = {
    hours: Array.from({ length: Math.max(HOURS_MAX, value.hours) + 1 }, (_, hours) => ({
      value: hours,
      label: String(hours),
    })),
    minutes: SIXTY.map((minutes) => ({ value: minutes, label: formatTwoDigits(minutes) })),
    seconds: SIXTY.map((seconds) => ({ value: seconds, label: formatTwoDigits(seconds) })),
  };

  return (
    // The padding sits on a wrapper: a legend renders in the fieldset's border box, above its padding.
    <div className="py-4">
      <fieldset aria-describedby={describe ? descriptionId : undefined}>
        <legend className="text-body text-ink-2">{label}</legend>
        {none ? (
          <label className="mt-2 flex min-h-11 cursor-pointer items-center gap-3 text-body text-ink">
            <input
              type="checkbox"
              checked={none.checked}
              onChange={(event) => none.onChange(event.target.checked)}
              className="size-5 shrink-0 cursor-pointer accent-accent"
            />
            {none.label}
          </label>
        ) : null}
        {hidden ? null : (
          <div className="mt-2 grid grid-cols-3 gap-2">
            {PARTS.map((part) => (
              <div key={part} className="flex min-w-0 flex-col gap-1">
                <label htmlFor={`${id}-${part}`} className="text-caption text-ink-2">
                  {DURATION_PART_LABELS[part]}
                </label>
                <div className="relative flex items-center">
                  <select
                    id={`${id}-${part}`}
                    value={value[part]}
                    onChange={(event) => onChange({ ...value, [part]: Number(event.target.value) })}
                    className="min-h-11 w-full min-w-0 cursor-pointer appearance-none rounded-sm border border-line bg-surface-0 pr-8 pl-3 text-body text-ink"
                  >
                    {options[part].map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    aria-hidden="true"
                    className="pointer-events-none absolute right-2.5 size-4 text-ink-2"
                    strokeWidth={1.75}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
        {describe ? (
          <p id={descriptionId} className="mt-2 text-caption text-ink-2">
            {describe}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}

import { amountUnitLabel } from "../builder-copy";
import type { AmountUnit } from "../workout-draft";

type UnitToggleProps = {
  /** Unique per step, so each step's radios form their own group. */
  name: string;
  legend: string;
  options: readonly AmountUnit[];
  value: AmountUnit;
  onChange: (unit: AmountUnit) => void;
};

/** What a step's amount counts, as a small segmented control beside it; the legend is for screen readers. */
export function UnitToggle({ name, legend, options, value, onChange }: UnitToggleProps) {
  return (
    <fieldset className="min-w-0 flex-1">
      <legend className="sr-only">{legend}</legend>
      <div className="flex gap-1 rounded-sm border border-line bg-surface-0">
        {options.map((unit) => (
          <label
            key={unit}
            className="flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-sm text-body text-ink-2 has-checked:bg-surface-2 has-checked:font-semibold has-checked:text-ink has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent"
          >
            <input
              type="radio"
              name={name}
              value={unit}
              checked={unit === value}
              onChange={() => onChange(unit)}
              className="sr-only"
            />
            {amountUnitLabel(unit)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

import { useId } from "react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

export type ChoiceOption<T extends string> = {
  value: T;
  label: string;
  /** One line under the label saying what the choice does. */
  helper: string;
};

type ChoiceListProps<T extends string> = {
  /** Names the group for screen readers: the screen's title, "Units". */
  label: string;
  options: readonly ChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** A caption under the card saying what the setting changes. */
  description?: string;
};

/**
 * One setting's choices as a vertical radio list on a surface-1 card: the radio, then the label with its
 * helper line under it. The whole row picks the option. Each radio is named by its label alone and
 * described by its helper, so a screen reader hears "Miles, radio button, 6.2 mi at 8:51 /mi…". Arrow
 * keys move between options and pick them, as with any radio group (Radix).
 */
export function ChoiceList<T extends string>({
  label,
  options,
  value,
  onChange,
  description,
}: ChoiceListProps<T>) {
  const id = useId();
  const descriptionId = `${id}-description`;

  return (
    <div className="flex flex-col gap-2">
      <RadioGroup
        aria-label={label}
        aria-describedby={description ? descriptionId : undefined}
        value={value}
        onValueChange={(picked) => {
          const option = options.find((candidate) => candidate.value === picked);
          if (option) onChange(option.value);
        }}
        className="divide-y divide-line rounded-md bg-surface-1 px-4"
      >
        {options.map((option) => {
          const itemId = `${id}-${option.value}`;
          return (
            <label
              key={option.value}
              htmlFor={itemId}
              className="flex min-h-12 cursor-pointer items-start gap-3 py-3"
            >
              <RadioGroupItem
                id={itemId}
                value={option.value}
                aria-labelledby={`${itemId}-label`}
                aria-describedby={`${itemId}-helper`}
                // Centered on the label's 22 px line.
                className="mt-0.5"
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span id={`${itemId}-label`} className="text-body text-ink">
                  {option.label}
                </span>
                <span id={`${itemId}-helper`} className="text-caption text-ink-2">
                  {option.helper}
                </span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
      {description ? (
        <p id={descriptionId} className="text-caption text-ink-2">
          {description}
        </p>
      ) : null}
    </div>
  );
}

/** A ChoiceList of `rows` options as it loads, at the loaded rows' heights. */
export function ChoiceListSkeleton({ rows, label }: { rows: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-2">
      <div className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className="flex min-h-12 items-start gap-3 py-3">
            <div className="mt-0.5 size-5 shrink-0 rounded-full bg-surface-2" />
            <div className="flex flex-col gap-1">
              <div className="flex h-5.5 items-center">
                <div className="h-4 w-24 rounded-sm bg-surface-2" />
              </div>
              <div className="flex h-4 items-center">
                <div className="h-3 w-48 rounded-sm bg-surface-2" />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex h-4 items-center">
        <div className="h-3 w-56 rounded-sm bg-surface-2" />
      </div>
    </div>
  );
}

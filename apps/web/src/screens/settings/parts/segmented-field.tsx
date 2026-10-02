import { useId } from "react";

export type SegmentOption<T extends string> = { value: T; label: string };

type SegmentedFieldProps<T extends string> = {
  name: string;
  legend: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  description?: string;
};

/** Radio buttons drawn as one segmented control: native keyboard and screen-reader behaviour. */
export function SegmentedField<T extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  description,
}: SegmentedFieldProps<T>) {
  const descriptionId = useId();

  return (
    // The padding sits on a wrapper: a legend renders in the fieldset's border box, above its padding.
    <div className="py-4">
      <fieldset aria-describedby={description ? descriptionId : undefined}>
        <legend className="text-body text-ink-2">{legend}</legend>
        <div className="mt-2 grid auto-cols-fr grid-flow-col gap-1 rounded-md bg-surface-0 p-1">
          {options.map((option) => (
            <label
              key={option.value}
              className="flex min-h-11 cursor-pointer items-center justify-center rounded-sm text-body text-ink-2 has-checked:bg-surface-2 has-checked:font-semibold has-checked:text-ink has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent"
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={option.value === value}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              {option.label}
            </label>
          ))}
        </div>
        {description ? (
          <p id={descriptionId} className="mt-2 text-caption text-ink-2">
            {description}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}

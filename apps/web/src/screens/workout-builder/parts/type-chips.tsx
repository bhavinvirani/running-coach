import { customSessionTypeSchema, type CustomSessionType } from "@running-coach/shared";
import { SessionTypeChip } from "@/components/session-type-chip";
import { builderCopy } from "../builder-copy";

type TypeChipsProps = {
  value: CustomSessionType;
  onChange: (type: CustomSessionType) => void;
};

/**
 * The five types a runner can build, as radio buttons drawn as chips, each with its type's dot: native
 * keyboard and screen-reader behaviour, wrapping onto a second line at 390 px.
 */
export function TypeChips({ value, onChange }: TypeChipsProps) {
  return (
    <div className="py-4">
      <fieldset>
        <legend className="text-body text-ink-2">{builderCopy.type}</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {customSessionTypeSchema.options.map((type) => (
            <label
              key={type}
              className="flex min-h-11 cursor-pointer items-center rounded-full border border-line px-3 text-body text-ink-2 has-checked:bg-surface-2 has-checked:font-semibold has-checked:text-ink has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent"
            >
              <input
                type="radio"
                name="type"
                value={type}
                checked={type === value}
                onChange={() => onChange(type)}
                className="sr-only"
              />
              <SessionTypeChip type={type} />
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

import { useId, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";

type TextFieldProps = {
  label: string;
  /** A caption under the field: the format a time takes, or that the field is optional. */
  description?: string;
} & ComponentProps<"input">;

/** A labelled input in a form card, spaced like the segmented fields beside it. */
export function TextField({ label, description, ...input }: TextFieldProps) {
  const inputId = useId();
  const descriptionId = useId();

  return (
    <div className="flex flex-col gap-2 py-4">
      <label htmlFor={inputId} className="text-body text-ink-2">
        {label}
      </label>
      <Input id={inputId} aria-describedby={description ? descriptionId : undefined} {...input} />
      {description ? (
        <p id={descriptionId} className="text-caption text-ink-2">
          {description}
        </p>
      ) : null}
    </div>
  );
}

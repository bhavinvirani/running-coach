import type { CoachCredentialChoice } from "@running-coach/shared";
import { SegmentedField, type SegmentOption } from "@/components/segmented-field";

const options: readonly SegmentOption<CoachCredentialChoice>[] = [
  { value: "plan", label: "Claude plan" },
  { value: "key", label: "API key" },
];

export function CoachCredentialField({
  value,
  onChange,
}: {
  value: CoachCredentialChoice;
  onChange: (choice: CoachCredentialChoice) => void;
}) {
  return (
    <SegmentedField
      name="coachCredential"
      legend="Coach uses"
      options={options}
      value={value}
      onChange={onChange}
    />
  );
}

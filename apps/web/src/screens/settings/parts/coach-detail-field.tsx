import type { CoachDetail } from "@running-coach/shared";
import { SegmentedField, type SegmentOption } from "@/components/segmented-field";

const options: readonly SegmentOption<CoachDetail>[] = [
  { value: "short", label: "Short" },
  { value: "standard", label: "Standard" },
  { value: "detailed", label: "Detailed" },
];

export function CoachDetailField({
  value,
  onChange,
}: {
  value: CoachDetail;
  onChange: (coachDetail: CoachDetail) => void;
}) {
  return (
    <SegmentedField
      name="coachDetail"
      legend="Coach detail"
      options={options}
      value={value}
      onChange={onChange}
      description="How much the coach writes after each run."
    />
  );
}

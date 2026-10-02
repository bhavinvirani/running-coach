import type { Units } from "@running-coach/shared";
import { SegmentedField, type SegmentOption } from "@/components/segmented-field";

const options: readonly SegmentOption<Units>[] = [
  { value: "km", label: "km" },
  { value: "mi", label: "mi" },
];

export function UnitsField({
  value,
  onChange,
}: {
  value: Units;
  onChange: (units: Units) => void;
}) {
  return (
    <SegmentedField
      name="units"
      legend="Units"
      options={options}
      value={value}
      onChange={onChange}
      description="Distance and pace everywhere in the app."
    />
  );
}

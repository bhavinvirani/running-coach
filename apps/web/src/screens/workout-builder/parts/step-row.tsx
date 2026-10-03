import {
  paceZoneSchema,
  stepKindSchema,
  type PaceZone,
  type PlanPaces,
  type StepKind,
  type Units,
} from "@running-coach/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatPlanPace } from "@/lib/pace-band";
import { OPEN_STEP_TARGET, isPacedStep, paceZoneName, stepKindName } from "@/lib/workout-steps";
import { builderCopy } from "../builder-copy";
import { amountUnits, type StepDraft } from "../workout-draft";
import { UnitToggle } from "./unit-toggle";

/** A native select drawn like the Input beside it, so phones open their own picker. */
const SELECT =
  "min-h-11 w-full min-w-0 rounded-sm border border-line bg-surface-0 px-3 text-body text-ink";

type StepRowProps = {
  step: StepDraft;
  /** "2", or "2.1" inside a repeat. */
  label: string;
  paces: PlanPaces;
  units: Units;
  /** False for a repeat's only step: the repeat goes instead. */
  removable: boolean;
  onChange: (changes: Partial<Omit<StepDraft, "id">>) => void;
  onRemove: () => void;
};

/**
 * One step: its kind, how long by time or distance, and for run and work steps the zone whose pace band
 * the watch holds it to, each zone labelled with that band from the plan. Warm-up, recovery and cool-down
 * run open, which the row says instead of offering a zone.
 */
export function StepRow({
  step,
  label,
  paces,
  units,
  removable,
  onChange,
  onRemove,
}: StepRowProps) {
  return (
    <div
      role="group"
      aria-label={builderCopy.stepLabel(label)}
      className="flex flex-col gap-2 py-3"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="w-8 shrink-0 text-caption text-ink-2">
          {label}
        </span>
        <select
          aria-label={builderCopy.kindOf(label)}
          value={step.kind}
          onChange={(event) => onChange({ kind: event.target.value as StepKind })}
          className={SELECT}
        >
          {stepKindSchema.options.map((kind) => (
            <option key={kind} value={kind}>
              {stepKindName(kind)}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          aria-label={builderCopy.removeStep(label)}
          disabled={!removable}
          onClick={onRemove}
        >
          {builderCopy.remove}
        </Button>
      </div>
      <div className="flex items-center gap-2 pl-10">
        <Input
          aria-label={builderCopy.amountOf(label)}
          inputMode="decimal"
          value={step.amount}
          onChange={(event) => onChange({ amount: event.target.value })}
          className="w-20 shrink-0"
        />
        <UnitToggle
          name={`unit-${step.id}`}
          legend={builderCopy.unitOf(label)}
          options={amountUnits(units)}
          value={step.unit}
          onChange={(unit) => onChange({ unit })}
        />
      </div>
      <div className="pl-10">
        {isPacedStep(step.kind) ? (
          <select
            aria-label={builderCopy.zoneOf(label)}
            value={step.zone}
            onChange={(event) => onChange({ zone: event.target.value as PaceZone })}
            className={SELECT}
          >
            {paceZoneSchema.options.map((zone) => (
              <option key={zone} value={zone}>
                {`${paceZoneName(zone)} · ${formatPlanPace(paces[zone], units)}`}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-caption text-ink-2">{OPEN_STEP_TARGET}</p>
        )}
      </div>
    </div>
  );
}

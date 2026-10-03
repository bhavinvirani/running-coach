import { REPEAT_MAX, REPEAT_STEPS_MAX, type PlanPaces, type Units } from "@running-coach/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { builderCopy } from "../builder-copy";
import { isRepeatDraft, type ItemDraft, type RepeatDraft, type StepDraft } from "../workout-draft";
import { StepRow } from "./step-row";

export type StepsEditorActions = {
  onStep: (id: string, changes: Partial<Omit<StepDraft, "id">>) => void;
  onRepeat: (id: string, repeat: string) => void;
  onRemove: (id: string) => void;
  onAddStep: (repeatId?: string) => void;
  onAddRepeat: () => void;
};

type StepsEditorProps = StepsEditorActions & {
  items: readonly ItemDraft[];
  paces: PlanPaces;
  units: Units;
};

/**
 * The workout's steps in order on one card, a repeat as its count with its own steps indented under it,
 * then Add step and Add repeat. Numbered like the session screen shows them, so "step 2.1" in an error
 * names the row it means.
 */
export function StepsEditor({ items, paces, units, ...actions }: StepsEditorProps) {
  return (
    <section aria-label={builderCopy.steps} className="flex flex-col gap-2">
      <h2 className="text-body font-semibold text-ink">{builderCopy.steps}</h2>
      {items.length > 0 ? (
        <div className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
          {items.map((item, position) => {
            const label = String(position + 1);
            return isRepeatDraft(item) ? (
              <RepeatGroup
                key={item.id}
                repeat={item}
                label={label}
                paces={paces}
                units={units}
                {...actions}
              />
            ) : (
              <StepRow
                key={item.id}
                step={item}
                label={label}
                paces={paces}
                units={units}
                removable
                onChange={(changes) => actions.onStep(item.id, changes)}
                onRemove={() => actions.onRemove(item.id)}
              />
            );
          })}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => actions.onAddStep()}>
          {builderCopy.addStep}
        </Button>
        <Button variant="secondary" onClick={actions.onAddRepeat}>
          {builderCopy.addRepeat}
        </Button>
      </div>
    </section>
  );
}

type RepeatGroupProps = StepsEditorActions & {
  repeat: RepeatDraft;
  label: string;
  paces: PlanPaces;
  units: Units;
};

function RepeatGroup({ repeat, label, paces, units, ...actions }: RepeatGroupProps) {
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="w-8 shrink-0 text-caption text-ink-2">
          {label}
        </span>
        <Input
          aria-label={builderCopy.timesOf(label)}
          inputMode="numeric"
          min={2}
          max={REPEAT_MAX}
          value={repeat.repeat}
          onChange={(event) => actions.onRepeat(repeat.id, event.target.value)}
          className="w-16 shrink-0"
        />
        <span className="text-body text-ink-2">{builderCopy.times}</span>
        <Button
          variant="ghost"
          className="ml-auto"
          aria-label={builderCopy.removeRepeat(label)}
          onClick={() => actions.onRemove(repeat.id)}
        >
          {builderCopy.remove}
        </Button>
      </div>
      <div className="ml-3 flex flex-col divide-y divide-line border-l border-line pl-3">
        {repeat.steps.map((step, index) => (
          <StepRow
            key={step.id}
            step={step}
            label={`${label}.${index + 1}`}
            paces={paces}
            units={units}
            removable={repeat.steps.length > 1}
            onChange={(changes) => actions.onStep(step.id, changes)}
            onRemove={() => actions.onRemove(step.id)}
          />
        ))}
      </div>
      <Button
        variant="ghost"
        className="self-start"
        aria-label={builderCopy.addStepTo(label)}
        disabled={repeat.steps.length >= REPEAT_STEPS_MAX}
        onClick={() => actions.onAddStep(repeat.id)}
      >
        {builderCopy.addStep}
      </Button>
    </div>
  );
}

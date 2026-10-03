import type { PlanPaces, SessionSteps, Step, Units } from "@running-coach/shared";
import { stepAmount, stepKindName, stepTarget } from "@/lib/workout-steps";
import { repeatLabel, sessionCopy } from "../session-copy";

type StepsListProps = {
  steps: SessionSteps;
  paces: PlanPaces;
  units: Units;
};

/**
 * The session as the watch will run it, numbered: each step's kind and length, and under it the pace band
 * the watch holds it to, or that it runs open. A repeat is one numbered item, "5 x", with its steps
 * indented under it.
 */
export function StepsList({ steps, paces, units }: StepsListProps) {
  return (
    <section aria-label={sessionCopy.steps} className="flex flex-col gap-2">
      <h2 className="text-body font-semibold text-ink">{sessionCopy.steps}</h2>
      <ol className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
        {steps.map((item, position) => (
          <li key={position} className="flex gap-3 py-3">
            <span aria-hidden="true" className="w-4 shrink-0 text-body text-ink-2">
              {position + 1}
            </span>
            {"repeat" in item ? (
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <span className="text-body font-semibold text-ink">{repeatLabel(item.repeat)}</span>
                <ul className="flex flex-col gap-2 border-l border-line pl-3">
                  {item.steps.map((step, inner) => (
                    <li key={inner}>
                      <StepLines step={step} paces={paces} units={units} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <StepLines step={item} paces={paces} units={units} />
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function StepLines({ step, paces, units }: { step: Step; paces: PlanPaces; units: Units }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="flex items-baseline justify-between gap-3 text-body text-ink">
        <span>{stepKindName(step.kind)}</span>
        <span className="shrink-0">{stepAmount(step, units)}</span>
      </span>
      <span className="text-caption text-ink-2">{stepTarget(step, paces, units)}</span>
    </div>
  );
}

import type { Goal, PlanPaces, Units } from "@running-coach/shared";
import { Link } from "react-router";
import { DotLine } from "@/components/dot-line";
import { Button } from "@/components/ui/button";
import { goalFacts, goalPaceFacts, goalWeeks, planCopy } from "../plan-copy";

type GoalCardProps = {
  goal: Goal;
  paces: PlanPaces;
  /** The plan's weeks still to run, the current one included (weeksLeft in src/lib/plan-week.ts). */
  weeksLeft: number;
  units: Units;
};

/**
 * The goal the plan builds to: the weeks left as the figure, then the race by name, its day and the runs a
 * week, then the target beside the race pace the plan trains at and its finish time, and Change goal.
 */
export function GoalCard({ goal, paces, weeksLeft, units }: GoalCardProps) {
  const weeks = goalWeeks(weeksLeft);
  return (
    <section
      aria-label={planCopy.goal}
      className="flex flex-col gap-3 rounded-md border border-line bg-surface-1 p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-caption text-ink-2">{planCopy.goal}</h2>
          <span className="text-figure text-ink">
            {weeks.value}
            <span className="ml-1 text-caption text-ink-2">{weeks.unit}</span>
          </span>
        </div>
        <Button asChild variant="secondary">
          <Link to="/plan/goal">{planCopy.changeGoal}</Link>
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <DotLine className="text-caption text-ink-2">{goalFacts(goal)}</DotLine>
        <DotLine className="text-caption text-ink-2">{goalPaceFacts(goal, paces, units)}</DotLine>
      </div>
    </section>
  );
}

/** The card at its loaded heights: label, weeks figure and button, then the facts and pace lines. */
export function GoalCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-1 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex h-4 items-center">
            <div className="h-3 w-10 rounded-sm bg-surface-2" />
          </div>
          <div className="h-8.5 w-24 rounded-sm bg-surface-2" />
        </div>
        <div className="h-11 w-32 rounded-sm bg-surface-2" />
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex h-4 items-center">
          <div className="h-3 w-72 rounded-sm bg-surface-2" />
        </div>
        <div className="flex h-4 items-center">
          <div className="h-3 w-64 rounded-sm bg-surface-2" />
        </div>
      </div>
    </div>
  );
}

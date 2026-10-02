import type { Goal } from "@running-coach/shared";
import { Link } from "react-router";
import { DotLine } from "@/components/dot-line";
import { Button } from "@/components/ui/button";
import { goalFacts, goalHeadline, planCopy } from "../plan-copy";

/** The goal the plan builds to: its distance as the figure, the facts under it, and Change goal. */
export function GoalCard({ goal, weeks }: { goal: Goal; weeks: number }) {
  return (
    <section
      aria-label={planCopy.goal}
      className="flex flex-col gap-3 rounded-md border border-line bg-surface-1 p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-caption text-ink-2">{planCopy.goal}</h2>
          <span className="text-figure text-ink">{goalHeadline(goal)}</span>
        </div>
        <Button asChild variant="secondary">
          <Link to="/plan/goal">{planCopy.changeGoal}</Link>
        </Button>
      </div>
      <DotLine className="text-caption text-ink-2">{goalFacts(goal, weeks)}</DotLine>
    </section>
  );
}

/** The card at its loaded heights: label, figure and button, then the facts line. */
export function GoalCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-1 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex h-4 items-center">
            <div className="h-3 w-10 rounded-sm bg-surface-2" />
          </div>
          <div className="h-8.5 w-20 rounded-sm bg-surface-2" />
        </div>
        <div className="h-11 w-32 rounded-sm bg-surface-2" />
      </div>
      <div className="flex h-4 items-center">
        <div className="h-3 w-56 rounded-sm bg-surface-2" />
      </div>
    </div>
  );
}

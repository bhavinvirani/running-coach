import type { ReactNode } from "react";
import { Link } from "react-router";
import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { weekHolds } from "@/lib/plan-week";
import { GoalCard, GoalCardSkeleton } from "./parts/goal-card";
import { PaceRow, PaceRowSkeleton } from "./parts/pace-row";
import { WeekCard, WeekCardSkeleton } from "./parts/week-card";
import { planCopy, warningSentence } from "./plan-copy";
import { usePlanScreen } from "./use-plan";

/**
 * Plan tab: the goal, the plan's paces, what the engine had to compromise on, then the weeks, each opening
 * its days. Empty until a goal is saved; the goal and its plan are saved together, so a goal without a
 * plan is empty too.
 */
export function PlanScreen() {
  const screen = usePlanScreen();
  const { data, status, error, refetch, units, today } = screen;

  if (status === "pending" || units === undefined || today === undefined) {
    return (
      <PlanLayout busy>
        <PlanSkeleton />
      </PlanLayout>
    );
  }

  if (status === "error") {
    return (
      <PlanLayout>
        <div className="flex flex-col items-start gap-4">
          <p role="alert" className="text-body text-ink">
            {errorMessage(error)}
          </p>
          <Button variant="secondary" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      </PlanLayout>
    );
  }

  const refetchFailed = screen.refetchError ? (
    <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
  ) : null;

  if (data.goal === null || data.plan === null) {
    return (
      <PlanLayout>
        {refetchFailed}
        <div className="flex flex-col items-start gap-4">
          <p className="text-body text-ink-2">{planCopy.empty}</p>
          <Button asChild>
            <Link to="/plan/goal">{planCopy.setGoal}</Link>
          </Button>
        </div>
      </PlanLayout>
    );
  }

  const { goal, plan } = data;
  const lastWeekStart = plan.weeks[plan.weeks.length - 1]?.startDate ?? plan.startDate;

  return (
    <PlanLayout>
      {refetchFailed}
      <GoalCard goal={goal} paces={plan.paces} weeks={plan.weeks.length} units={units} />
      <PaceRow paces={plan.paces} units={units} />
      {plan.warnings.length > 0 ? (
        <ul aria-label={planCopy.notes} className="flex flex-col gap-2">
          {plan.warnings.map((warning, position) => (
            <li key={`${warning.code}-${position}`} className="text-body text-ink">
              {warningSentence(warning, units)}
            </li>
          ))}
        </ul>
      ) : null}
      <section aria-label={planCopy.weeks} className="flex flex-col gap-2">
        <h2 className="text-body font-semibold text-ink">{planCopy.weeks}</h2>
        <ol className="flex flex-col gap-3">
          {plan.weeks.map((week) => (
            <WeekCard
              key={week.number}
              week={week}
              units={units}
              lastWeekStart={lastWeekStart}
              current={weekHolds(week, today)}
            />
          ))}
        </ol>
      </section>
    </PlanLayout>
  );
}

// Every branch renders PlanLayout at the root, so React keeps the title in place when data arrives.
function PlanLayout({ children, busy }: { children: ReactNode; busy?: boolean }) {
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-8" aria-busy={busy}>
      <h1 className="text-title text-ink">{planCopy.title}</h1>
      {children}
    </div>
  );
}

/** The goal card, the paces row and two weeks at their loaded heights, so nothing jumps on load. */
function PlanSkeleton() {
  return (
    <div role="status" aria-label={planCopy.loading} className="flex flex-col gap-4">
      <GoalCardSkeleton />
      <PaceRowSkeleton />
      <div className="flex flex-col gap-2">
        <div className="flex h-5.5 items-center">
          <div className="h-4 w-14 rounded-sm bg-surface-2" />
        </div>
        <div className="flex flex-col gap-3">
          <WeekCardSkeleton />
          <WeekCardSkeleton />
        </div>
      </div>
    </div>
  );
}

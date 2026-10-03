import {
  DAYS_PER_WEEK_MAX,
  DAYS_PER_WEEK_MIN,
  raceDistanceKeySchema,
  weekdaySchema,
  type Goal,
  type GoalInput,
  type GoalKind,
  type PlanConflict,
  type RaceDistanceKey,
  type Units,
} from "@running-coach/shared";
import { useState, type FormEvent, type ReactNode } from "react";
import { BackLink } from "@/components/back-link";
import { DurationField } from "@/components/duration-field";
import { RetryAlert } from "@/components/retry-alert";
import { SegmentedField, type SegmentOption } from "@/components/segmented-field";
import { Button } from "@/components/ui/button";
import { distanceLabel } from "@/lib/distance-labels";
import { durationSeconds } from "@/lib/duration-parts";
import { errorMessage } from "@/lib/errors";
import { weekdayName } from "@/lib/plan-week";
import { conflictSentence, goalCopy, timePace } from "./goal-copy";
import { RECENT_DISTANCE_KEYS, goalForm, goalInput, type GoalForm } from "./goal-form";
import { FormSection } from "./parts/form-section";
import { TextField } from "./parts/text-field";
import { useGoalScreen } from "./use-goal";

const kindOptions: readonly SegmentOption<GoalKind>[] = [
  { value: "race", label: goalCopy.race },
  { value: "fitness", label: goalCopy.fitness },
];

const raceDistanceOptions: readonly SegmentOption<RaceDistanceKey>[] =
  raceDistanceKeySchema.options.map((key) => ({ value: key, label: distanceLabel(key) }));

/** A fitness plan may take any distance's shape; "any" stands for null, which the form sends. */
const ANY = "any";
const fitnessDistanceOptions: readonly SegmentOption<RaceDistanceKey | typeof ANY>[] = [
  { value: ANY, label: goalCopy.anyDistance },
  ...raceDistanceOptions,
];

const daysPerWeekOptions: readonly SegmentOption<string>[] = Array.from(
  { length: DAYS_PER_WEEK_MAX - DAYS_PER_WEEK_MIN + 1 },
  (_, offset) => {
    const days = String(DAYS_PER_WEEK_MIN + offset);
    return { value: days, label: days };
  },
);

const longRunDayOptions = weekdaySchema.options.map((day) => ({
  value: day,
  label: weekdayName(day),
}));

const recentDistanceOptions = RECENT_DISTANCE_KEYS.map((key) => ({
  value: key,
  label: distanceLabel(key),
}));

/**
 * The goal form at /plan/goal: what the plan builds to, the training week, and a recent race when the
 * runner has one or the plan needs one. No empty state: without a goal the form starts from defaults,
 * which is how a first goal is set. Save goal opens the new plan; a goal that cannot be planned stays on
 * the form with the reason.
 */
export function GoalScreen() {
  const screen = useGoalScreen();
  const { data, status, error, refetch, units } = screen;

  if (status === "pending" || units === undefined) {
    return <GoalSkeleton />;
  }

  if (status === "error") {
    return (
      <GoalLayout>
        <div className="flex flex-col items-start gap-4">
          <p role="alert" className="text-body text-ink">
            {errorMessage(error)}
          </p>
          <Button variant="secondary" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      </GoalLayout>
    );
  }

  return (
    <GoalLayout>
      {screen.refetchError ? (
        <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
      ) : null}
      <GoalFormView
        // A goal saved elsewhere starts the form again from it; a background reload of the same one does not.
        key={data.goal?.updatedAt ?? "new"}
        goal={data.goal}
        units={units}
        saving={screen.saving}
        saveError={screen.saveError}
        conflict={screen.conflict}
        onSave={screen.saveGoal}
      />
    </GoalLayout>
  );
}

type GoalFormViewProps = {
  goal: Goal | null;
  units: Units;
  saving: boolean;
  saveError: Error | null;
  conflict: PlanConflict | null;
  onSave: (goal: GoalInput) => void;
};

function GoalFormView({ goal, units, saving, saveError, conflict, onSave }: GoalFormViewProps) {
  const [form, setForm] = useState<GoalForm>(() => goalForm(goal));
  const [formError, setFormError] = useState<string | null>(null);
  // The plan has no time to set paces from: the fields to type one in open with the sentence.
  const showRecentTime = form.showRecentTime || conflict?.code === "no_recent_time";
  const race = form.kind === "race";

  function update(changes: Partial<GoalForm>) {
    setForm((current) => ({ ...current, ...changes }));
    setFormError(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = goalInput({ ...form, showRecentTime });
    if (!result.ok) {
      setFormError(result.message);
      return;
    }
    setFormError(null);
    onSave(result.goal);
  }

  const alert =
    formError ??
    (saving
      ? null
      : conflict
        ? conflictSentence(conflict, units)
        : saveError
          ? errorMessage(saveError)
          : null);

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <FormSection title={goalCopy.target}>
        <SegmentedField
          name="kind"
          legend={goalCopy.trainingFor}
          options={kindOptions}
          value={form.kind}
          onChange={(kind) => update({ kind })}
        />
        {race ? (
          <SegmentedField
            name="distance"
            legend={goalCopy.distance}
            options={raceDistanceOptions}
            value={form.distanceKey}
            onChange={(distanceKey) => update({ distanceKey })}
          />
        ) : (
          <SegmentedField
            name="distance"
            legend={goalCopy.distance}
            options={fitnessDistanceOptions}
            value={form.distanceKey ?? ANY}
            onChange={(value) => update({ distanceKey: value === ANY ? null : value })}
            description={goalCopy.fitnessDistanceHelp}
          />
        )}
        {race ? (
          <>
            <TextField
              label={goalCopy.raceDate}
              type="date"
              name="raceDate"
              value={form.raceDate}
              onChange={(event) => update({ raceDate: event.target.value })}
            />
            <DurationField
              label={goalCopy.targetTime}
              value={form.targetTime}
              onChange={(targetTime) => update({ targetTime })}
              none={{
                label: goalCopy.noTarget,
                checked: form.noTargetTime,
                onChange: (noTargetTime) => update({ noTargetTime }),
              }}
              description={timePace(form.distanceKey, durationSeconds(form.targetTime), units)}
            />
          </>
        ) : null}
      </FormSection>
      <FormSection title={goalCopy.week}>
        <SegmentedField
          name="daysPerWeek"
          legend={goalCopy.daysPerWeek}
          options={daysPerWeekOptions}
          value={String(form.daysPerWeek)}
          onChange={(days) => update({ daysPerWeek: Number(days) })}
        />
        <SegmentedField
          name="longRunDay"
          legend={goalCopy.longRunDay}
          options={longRunDayOptions}
          value={form.longRunDay}
          onChange={(longRunDay) => update({ longRunDay })}
        />
      </FormSection>
      {showRecentTime ? (
        <FormSection title={goalCopy.recentRace}>
          <SegmentedField
            name="recentDistance"
            legend={goalCopy.distance}
            options={recentDistanceOptions}
            value={form.recentDistanceKey}
            onChange={(recentDistanceKey) => update({ recentDistanceKey })}
            description={goalCopy.recentRaceHelp}
          />
          <DurationField
            label={goalCopy.time}
            value={form.recentTime}
            onChange={(recentTime) => update({ recentTime })}
            description={timePace(form.recentDistanceKey, durationSeconds(form.recentTime), units)}
          />
        </FormSection>
      ) : (
        <Button
          variant="ghost"
          className="self-start"
          onClick={() => update({ showRecentTime: true })}
        >
          {goalCopy.addRecentRace}
        </Button>
      )}
      {alert ? (
        <p role="alert" className="text-body text-ink">
          {alert}
        </p>
      ) : null}
      <Button type="submit" size="lg" className="w-full" disabled={saving} aria-busy={saving}>
        {saving ? goalCopy.saving : goalCopy.save}
      </Button>
    </form>
  );
}

/** A detail screen: Back top left, Goal centered as the title. */
function GoalLayout({ children, busy }: { children: ReactNode; busy?: boolean }) {
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-8" aria-busy={busy}>
      <header className="relative flex min-h-11 items-center justify-center">
        <BackLink to="/plan" />
        <h1 className="text-title text-ink">{goalCopy.title}</h1>
      </header>
      {children}
    </div>
  );
}

/** The two field cards and Save goal at their loaded heights, so nothing jumps when the goal arrives. */
function GoalSkeleton() {
  return (
    <GoalLayout busy>
      <div role="status" aria-label={goalCopy.loading} className="flex flex-col gap-4">
        <SkeletonCard fields={4} />
        <SkeletonCard fields={2} />
        <div className="h-12 rounded-sm bg-surface-2" />
      </div>
    </GoalLayout>
  );
}

function SkeletonCard({ fields }: { fields: number }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-5.5 items-center">
        <div className="h-4 w-20 rounded-sm bg-surface-2" />
      </div>
      <div className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
        {Array.from({ length: fields }, (_, field) => (
          <div key={field} className="flex flex-col gap-2 py-4">
            <div className="flex h-5.5 items-center">
              <div className="h-4 w-24 rounded-sm bg-surface-2" />
            </div>
            <div className="h-13 rounded-md bg-surface-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

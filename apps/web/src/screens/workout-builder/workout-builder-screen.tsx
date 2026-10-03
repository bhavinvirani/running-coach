import {
  SESSION_TITLE_MAX,
  type CustomSessionInput,
  type PlanPaces,
  type Units,
} from "@running-coach/shared";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { BackLink } from "@/components/back-link";
import { CardSection } from "@/components/card-section";
import { RetryAlert } from "@/components/retry-alert";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/ui/button";
import { errorMessage, errorMessages } from "@/lib/errors";
import { MISSING, formatShortDay } from "@/lib/format";
import { canChange } from "@/lib/session-days";
import { builderCopy } from "./builder-copy";
import { StepsEditor } from "./parts/steps-editor";
import { TypeChips } from "./parts/type-chips";
import { WorkoutSummary } from "./parts/workout-summary";
import { useEditWorkoutScreen, useNewWorkoutScreen } from "./use-workout-builder";
import {
  addRepeat,
  addStep,
  chooseType,
  draftFromSession,
  draftSteps,
  newDraft,
  removeItem,
  updateRepeat,
  updateStep,
  workoutInput,
  type WorkoutDraft,
} from "./workout-draft";

/**
 * The workout builder: /plan/sessions/new?date= builds a workout of the runner's own, and
 * /plan/sessions/:id/edit changes one. A workout's steps name the plan's zones, so without an active plan
 * the builder says so and links to the goal instead of the form; that is its empty state.
 */
export function WorkoutBuilderScreen() {
  const { id } = useParams();
  return id === undefined ? <NewWorkout /> : <EditWorkout key={id} id={id} />;
}

/** The date from the link that opened the builder (Add on a day), else today; never a past date. */
function startDate(asked: string | null, today: string): string {
  return asked !== null && formatShortDay(asked) !== MISSING && asked >= today ? asked : today;
}

function NewWorkout() {
  const screen = useNewWorkoutScreen();
  const [params] = useSearchParams();
  const { data, status, error, refetch, units, today } = screen;
  const title = builderCopy.newTitle;

  if (status === "pending" || units === undefined || today === undefined) {
    return <BuilderSkeleton title={title} />;
  }
  if (status === "error") {
    return <LoadError title={title} error={error} onRetry={() => void refetch()} />;
  }

  const refetchFailed = screen.refetchError ? (
    <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
  ) : null;

  if (data.plan === null) {
    return (
      <BuilderLayout title={title}>
        {refetchFailed}
        <div className="flex flex-col items-start gap-4">
          <p className="text-body text-ink-2">{errorMessages.plan_missing}</p>
          <Button asChild>
            <Link to="/plan/goal">{builderCopy.setGoal}</Link>
          </Button>
        </div>
      </BuilderLayout>
    );
  }

  const asked = params.get("date");
  return (
    <BuilderLayout title={title}>
      {refetchFailed}
      <BuilderForm
        // Keyed on the link, never on today: a render after midnight must not swap the draft for a fresh
        // preset. The start date is read once, at mount; a draft left on yesterday fails the date check.
        key={asked ?? "new"}
        initial={() => newDraft(startDate(asked, today), units)}
        paces={data.plan.paces}
        units={units}
        today={today}
        saving={screen.saving}
        saveError={screen.saveError}
        onSave={screen.save}
      />
    </BuilderLayout>
  );
}

function EditWorkout({ id }: { id: string }) {
  const screen = useEditWorkoutScreen(id);
  const { data, status, error, refetch, units, today } = screen;
  const title = builderCopy.editTitle;

  if (status === "pending" || units === undefined || today === undefined) {
    return <BuilderSkeleton title={title} />;
  }
  if (status === "error") {
    return <LoadError title={title} error={error} onRetry={() => void refetch()} />;
  }

  const { session, paces } = data;
  // Only the runner's own workouts are built here, and only while they can still change.
  const blocked =
    session.source !== "custom"
      ? builderCopy.notCustom
      : canChange(session, today)
        ? null
        : errorMessages.session_locked;
  if (blocked !== null) {
    return (
      <BuilderLayout title={title}>
        <div className="flex flex-col items-start gap-4">
          <p className="text-body text-ink-2">{blocked}</p>
          <Button asChild>
            <Link to={`/plan/sessions/${session.id}`}>{builderCopy.openSession}</Link>
          </Button>
        </div>
      </BuilderLayout>
    );
  }

  return (
    <BuilderLayout title={title}>
      {screen.refetchError ? (
        <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
      ) : null}
      <BuilderForm
        key={session.id}
        initial={() => draftFromSession(session, units)}
        paces={paces}
        units={units}
        today={today}
        saving={screen.saving}
        saveError={screen.saveError}
        onSave={screen.save}
      />
    </BuilderLayout>
  );
}

type BuilderFormProps = {
  initial: () => WorkoutDraft;
  paces: PlanPaces;
  units: Units;
  today: string;
  saving: boolean;
  saveError: Error | null;
  onSave: (input: CustomSessionInput) => void;
};

function BuilderForm({
  initial,
  paces,
  units,
  today,
  saving,
  saveError,
  onSave,
}: BuilderFormProps) {
  const [draft, setDraft] = useState(initial);
  const [formError, setFormError] = useState<string | null>(null);

  function change(next: (current: WorkoutDraft) => WorkoutDraft) {
    setDraft(next);
    setFormError(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = workoutInput(draft, units, today);
    if (!result.ok) {
      setFormError(result.message);
      return;
    }
    setFormError(null);
    onSave(result.input);
  }

  const alert = formError ?? (saving || saveError === null ? null : errorMessage(saveError));

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <CardSection title={builderCopy.workout}>
        <TextField
          label={builderCopy.date}
          type="date"
          name="date"
          min={today}
          value={draft.date}
          onChange={(event) => change((current) => ({ ...current, date: event.target.value }))}
        />
        <TypeChips
          value={draft.type}
          onChange={(type) => change((current) => chooseType(current, type, units))}
        />
        <TextField
          label={builderCopy.title}
          name="title"
          maxLength={SESSION_TITLE_MAX}
          description={builderCopy.titleHelp}
          value={draft.title}
          onChange={(event) => change((current) => ({ ...current, title: event.target.value }))}
        />
      </CardSection>
      <StepsEditor
        items={draft.items}
        paces={paces}
        units={units}
        onStep={(id, changes) => change((current) => updateStep(current, id, changes))}
        onRepeat={(id, repeat) => change((current) => updateRepeat(current, id, repeat))}
        onRemove={(id) => change((current) => removeItem(current, id))}
        onAddStep={(repeatId) => change((current) => addStep(current, repeatId))}
        onAddRepeat={() => change(addRepeat)}
      />
      <WorkoutSummary steps={draftSteps(draft.items, units)} paces={paces} units={units} />
      {alert ? (
        <p role="alert" className="text-body text-ink">
          {alert}
        </p>
      ) : null}
      <Button type="submit" size="lg" className="w-full" disabled={saving} aria-busy={saving}>
        {saving ? builderCopy.saving : builderCopy.save}
      </Button>
    </form>
  );
}

function LoadError({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: Error;
  onRetry: () => void;
}) {
  return (
    <BuilderLayout title={title}>
      <div className="flex flex-col items-start gap-4">
        <p role="alert" className="text-body text-ink">
          {errorMessage(error)}
        </p>
        <Button variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </BuilderLayout>
  );
}

/** A detail screen: Back top left, New workout or Edit workout centered as the title. */
function BuilderLayout({
  title,
  children,
  busy,
}: {
  title: string;
  children: ReactNode;
  busy?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-8" aria-busy={busy}>
      <header className="relative flex min-h-11 items-center justify-center">
        <BackLink to="/plan" />
        <h1 className="text-title text-ink">{title}</h1>
      </header>
      {children}
    </div>
  );
}

/** The workout card, one step and Save workout at their loaded heights. */
function BuilderSkeleton({ title }: { title: string }) {
  return (
    <BuilderLayout title={title} busy>
      <div role="status" aria-label={builderCopy.loading} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex h-5.5 items-center">
            <div className="h-4 w-16 rounded-sm bg-surface-2" />
          </div>
          <div className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
            {Array.from({ length: 3 }, (_, field) => (
              <div key={field} className="flex flex-col gap-2 py-4">
                <div className="flex h-5.5 items-center">
                  <div className="h-4 w-12 rounded-sm bg-surface-2" />
                </div>
                <div className="h-11 rounded-sm bg-surface-0" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex h-5.5 items-center">
            <div className="h-4 w-12 rounded-sm bg-surface-2" />
          </div>
          <div className="flex flex-col gap-2 rounded-md bg-surface-1 px-4 py-3">
            <div className="h-11 rounded-sm bg-surface-0" />
            <div className="ml-10 h-11 rounded-sm bg-surface-0" />
            <div className="ml-10 h-11 rounded-sm bg-surface-0" />
          </div>
        </div>
        <div className="h-12 rounded-sm bg-surface-2" />
      </div>
    </BuilderLayout>
  );
}

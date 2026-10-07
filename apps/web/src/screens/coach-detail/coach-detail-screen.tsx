import type { CoachDetail } from "@running-coach/shared";
import { ChoiceList, ChoiceListSkeleton, type ChoiceOption } from "@/components/choice-list";
import { DetailLayout } from "@/components/detail-header";
import { LoadError } from "@/components/load-error";
import { RetryAlert } from "@/components/retry-alert";
import { errorMessage } from "@/lib/errors";
import { coachDetailNames } from "@/lib/settings-names";
import { useCoachDetailScreen } from "./use-coach-detail";

const TITLE = "Coach detail";
const DESCRIPTION = "How much the coach writes on each run and weekly review.";

/** What the coach prompts do with each level. */
const options: readonly ChoiceOption<CoachDetail>[] = [
  {
    value: "short",
    label: coachDetailNames.short,
    helper: "One sentence per part of each coach card.",
  },
  { value: "standard", label: coachDetailNames.standard, helper: "Up to two sentences per part." },
  {
    value: "detailed",
    label: coachDetailNames.detailed,
    helper: "Up to three sentences per part.",
  },
];

/**
 * How much the coach writes, at /settings/coach-detail. A choice is saved at once and shown before the
 * answer. No empty state: every account has a level, standard until changed.
 */
export function CoachDetailScreen() {
  const screen = useCoachDetailScreen();
  const { data, status, error, refetch } = screen;

  if (status === "pending") {
    return (
      <DetailLayout title={TITLE} backTo="/settings" busy>
        <ChoiceListSkeleton rows={options.length} label="Loading coach detail" />
      </DetailLayout>
    );
  }

  if (status === "error") {
    return (
      <DetailLayout title={TITLE} backTo="/settings">
        <LoadError error={error} onRetry={() => void refetch()} />
      </DetailLayout>
    );
  }

  return (
    <DetailLayout title={TITLE} backTo="/settings">
      {screen.refetchError ? (
        <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
      ) : null}
      <ChoiceList
        label={TITLE}
        options={options}
        value={screen.pending ?? data.settings.coachDetail}
        onChange={screen.choose}
        description={DESCRIPTION}
      />
      {screen.updateError ? (
        <p role="alert" className="text-body text-ink">
          {errorMessage(screen.updateError)}
        </p>
      ) : null}
    </DetailLayout>
  );
}

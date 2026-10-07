import { unitsSchema, type Units } from "@running-coach/shared";
import { ChoiceList, ChoiceListSkeleton, type ChoiceOption } from "@/components/choice-list";
import { DetailLayout } from "@/components/detail-header";
import { LoadError } from "@/components/load-error";
import { RetryAlert } from "@/components/retry-alert";
import { errorMessage } from "@/lib/errors";
import { unitsNames } from "@/lib/settings-names";
import { exampleRun } from "./example-run";
import { useUnitsScreen } from "./use-units";

const TITLE = "Units";
const DESCRIPTION = "Distance, pace and elevation everywhere in the app.";

/** Each unit with the same example run in it, so the choice shows what changes. */
const options: readonly ChoiceOption<Units>[] = unitsSchema.options.map((units) => ({
  value: units,
  label: unitsNames[units],
  helper: exampleRun(units),
}));

/**
 * The runner's one unit setting at /settings/units: kilometers or miles, for distance, pace and elevation.
 * A choice is saved at once and shown before the answer. No empty state: every account has a unit.
 */
export function UnitsScreen() {
  const screen = useUnitsScreen();
  const { data, status, error, refetch } = screen;

  if (status === "pending") {
    return (
      <DetailLayout title={TITLE} backTo="/settings" busy>
        <ChoiceListSkeleton rows={options.length} label="Loading units" />
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
        value={screen.pending ?? data.settings.units}
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

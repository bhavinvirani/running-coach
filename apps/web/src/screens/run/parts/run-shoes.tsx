import type { Shoe, ShoesResponse } from "@running-coach/shared";
import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { ScreenState } from "@/api/screen-state";
import { ChoiceList, type ChoiceOption } from "@/components/choice-list";
import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { shoeDetails, shoeName, shoeStatus } from "@/lib/shoe-names";
import { RunSection } from "./run-section";

const TITLE = "Shoes";
/** The choice for no pair: no uuid can take this value. */
const NONE = "none";

export type RunShoesState = {
  state: ScreenState<ShoesResponse>;
  /** The pair being saved (null for none); undefined while nothing is. */
  pending: string | null | undefined;
  error: Error | null;
  choose: (shoeId: string | null) => void;
};

type RunShoesProps = RunShoesState & {
  /** The pair the stored run wore, null for none. */
  shoeId: string | null;
};

/**
 * The pair the run wore, under the stats: its name, or None, and Change, which opens the runner's pairs in
 * place as a ChoiceList, in use first and retired ones after (an old run may have worn one), then None.
 * A choice is saved at once and shown before the answer, like Units. Loads on its own: a skeleton row, or
 * an alert with Retry inside the section, never holding up the run. Without any pair, one sentence and a
 * link to add one.
 */
export function RunShoes({ shoeId, state, pending, error, choose }: RunShoesProps) {
  const [open, setOpen] = useState(false);
  const nameId = useId();

  if (state.status === "pending") {
    return (
      <ShoesSection>
        <Card>
          <div role="status" aria-label="Loading shoes" className="flex min-h-11 items-center">
            <div className="h-4 w-32 rounded-sm bg-surface-2" />
          </div>
        </Card>
      </ShoesSection>
    );
  }

  if (state.status === "error") {
    return (
      <ShoesSection>
        <Card>
          <RetryAlert error={state.error} onRetry={() => void state.refetch()} />
        </Card>
      </ShoesSection>
    );
  }

  const pairs = state.data.shoes;
  const shown = pending === undefined ? shoeId : pending;
  const worn = pairs.find((pair) => pair.id === shown);
  const refetchFailed = state.refetchError ? (
    <RetryAlert error={state.refetchError} onRetry={() => void state.refetch()} />
  ) : null;

  if (pairs.length === 0) {
    return (
      <ShoesSection>
        {refetchFailed}
        <Card>
          <p className="text-body text-ink-2">
            No shoes yet. Add a pair to count how far each one runs.
          </p>
          <Button asChild variant="secondary" className="self-start">
            <Link to="/settings/shoes/new">Add shoes</Link>
          </Button>
        </Card>
      </ShoesSection>
    );
  }

  return (
    <ShoesSection>
      {refetchFailed}
      <div className="flex items-center justify-between gap-3 rounded-md bg-surface-1 py-2 pr-2 pl-4">
        <span id={nameId} className="min-w-0 truncate text-body text-ink">
          {worn ? shoeName(worn) : "None"}
        </span>
        {/* Described by the pair, so a screen reader hears what Change would change. */}
        <Button
          variant="secondary"
          aria-expanded={open}
          aria-describedby={nameId}
          onClick={() => setOpen((was) => !was)}
        >
          Change
        </Button>
      </div>
      {open ? (
        <ChoiceList
          label="Shoes for this run"
          options={options(pairs)}
          value={worn?.id ?? NONE}
          onChange={(value) => choose(value === NONE ? null : value)}
        />
      ) : null}
      {pending !== undefined ? (
        <p role="status" className="text-caption text-ink-2">
          Saving…
        </p>
      ) : error ? (
        <p role="alert" className="text-body text-ink">
          {errorMessage(error)}
        </p>
      ) : null}
    </ShoesSection>
  );
}

/** Each pair in the API's order (active, in use, retired) with where it stands, then None. */
function options(pairs: readonly Shoe[]): ChoiceOption<string>[] {
  return [
    ...pairs.map((pair) => ({
      value: pair.id,
      label: shoeName(pair),
      helper: [shoeStatus(pair), ...shoeDetails(pair)].join(" · "),
    })),
    { value: NONE, label: "None", helper: "This run counts toward no pair." },
  ];
}

function ShoesSection({ children }: { children: ReactNode }) {
  return (
    <RunSection title={TITLE} className="mt-2" card={false}>
      <div className="flex flex-col gap-2">{children}</div>
    </RunSection>
  );
}

/** The section's card while there is no pair row: the run screen's card padding. */
function Card({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 rounded-md bg-surface-1 p-4">{children}</div>;
}

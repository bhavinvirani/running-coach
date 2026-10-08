import type { Shoe, Units } from "@running-coach/shared";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { DistanceBar } from "@/charts/distance-bar";
import { DotLine } from "@/components/dot-line";
import { formatCount, formatDuration } from "@/lib/format";
import { shoeDetails, shoeName } from "@/lib/shoe-names";
import { distanceOfGoal, pastGoalLine, shoesCopy } from "../shoes-copy";

/**
 * One pair on a Shoes card, opening its screen: the name with Active beside the active pair, what the name
 * leaves out (brand and model under a nickname, the colour), the distance of the goal with its bar, how far
 * past the goal in words, then runs and time. Like ListRow, the wrapper takes the card's hairline so the
 * tap feedback can reach past the text.
 */
export function ShoeRow({ shoe, units }: { shoe: Shoe; units: Units }) {
  const details = shoeDetails(shoe);
  const past = pastGoalLine(shoe, units);

  return (
    <div>
      <Link
        to={`/settings/shoes/${shoe.id}`}
        className="-mx-2 flex items-center gap-3 rounded-sm px-2 py-3 active:bg-surface-2"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-col">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-body font-semibold text-ink">
                {shoeName(shoe)}
              </span>
              {shoe.active ? (
                <span className="shrink-0 text-caption text-ink-2">{shoesCopy.active}</span>
              ) : null}
            </div>
            {details.length > 0 ? (
              <DotLine className="text-caption text-ink-2">{details}</DotLine>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-body text-ink">{distanceOfGoal(shoe, units)}</p>
            <DistanceBar distanceM={shoe.distanceM} goalM={shoe.retireDistanceM} />
            {past ? <p className="text-caption text-ink-2">{past}</p> : null}
          </div>
          <DotLine className="text-caption text-ink-2">
            {formatCount(shoe.runs, "run", "runs")}
            {formatDuration(shoe.durationS)}
          </DotLine>
        </div>
        <ChevronRight
          aria-hidden="true"
          className="size-5 shrink-0 text-ink-3"
          strokeWidth={1.75}
        />
      </Link>
    </div>
  );
}

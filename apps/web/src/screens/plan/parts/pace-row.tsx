import { paceZoneSchema, type PlanPaces, type Units } from "@running-coach/shared";
import { formatPlanPace } from "@/lib/pace-band";
import { paceZoneName } from "@/lib/workout-steps";
import { planCopy } from "../plan-copy";

/**
 * Like the personal bests row: it bleeds to the screen's edges (-mx-4 undoes the screen's px-4, px-4 puts
 * the first tile back in line with the heading), scrolls sideways with no bar, settles with a tile at the
 * heading's edge, and takes focus itself so a keyboard can scroll it.
 */
const ROW =
  "-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2 overflow-x-auto px-4 py-1 scrollbar-none focus-visible:-outline-offset-2";
const TILE = "flex flex-col rounded-md bg-surface-1 px-2.5 py-2 whitespace-nowrap";

/**
 * The plan's pace bands in the runner's unit as one row of small tiles, easy first and then faster, in
 * the contract's zone order, so a session's "at 4:45-4:52 /km" can be checked against its zone.
 */
export function PaceRow({ paces, units }: { paces: PlanPaces; units: Units }) {
  return (
    <section aria-label={planCopy.paces} className="flex flex-col gap-2">
      <h2 className="text-body font-semibold text-ink">{planCopy.paces}</h2>
      <ul aria-label={planCopy.paces} tabIndex={0} className={ROW}>
        {paceZoneSchema.options.map((zone) => (
          <li key={zone} className="shrink-0 snap-start">
            <div className={TILE}>
              <span className="text-caption text-ink-2">{paceZoneName(zone)}</span>
              <span className="text-body text-ink">{formatPlanPace(paces[zone], units)}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The row's heading and six tiles at their loaded size, so nothing jumps on load. */
export function PaceRowSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-5.5 items-center">
        <div className="h-4 w-14 rounded-sm bg-surface-2" />
      </div>
      <div className="-mx-4 flex gap-2 overflow-hidden px-4 py-1">
        {Array.from({ length: paceZoneSchema.options.length }, (_, position) => (
          <div key={position} className={TILE}>
            <div className="flex h-4 items-center">
              <div className="h-3 w-12 rounded-sm bg-surface-2" />
            </div>
            <div className="flex h-5.5 items-center">
              <div className="h-4 w-24 rounded-sm bg-surface-2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

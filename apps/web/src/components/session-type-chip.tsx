import type { SessionType } from "@running-coach/shared";
import { cn } from "@/lib/cn";
import { sessionTypeBackground, sessionTypeName } from "@/lib/session-type";

/**
 * A session's type as a dot in its fixed type color beside its name: the plan's days and a race on the
 * run screen. The type-* colors appear only beside a type's name (web-ui rule), which this is. The name
 * takes the size and color of the line it sits in; the dot is the emphasis.
 */
export function SessionTypeChip({ type }: { type: SessionType }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={cn("size-3 shrink-0 rounded-sm", sessionTypeBackground(type))}
      />
      {sessionTypeName(type)}
    </span>
  );
}

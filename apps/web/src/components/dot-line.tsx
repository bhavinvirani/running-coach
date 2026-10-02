import { Children, isValidElement, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { PbChip } from "./pb-chip";
import { RunTypeChip } from "./run-type-chip";

type DotLineProps = {
  /** The items in order; null and false are left out with their dot. */
  children: ReactNode;
  /** Type size and color for the line: "text-caption text-ink-2". */
  className?: string;
};

/**
 * Short facts about a run on one line with a dot between them, "07:12 · Indoor", as flex items so a chip
 * sits centered among plain words. The gap spaces the dots, which a space would not do evenly beside a
 * chip's own dot; they are hidden from screen readers, which pause between the items anyway.
 * A chip leads with its own colored dot, which already separates it, so it gets a wider gap instead of
 * a "·": "07:12 ● Race ● 3 PBs" fits a Progress row's narrow column. A "·" is grouped with the item after
 * it, so a line that wraps carries "· Indoor" over whole instead of leaving a dot at a line's end.
 */
export function DotLine({ children, className }: DotLineProps) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-1.5", className)}>
      {Children.toArray(children).map((item, position) => {
        if (position === 0) return item;
        if (isChip(item)) {
          return (
            <span key={position} className="inline-flex pl-1.5">
              {item}
            </span>
          );
        }
        return (
          <span key={position} className="inline-flex items-center gap-x-1.5">
            <span aria-hidden="true">·</span>
            {item}
          </span>
        );
      })}
    </p>
  );
}

function isChip(item: ReactNode): boolean {
  return isValidElement(item) && (item.type === RunTypeChip || item.type === PbChip);
}

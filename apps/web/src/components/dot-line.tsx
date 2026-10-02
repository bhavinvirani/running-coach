import { Children, Fragment, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type DotLineProps = {
  /** The items in order; null and false are left out with their dot. */
  children: ReactNode;
  /** Type size and color for the line: "text-caption text-ink-2". */
  className?: string;
};

/**
 * Short facts about a run on one line with a dot between them, "07:12 · Race · Indoor", as flex items so
 * a chip sits centered among plain words. The gap spaces the dots, which a space would not do evenly
 * beside a chip's own dot; they are hidden from screen readers, which pause between the items anyway.
 */
export function DotLine({ children, className }: DotLineProps) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-1.5", className)}>
      {Children.toArray(children).map((item, position) => (
        <Fragment key={position}>
          {position > 0 ? <span aria-hidden="true">·</span> : null}
          {item}
        </Fragment>
      ))}
    </p>
  );
}

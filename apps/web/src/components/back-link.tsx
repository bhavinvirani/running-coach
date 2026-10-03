import { ChevronLeft } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";

type BackLinkProps = {
  /** Where Back goes when the screen was opened from a link or bookmark: the list the screen belongs to. */
  to: string;
};

/**
 * Back, top left of a detail screen. A screen opened from inside the app returns where it came from, with
 * its scroll and loaded data; one opened from a link or bookmark has no earlier entry in the app (React
 * Router keys only that first entry "default"), so Back goes to `to`: Progress for a run, Plan for a week.
 */
export function BackLink({ to }: BackLinkProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const canGoBack = location.key !== "default";

  return (
    <Link
      to={to}
      onClick={(event) => {
        if (!canGoBack) return;
        event.preventDefault();
        void navigate(-1);
      }}
      className="absolute top-0 left-0 -ml-2 flex min-h-11 min-w-11 items-center gap-1 rounded-sm pr-2 text-body text-ink"
    >
      <ChevronLeft aria-hidden="true" className="size-5" strokeWidth={1.75} />
      Back
    </Link>
  );
}

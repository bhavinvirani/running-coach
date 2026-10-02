import type { ImportProgress } from "@running-coach/shared";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { importAction, importLine, progressCopy } from "../progress-copy";

type ImportStatusProps = {
  progress: ImportProgress;
  timeZone: string;
  starting: boolean;
  startError: Error | null;
  onStart: () => void;
};

/**
 * Where the full-history import stands, in one line, with the one action its status allows. A stopped
 * import reads as an error sentence; a finished one shrinks to a caption with a quiet Import again.
 */
export function ImportStatus({
  progress,
  timeZone,
  starting,
  startError,
  onStart,
}: ImportStatusProps) {
  const line = importLine(progress, timeZone);
  const action = importAction(progress.status);
  const stopped = progress.status === "failed" || progress.status === "stalled";

  return (
    <section aria-label={progressCopy.importRegion} className="flex flex-col gap-3">
      {progress.status === "done" ? (
        <div className="flex items-center justify-between gap-4">
          <p className="text-caption text-ink-2">{line}</p>
          {action ? (
            <Button variant="ghost" disabled={starting} aria-busy={starting} onClick={onStart}>
              {action}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3">
          {stopped ? (
            <p role="alert" className="text-body text-ink">
              {line}
            </p>
          ) : (
            <p className="text-body text-ink-2">{line}</p>
          )}
          {action ? (
            <Button disabled={starting} aria-busy={starting} onClick={onStart}>
              {action}
            </Button>
          ) : null}
        </div>
      )}
      {startError ? <StartImportError error={startError} /> : null}
    </section>
  );
}

/** A failed POST /api/import, under the button that sent it; tapping the button again is the retry. */
export function StartImportError({ error }: { error: Error }) {
  return (
    <p role="alert" className="text-body text-ink">
      {errorMessage(error)}
    </p>
  );
}

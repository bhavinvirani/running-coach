import { useEffect, useState } from "react";

/** Longer than a normal start; Render's wake after 15 minutes idle takes up to a minute. */
const WAKING_AFTER_MS = 3_000;

/**
 * Shown while the first route loads: blank on a normal start, then one sentence on why it is slow. No
 * spinner. The live region is there from the start so screen readers announce the sentence when it appears,
 * and nothing around it is aria-busy, which would hold that announcement back.
 */
export function AppPending() {
  const [waking, setWaking] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setWaking(true), WAKING_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="min-h-dvh bg-surface-0 px-4 pt-safe">
      <p role="status" className="mx-auto max-w-lg pt-12 text-body text-ink-2">
        {waking ? "Waking the server. After 15 minutes idle this takes up to a minute." : null}
      </p>
    </div>
  );
}

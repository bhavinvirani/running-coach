import type { ActivityDetail, CoachFeedback } from "@running-coach/shared";
import { useEffect, useRef } from "react";
import { useActivity, useFetchActivityDetail } from "@/api/activities";
import { useAskCoach, useInsight, useInsightFeedback } from "@/api/insights";
import { useSettings } from "@/api/me";
import { screenState } from "@/api/screen-state";

/** The laps, samples, route and zones below the stats, which load on their own after the run. */
export type DetailState =
  | { status: "pending" }
  | { status: "error"; error: Error }
  | { status: "success"; detail: ActivityDetail };

/**
 * Everything the run screen reads and does. The stored run comes first; when it has no detail yet, the
 * screen asks the API to fetch it from Garmin, once: the ref keeps a re-render, a background reload of the
 * run or StrictMode's second effect from asking again, and only Retry repeats a failed fetch. The screen is
 * keyed by run id, so a new run starts with a fresh ref. Units come from /api/me, which the authenticated
 * loader caches before any screen renders. The coach card loads beside the run, not after it.
 */
export function useRunScreen(id: string) {
  const run = useActivity(id);
  const settings = useSettings();
  const fetchDetail = useFetchActivityDetail(id);
  const insight = useInsight(id);
  const ask = useAskCoach(id);
  const feedback = useInsightFeedback(id);
  const { mutate } = fetchDetail;
  const state = screenState(run);

  const stored = state.status === "success" ? state.data.detail : undefined;
  // The fetched detail also covers a reload of the run that started before the fetch stored it.
  const detail = stored ?? fetchDetail.data?.detail ?? null;
  const needsDetail = stored === null && detail === null;

  const requested = useRef(false);
  useEffect(() => {
    if (!needsDetail || requested.current) return;
    requested.current = true;
    mutate();
  }, [needsDetail, mutate]);

  const detailState: DetailState = detail
    ? { status: "success", detail }
    : fetchDetail.isError
      ? { status: "error", error: fetchDetail.error }
      : { status: "pending" };

  return {
    ...state,
    units: settings.data?.units,
    detail: detailState,
    retryDetail: () => mutate(),
    coach: {
      state: screenState(insight),
      // Unknown only before /api/me loads: offer Try again, and a 409 swaps it for Add Claude key. The
      // owner on the Claude plan has a credential without a saved key.
      hasCredential: settings.data?.coachCredential !== "none",
      asking: ask.isPending,
      askError: ask.error,
      ask: () => ask.mutate(),
      feedbackError: feedback.error,
      setFeedback: (insightId: string, value: CoachFeedback | null) =>
        feedback.mutate({ insightId, feedback: value }),
    },
  };
}

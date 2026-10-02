import { importProgressSchema, type ImportProgress } from "@running-coach/shared";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { activityWeeksKey } from "./activities";
import { apiFetch } from "./client";
import { detailKey, resourceKey } from "./query-keys";

const importKey = detailKey("import");

/** How often the import is polled: often while it moves, rarely while Garmin's 429 pause runs out. */
export const IMPORT_POLL_RUNNING_MS = 3_000;
export const IMPORT_POLL_PAUSED_MS = 60_000;

export function importPollInterval(progress: ImportProgress | undefined): number | false {
  if (progress?.status === "running") return IMPORT_POLL_RUNNING_MS;
  if (progress?.status === "paused") return IMPORT_POLL_PAUSED_MS;
  return false;
}

/** True when the runs on screen may be out of date: the import stored runs, or it just finished. */
export function importChangedRuns(previous: ImportProgress, next: ImportProgress): boolean {
  if (next.runsStored !== previous.runsStored) return true;
  return next.status === "done" && previous.status !== "done";
}

/**
 * Refreshes every list and detail of runs, Today's latest run among them; inactive ones refetch on mount.
 * invalidateQueries cancels a fetch in flight and refetches only the pages already loaded, which would drop
 * a "Show earlier weeks" page still loading, so that page lands first. Its failure, if any, is the weeks
 * query's to show.
 */
async function refreshRuns(client: QueryClient): Promise<void> {
  const weeks = client.getQueryCache().find({ queryKey: activityWeeksKey, exact: true });
  if (weeks?.state.fetchStatus === "fetching") await weeks.promise?.catch(() => undefined);
  await client.invalidateQueries({ queryKey: resourceKey("activities") });
}

/**
 * GET /api/import. The comparison with the cached progress lives in the fetch rather than an effect, so it
 * runs once per poll however many components read the import, and sees what POST /api/import put there.
 */
export function importProgressQueryOptions() {
  return queryOptions({
    queryKey: importKey,
    queryFn: async ({ client, queryKey, signal }) => {
      const previous = client.getQueryData<ImportProgress>(queryKey);
      const progress = await apiFetch("/api/import", { schema: importProgressSchema, signal });
      if (previous !== undefined && importChangedRuns(previous, progress)) void refreshRuns(client);
      return progress;
    },
  });
}

/** The full-history import, polled while it runs or waits out a Garmin 429; not polled otherwise. */
export function useImportProgress() {
  return useQuery({
    ...importProgressQueryOptions(),
    refetchInterval: (query) => importPollInterval(query.state.data),
  });
}

/**
 * POST /api/import: starts an import, resumes a failed or stalled one, and changes nothing while one runs.
 * It answers with the whole progress, so the cache takes it as is and polling starts from there. Never
 * retried: the runner decides when to try again.
 */
export function useStartImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/api/import", { method: "POST", schema: importProgressSchema }),
    onSuccess: (progress) => queryClient.setQueryData(importKey, progress),
  });
}

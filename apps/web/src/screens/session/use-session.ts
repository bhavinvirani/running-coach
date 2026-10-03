import { useLocation, useNavigate } from "react-router";
import { useSendToGarmin } from "@/api/calendar";
import { useSettings } from "@/api/me";
import { screenState } from "@/api/screen-state";
import { useMoveSession, useSession, useSkipSession } from "@/api/sessions";
import type { SendState } from "@/components/garmin-push-line";
import { today } from "@/lib/dates";
import type { MoveState, SkipState } from "./parts/session-actions";

/**
 * Everything the session screen reads and does: the session with its paces and push status (read again
 * every few seconds while a push runs), the units and today from /api/me, Send to Garmin, Move and
 * Skip session or Delete workout. A deleted custom workout leaves the calendar and the plan, so the screen
 * goes back to where the runner came from instead of showing it skipped.
 */
export function useSessionScreen(id: string) {
  const session = useSession(id);
  const settings = useSettings();
  const send = useSendToGarmin();
  const move = useMoveSession(id);
  const skip = useSkipSession(id);
  const navigate = useNavigate();
  const location = useLocation();
  const canGoBack = location.key !== "default";

  return {
    ...screenState(session),
    units: settings.data?.units,
    today: settings.data === undefined ? undefined : today(settings.data.timezone),
    send: {
      sending: send.isPending,
      error: send.error,
      onSend: () => send.mutate(),
    } satisfies SendState,
    move: {
      moving: move.isPending,
      error: move.error,
      warning: move.data?.warning
        ? { date: move.data.session.date, warning: move.data.warning }
        : null,
      onMove: (date: string, onMoved: () => void) => move.mutate(date, { onSuccess: onMoved }),
    } satisfies MoveState,
    skip: {
      skipping: skip.isPending,
      error: skip.error,
      onSkip: () =>
        skip.mutate(undefined, {
          onSuccess: ({ session: skipped }) => {
            if (skipped.source !== "custom") return;
            if (canGoBack) void navigate(-1);
            else void navigate("/plan", { replace: true });
          },
        }),
    } satisfies SkipState,
  };
}

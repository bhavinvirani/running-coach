import { ErrorCode, type GarminPushStatus } from "@running-coach/shared";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { errorCodeMessage, errorMessage } from "@/lib/errors";

/** Send to Garmin as a screen holds it. */
export type SendState = {
  /** Its own request is in flight. */
  sending: boolean;
  /** Its own request failed. */
  error: Error | null;
  onSend: () => void;
};

type GarminPushLineProps = {
  garmin: GarminPushStatus;
  send: SendState;
  /**
   * Say why nothing goes out while the login is expired. Today leaves it out: its header already swaps
   * Sync now for Reconnect Garmin with that sentence, reading /api/me again when the calendar learns first.
   */
  explainExpired?: boolean;
};

/**
 * Where sending workouts to Garmin stands, as one line under a heading, and the one way to send by hand.
 * The app sends on every change and every day by itself, so "Send to Garmin" is a retry and a nudge, never
 * a required step. Today's next 7 days and the session screen show it.
 */
export function GarminPushLine({ garmin, send, explainExpired = false }: GarminPushLineProps) {
  const { sending, error: sendError, onSend } = send;
  if (garmin.connection === "not_connected") {
    return (
      <p className="text-body text-ink-2">
        Connect Garmin in{" "}
        <Link to="/settings" className="font-semibold text-ink underline">
          Settings
        </Link>{" "}
        to send these workouts to your watch.
      </p>
    );
  }

  if (garmin.connection === "expired") {
    return explainExpired ? (
      <p className="text-body text-ink-2">{errorCodeMessage(ErrorCode.garminAuthExpired)}</p>
    ) : null;
  }

  if (sending || garmin.pushing) {
    return (
      <p role="status" className="text-body text-ink-2">
        Sending workouts to Garmin.
      </p>
    );
  }

  const sendButton = (
    <Button variant="secondary" className="self-start" onClick={onSend}>
      Send to Garmin
    </Button>
  );
  const failure = sendError
    ? errorMessage(sendError)
    : garmin.error
      ? errorCodeMessage(garmin.error)
      : null;
  if (failure === null) return sendButton;

  return (
    <div className="flex flex-col items-start gap-2">
      <p role="alert" className="text-body text-ink">
        {failure}
      </p>
      {sendButton}
    </div>
  );
}

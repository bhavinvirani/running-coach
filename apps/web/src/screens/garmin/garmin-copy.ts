import { ErrorCode, type DisconnectGarminQuery, type GarminStatus } from "@running-coach/shared";
import { isApiError } from "@/api/client";
import { errorMessage } from "@/lib/errors";
import { formatCount } from "@/lib/format";

/** Sentences on the Garmin screen, so the wording is read and changed in one place. */
export const garminCopy = {
  title: "Garmin",
  loading: "Loading Garmin",
  status: "Status",
  lastSync: "Last sync",
  never: "Never",
  connectIntro:
    "Connect your Garmin account to bring in your runs and send your plan's workouts to your watch.",
  reconnectIntro:
    "Garmin ended this login. Sign in again to bring in your runs and send workouts to your watch.",
  email: "Email",
  password: "Password",
  passwordHelp: "Sent to Garmin to sign in. The app never stores it.",
  codeSent: "Garmin sent you a sign-in code by email or text. Type it here within 5 minutes.",
  code: "Code",
  // The code step keeps the verb: it finishes the same connect, so a new verb ("Verify") would read as a
  // separate action (web-ui.md: the same verb stays through the flow).
  // done is the line the flow ends with, in its own verb: a reconnect says reconnected.
  connect: { idle: "Connect Garmin", pending: "Connecting Garmin…", done: "Garmin connected." },
  reconnect: {
    idle: "Reconnect Garmin",
    pending: "Reconnecting Garmin…",
    done: "Garmin reconnected.",
  },
  startAgain: "Start again",
  badEmail: "Type the email you sign in to Garmin with.",
  badCode: "Type the code Garmin sent: 4 to 10 digits.",
  loginRateLimited:
    "Garmin is limiting sign-ins. Wait about an hour, then try again, or connect from your laptop with pnpm garmin:connect.",
  disconnect: { idle: "Disconnect Garmin", pending: "Disconnecting Garmin…" },
  disconnectQuestion:
    "Disconnect Garmin? The app stops bringing in runs and sending workouts. Your runs and plan stay here.",
  // Upcoming: the API takes off only the sessions from today on that are still to run (planned, moved or
  // skipped); a done or missed session keeps its workout on Garmin.
  removeWorkouts: "Also remove this app's upcoming workouts from Garmin",
  keepOnly: "Workouts this app sent stay on Garmin: removing them needs a working login.",
  removing: "Removing this app's upcoming workouts from Garmin. This can take a minute.",
  removalNeedsLogin:
    "Removing workouts needs a working Garmin login, and this one has expired. Disconnect without removing them, or reconnect first.",
  cancel: "Cancel",
} as const;

/** The Status row's value. */
export const garminStatusLabels: Record<GarminStatus, string> = {
  ok: "Connected",
  expired: "Login expired",
  not_connected: "Not connected",
};

/** Why a sign-in failed. Garmin's 429 on a sign-in holds for about an hour, and the laptop CLI is the way round. */
export function loginErrorMessage(error: unknown): string {
  if (isApiError(error) && !error.network && error.code === ErrorCode.garminRateLimited) {
    return garminCopy.loginRateLimited;
  }
  return errorMessage(error);
}

/** The line a disconnect leaves: what happened to the workouts the app had sent. */
export function disconnectedLine(
  workouts: DisconnectGarminQuery["workouts"],
  removedWorkouts: number,
): string {
  if (workouts === "keep") return "Garmin disconnected. Workouts this app sent stay on Garmin.";
  if (removedWorkouts === 0) {
    return "Garmin disconnected. No upcoming workouts from this app were on Garmin.";
  }
  return `Garmin disconnected. Removed ${formatCount(removedWorkouts, "upcoming workout", "upcoming workouts")} this app made from Garmin.`;
}

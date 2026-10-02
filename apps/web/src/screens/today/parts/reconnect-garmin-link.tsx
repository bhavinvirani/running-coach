import { Link } from "react-router";
import { Button } from "@/components/ui/button";

/**
 * Sync now's stand-in while the Garmin login is expired: syncing would only fail again, and Settings says
 * how to reconnect.
 */
export function ReconnectGarminLink() {
  return (
    <Button asChild variant="secondary">
      <Link to="/settings">Reconnect Garmin</Link>
    </Button>
  );
}

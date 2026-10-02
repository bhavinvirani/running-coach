import { Button } from "@/components/ui/button";

/** The one way to pull runs from Garmin by hand. While it runs it says so, and a second tap does nothing. */
export function SyncNowButton({ syncing, onSync }: { syncing: boolean; onSync: () => void }) {
  return (
    <Button disabled={syncing} aria-busy={syncing} onClick={onSync}>
      {syncing ? "Syncing…" : "Sync now"}
    </Button>
  );
}

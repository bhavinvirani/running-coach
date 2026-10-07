import { DetailLayout } from "@/components/detail-header";
import { LoadError } from "@/components/load-error";
import { RetryAlert } from "@/components/retry-alert";
import { cn } from "@/lib/cn";
import { ClaudeKeySection } from "./parts/claude-key-section";
import { useClaudeScreen } from "./use-claude";

const TITLE = "Claude";

/**
 * What the coach runs on, at /settings/claude: the runner's Claude API key, or for the owner a choice of
 * the Claude plan first. The run's coach card opens it to add or replace a key. No empty state: without a
 * key the screen is the form that adds one.
 */
export function ClaudeScreen() {
  const screen = useClaudeScreen();
  const { data, status, error, refetch } = screen;

  if (status === "pending") {
    return (
      <DetailLayout title={TITLE} backTo="/settings" busy>
        <ClaudeKeySkeleton />
      </DetailLayout>
    );
  }

  if (status === "error") {
    return (
      <DetailLayout title={TITLE} backTo="/settings">
        <LoadError error={error} onRetry={() => void refetch()} />
      </DetailLayout>
    );
  }

  return (
    <DetailLayout title={TITLE} backTo="/settings">
      {screen.refetchError ? (
        <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
      ) : null}
      <ClaudeKeySection
        hasKey={data.settings.hasClaudeKey}
        credential={
          data.settings.claudePlanAvailable
            ? {
                // Without a key the coach uses nothing (none), and the key form is what to fill in.
                choice:
                  screen.coachCredential.pending ??
                  (data.settings.coachCredential === "plan" ? "plan" : "key"),
                error: screen.coachCredential.error,
                choose: screen.coachCredential.choose,
              }
            : undefined
        }
        {...screen.claudeKey}
      />
    </DetailLayout>
  );
}

/**
 * The Claude key card as it loads without a key: the title, the field's label, the field, the helper text's
 * two lines at 390 px, then Save key. Each block sits in a box at its text's line height, as in the card.
 */
function ClaudeKeySkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading Claude"
      className="rounded-md border border-line bg-surface-1 px-4 pb-4"
    >
      <div className="mt-4 flex h-5.5 items-center">
        <div className="h-4 w-24 rounded-sm bg-surface-2" />
      </div>
      <div className="flex flex-col gap-2 py-4">
        <div className="flex h-5.5 items-center">
          <div className="h-4 w-28 rounded-sm bg-surface-2" />
        </div>
        <div className="h-11 rounded-sm border border-line bg-surface-0" />
        <div>
          {["w-full", "w-1/2"].map((width) => (
            <div key={width} className="flex h-4 items-center">
              <div className={cn("h-3 rounded-sm bg-surface-2", width)} />
            </div>
          ))}
        </div>
      </div>
      <div className="h-11 w-24 rounded-sm bg-surface-2" />
    </div>
  );
}

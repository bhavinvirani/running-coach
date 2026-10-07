import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { CardSection } from "@/components/card-section";
import { SettingsRow } from "@/components/settings-card";

type AccountSectionProps = {
  email: string;
  onLogOut: () => void;
  loggingOut: boolean;
  logOutError: unknown;
};

/** The account under Settings' list cards, on the same card: heading above, email, then Log out. */
export function AccountSection({ email, onLogOut, loggingOut, logOutError }: AccountSectionProps) {
  return (
    <CardSection title="Account">
      <SettingsRow label="Email">{email}</SettingsRow>
      <div className="flex flex-col items-start gap-3 py-4">
        {logOutError ? (
          <p role="alert" className="text-body text-ink">
            {errorMessage(logOutError)}
          </p>
        ) : null}
        <Button variant="secondary" disabled={loggingOut} onClick={onLogOut}>
          Log out
        </Button>
      </div>
    </CardSection>
  );
}

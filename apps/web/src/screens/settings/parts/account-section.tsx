import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { SettingsCard, SettingsRow } from "@/components/settings-card";

type AccountSectionProps = {
  email: string;
  onLogOut: () => void;
  loggingOut: boolean;
  logOutError: unknown;
};

export function AccountSection({ email, onLogOut, loggingOut, logOutError }: AccountSectionProps) {
  return (
    <SettingsCard title="Account">
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
    </SettingsCard>
  );
}

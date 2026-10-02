import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { Row, Section } from "./section";

type AccountSectionProps = {
  email: string;
  onLogOut: () => void;
  loggingOut: boolean;
  logOutError: unknown;
};

export function AccountSection({ email, onLogOut, loggingOut, logOutError }: AccountSectionProps) {
  return (
    <Section title="Account">
      <Row label="Email">{email}</Row>
      <div className="flex flex-col items-start gap-3 py-4">
        {logOutError ? (
          <p role="alert" className="text-body text-bad">
            {errorMessage(logOutError)}
          </p>
        ) : null}
        <Button variant="secondary" disabled={loggingOut} onClick={onLogOut}>
          Log out
        </Button>
      </div>
    </Section>
  );
}

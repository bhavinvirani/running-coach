import { ErrorCode, garminEmailSchema, garminMfaCodeSchema } from "@running-coach/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isApiError } from "@/api/client";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/ui/button";
import { garminCopy, loginErrorMessage } from "../garmin-copy";
import type { LoginActions } from "../use-garmin";

type ConnectFormProps = {
  /** reconnect while the login is expired: the same form, named for what it does then. */
  mode: "connect" | "reconnect";
  login: LoginActions;
  /** A sign-in is going out, so the line the last connect or disconnect left no longer applies. */
  onStart: () => void;
  onConnected: () => void;
};

/**
 * Signing in to Garmin in two steps: email and password, then the code Garmin sends when it asks for one.
 * The password is let go of once Garmin has it (the code step, or connected), and the code once it is
 * used; neither goes in the URL, storage or a cache. A wrong code keeps the code step, since the same
 * pending login takes another; a lost one (5 min, a restart, too many codes) goes back to step 1 with the
 * email kept. Each swap of fields moves focus to the field to type in next.
 */
export function ConnectForm({ mode, login, onStart, onConnected }: ConnectFormProps) {
  const [step, setStep] = useState<"credentials" | "code">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const passwordField = useRef<HTMLInputElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  // Set with the swap, so only a step the runner caused moves focus, never a refetch.
  const focusAfterSwap = useRef<"password" | "code" | null>(null);
  const { pending } = login;
  const verb = mode === "connect" ? garminCopy.connect : garminCopy.reconnect;

  useEffect(() => {
    const wanted = focusAfterSwap.current;
    const target =
      wanted === "password" ? passwordField.current : wanted === "code" ? codeField.current : null;
    if (target === null) return;
    focusAfterSwap.current = null;
    target.focus();
  });

  const backToCredentials = () => {
    focusAfterSwap.current = "password";
    setPassword("");
    setCode("");
    setStep("credentials");
  };

  const submitCredentials = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const checkedEmail = garminEmailSchema.safeParse(email.trim());
    if (!checkedEmail.success) {
      setProblem(garminCopy.badEmail);
      return;
    }
    setProblem(null);
    onStart();
    login.start(
      { email: checkedEmail.data, password },
      {
        onSuccess: (answer) => {
          setPassword("");
          if (answer.status === "connected") {
            onConnected();
            return;
          }
          focusAfterSwap.current = "code";
          setStep("code");
        },
        // The password stays, so a typo can be fixed in place.
        onError: (error) => setProblem(loginErrorMessage(error)),
      },
    );
  };

  const submitCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    // Codes are often read out in groups ("123 456"); Garmin takes the digits alone.
    const checkedCode = garminMfaCodeSchema.safeParse(code.replace(/\s/g, ""));
    if (!checkedCode.success) {
      setProblem(garminCopy.badCode);
      return;
    }
    setProblem(null);
    login.finish(
      { mfaCode: checkedCode.data },
      {
        onSuccess: () => {
          setCode("");
          onConnected();
        },
        onError: (error) => {
          if (isApiError(error) && error.code === ErrorCode.garminLoginLost) backToCredentials();
          setProblem(loginErrorMessage(error));
        },
      },
    );
  };

  const alert = problem ? (
    <p role="alert" className="text-body text-ink">
      {problem}
    </p>
  ) : null;

  if (step === "code") {
    return (
      <form onSubmit={submitCode} noValidate className="flex flex-col pb-4">
        <p className="pt-4 text-body text-ink-2">{garminCopy.codeSent}</p>
        <TextField
          ref={codeField}
          label={garminCopy.code}
          name="one-time-code"
          autoComplete="one-time-code"
          inputMode="numeric"
          spellCheck={false}
          autoCorrect="off"
          value={code}
          // Held while Garmin checks it, so the code on screen is the code being checked.
          readOnly={pending}
          onChange={(event) => setCode(event.target.value)}
        />
        <div className="flex flex-col items-start gap-3">
          {alert}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={pending || code.trim() === ""} aria-busy={pending}>
              {pending ? verb.pending : verb.idle}
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setProblem(null);
                backToCredentials();
              }}
            >
              {garminCopy.startAgain}
            </Button>
          </div>
          <LaptopConnectHelp />
        </div>
      </form>
    );
  }

  // noValidate on both steps: what is wrong shows as the screen's own sentence (badEmail, badCode) in the
  // alert under the form, not as the browser's bubble.
  return (
    <form onSubmit={submitCredentials} noValidate className="flex flex-col pb-4">
      <p className="pt-4 text-body text-ink-2">
        {mode === "connect" ? garminCopy.connectIntro : garminCopy.reconnectIntro}
      </p>
      <TextField
        label={garminCopy.email}
        type="email"
        name="email"
        autoComplete="username"
        inputMode="email"
        autoCapitalize="off"
        spellCheck={false}
        value={email}
        readOnly={pending}
        onChange={(event) => setEmail(event.target.value)}
      />
      <TextField
        ref={passwordField}
        label={garminCopy.password}
        type="password"
        name="password"
        autoComplete="current-password"
        description={garminCopy.passwordHelp}
        value={password}
        readOnly={pending}
        onChange={(event) => setPassword(event.target.value)}
      />
      <div className="flex flex-col items-start gap-3">
        {alert}
        <Button
          type="submit"
          disabled={pending || email.trim() === "" || password === ""}
          aria-busy={pending}
        >
          {pending ? verb.pending : verb.idle}
        </Button>
        <LaptopConnectHelp />
      </div>
    </form>
  );
}

/**
 * The way round a sign-in Garmin will not take from this server (a 429, a blocked datacenter address).
 * Static copy: printing the page's own address would make the screenshot depend on the host.
 */
function LaptopConnectHelp() {
  return (
    <p className="text-caption text-ink-2">
      If signing in here does not work, run <code>pnpm garmin:connect</code> with this app&apos;s
      address on your laptop.
    </p>
  );
}

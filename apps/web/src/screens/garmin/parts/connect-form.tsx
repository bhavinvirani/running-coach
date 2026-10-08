import { garminEmailSchema, garminMfaCodeSchema } from "@running-coach/shared";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { codeFailureKeepsLogin, stillWaits } from "@/api/garmin";
import { CardSection } from "@/components/card-section";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/ui/button";
import { garminSignInErrorMessage } from "@/lib/errors";
import { garminCopy } from "../garmin-copy";
import type { LoginActions } from "../use-garmin";

type ConnectFormProps = {
  /** reconnect while the login is expired: the same form, named for what it does then. */
  mode: "connect" | "reconnect";
  login: LoginActions;
  /** A sign-in is going out, so the line the last connect or disconnect left no longer applies. */
  onStart: () => void;
  /** The line the flow ends with, in its verb: "Garmin connected." or "Garmin reconnected.". */
  onConnected: (line: string) => void;
};

type Step = "credentials" | "code";

/**
 * Signing in to Garmin in two steps: email and password, then the code Garmin sends when it asks for one.
 * The password is let go of once Garmin has it (the code step, or connected), and the code once it is
 * used; neither goes in the URL, storage or a cache. A failed code keeps the code step only while the
 * Garmin service may still hold the login (codeFailureKeepsLogin: a wrong code, Garmin out of reach, no
 * answer, the app's own limit); anything else (Garmin's 429, a lost login, the proof of the login failing)
 * goes back to step 1 with the email kept and the error's sentence. The step follows the login in the
 * mutation cache too, so the form opened again after Garmin sent the code (or while the start was out)
 * opens on the code step. Each swap of fields moves focus to the field to type in next. The fields sit in
 * the Sign in card, with the error, the button and the laptop fallback under it, as on the goal form.
 */
export function ConnectForm({ mode, login, onStart, onConnected }: ConnectFormProps) {
  const [step, setStep] = useState<Step>(() =>
    login.waiting !== null && stillWaits(login.waiting) ? "code" : "credentials",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const passwordField = useRef<HTMLInputElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  const codeSentId = useId();
  const { pending } = login;
  const verb = mode === "connect" ? garminCopy.connect : garminCopy.reconnect;

  // A login that starts or stops waiting for its code moves the step, also when the answer came after the
  // form was left and opened again, where the callbacks of the request sent before never run. The 5 min
  // are checked only as the form opens: on the code step, the code's own answer says the login ran out.
  const waitingId = login.waiting?.id ?? null;
  const [followedId, setFollowedId] = useState(waitingId);
  if (waitingId !== followedId) {
    setFollowedId(waitingId);
    setCode("");
    if (waitingId === null) {
      setStep("credentials");
    } else {
      setPassword("");
      setStep("code");
    }
  }

  // Only a swap moves focus, never the first render or a refetch: to the field to type in next.
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    (step === "code" ? codeField : passwordField).current?.focus();
  }, [step]);

  const backToCredentials = () => {
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
            onConnected(verb.done);
            return;
          }
          setStep("code");
        },
        // The password stays, so a typo can be fixed in place.
        onError: (error) => setProblem(garminSignInErrorMessage(error)),
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
          onConnected(verb.done);
        },
        onError: (error) => {
          if (!codeFailureKeepsLogin(error)) backToCredentials();
          setProblem(garminSignInErrorMessage(error));
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
      <form onSubmit={submitCode} noValidate className="flex flex-col gap-4">
        <CardSection title={garminCopy.signIn}>
          <p id={codeSentId} className="py-4 text-body text-ink-2">
            {garminCopy.codeSent}
          </p>
          <TextField
            ref={codeField}
            label={garminCopy.code}
            // Focus lands here on the swap, so the sentence above says what the code is.
            aria-describedby={codeSentId}
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
        </CardSection>
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
                login.forget();
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
  // alert under the card, not as the browser's bubble.
  return (
    <form onSubmit={submitCredentials} noValidate className="flex flex-col gap-4">
      <CardSection title={garminCopy.signIn}>
        <p className="py-4 text-body text-ink-2">
          {mode === "connect" ? garminCopy.connectIntro : garminCopy.reconnectIntro}
        </p>
        {/* A third party's credential on this app's origin, where the app's own login uses username
            and current-password: with those tokens password managers would offer the app's saved login
            here and offer to overwrite its password with the Garmin one. So no tokens, names that do not
            read as this site's login, and the extensions' opt-outs, as for the Claude key. */}
        <TextField
          label={garminCopy.email}
          type="email"
          name="garmin-email"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
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
          name="garmin-password"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          description={garminCopy.passwordHelp}
          value={password}
          readOnly={pending}
          onChange={(event) => setPassword(event.target.value)}
        />
      </CardSection>
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

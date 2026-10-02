import { useState, type ComponentProps, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useLogIn } from "@/api/session";
import { Button } from "@/components/ui/button";
import { logInErrorMessage } from "@/lib/errors";

/** Email and password only: sign-up is off and the owner account is seeded from the CLI. */
export function LoginScreen() {
  const navigate = useNavigate();
  const logIn = useLogIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    logIn.mutate(
      { email: email.trim(), password },
      { onSuccess: () => void navigate("/", { replace: true }) },
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-8 px-4 pt-safe">
      <h1 className="pt-12 text-title text-ink">Running Coach</h1>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {logIn.error ? (
          <p role="alert" className="text-body text-ink">
            {logInErrorMessage(logIn.error)}
          </p>
        ) : null}
        <Button type="submit" size="lg" className="mt-2 w-full" disabled={logIn.isPending}>
          {logIn.isPending ? "Logging in" : "Log in"}
        </Button>
      </form>
    </main>
  );
}

function TextField({ label, ...input }: { label: string } & ComponentProps<"input">) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-body text-ink-2">{label}</span>
      <input
        className="h-12 w-full rounded-sm border border-line bg-surface-1 px-3 text-body text-ink"
        {...input}
      />
    </label>
  );
}

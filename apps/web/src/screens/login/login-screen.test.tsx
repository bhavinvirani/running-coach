import { ErrorCode } from "@running-coach/shared";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { errorMessages, networkErrorMessage } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import { signInFixture } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { LoginScreen } from "./login-screen";

async function logIn(email = "runner@example.com", password = "correct horse") {
  await userEvent.type(screen.getByLabelText("Email"), email);
  await userEvent.type(screen.getByLabelText("Password"), password);
  await userEvent.click(screen.getByRole("button", { name: "Log in" }));
}

describe("LoginScreen", () => {
  it("shows email, password and Log in, and no sign-up link", () => {
    stubFetch(notFound);
    renderScreen(<LoginScreen />, { path: "/login" });
    expect(screen.getByRole("heading", { name: "Running Coach" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("signs in with the trimmed email and goes to Today", async () => {
    const calls = stubFetch(({ path }) =>
      path === "/api/auth/sign-in/email" ? json(signInFixture()) : notFound(),
    );
    const { router } = renderScreen(<LoginScreen />, { path: "/login" });

    await logIn("  runner@example.com ", "correct horse");

    expect(await screen.findByText("Route not under test")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/auth/sign-in/email",
      body: { email: "runner@example.com", password: "correct horse" },
    });
    // Through apiFetch like every other call, so the API logs can be matched to this tap.
    expect(calls[0]?.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("says the credentials are wrong on a 401 and stays on the form", async () => {
    stubFetch(() => problem(401, ErrorCode.unauthorized, { detail: "Invalid email or password" }));
    const { router } = renderScreen(<LoginScreen />, { path: "/login" });

    await logIn();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email or password is wrong. Check both and try again.",
    );
    expect(router.state.location.pathname).toBe("/login");
  });

  it("explains rate limiting from the shared messages", async () => {
    stubFetch(() => problem(429, ErrorCode.rateLimited, { retryAfterSeconds: 42 }));
    renderScreen(<LoginScreen />, { path: "/login" });
    await logIn();
    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.rate_limited);
  });

  it("explains a network failure", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    renderScreen(<LoginScreen />, { path: "/login" });
    await logIn();
    expect(await screen.findByRole("alert")).toHaveTextContent(networkErrorMessage);
  });

  it("disables the button while signing in", async () => {
    stubFetch(never);
    renderScreen(<LoginScreen />, { path: "/login" });
    await logIn();
    expect(await screen.findByRole("button", { name: "Logging in" })).toBeDisabled();
  });
});

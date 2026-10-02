import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { errorMessages, networkErrorMessage } from "@/lib/errors";
import { json, never, notFound, stubFetch } from "@/test/fake-api";
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

  it("signs in with the trimmed email and goes to Settings", async () => {
    const calls = stubFetch(({ path }) =>
      path === "/api/auth/sign-in/email" ? json({ redirect: false, token: "t" }) : notFound(),
    );
    const { router } = renderScreen(<LoginScreen />, { path: "/login" });

    await logIn("  runner@example.com ", "correct horse");

    expect(await screen.findByText("Route not under test")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings");
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/auth/sign-in/email",
      body: { email: "runner@example.com", password: "correct horse" },
    });
  });

  it("says the credentials are wrong on a 401 and stays on the form", async () => {
    stubFetch(() => json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid" }, 401));
    const { router } = renderScreen(<LoginScreen />, { path: "/login" });

    await logIn();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email or password is wrong. Check both and try again.",
    );
    expect(router.state.location.pathname).toBe("/login");
  });

  it("explains rate limiting from the shared messages", async () => {
    stubFetch(() => json({ message: "Too many requests" }, 429));
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

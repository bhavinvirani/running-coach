import { test as base, type APIRequestContext } from "@playwright/test";
import { resetRunner, runner, type Runner } from "./seed";

/**
 * Signs the runner in through Better Auth's endpoint. Given page.request, the session cookie lands in the
 * browser context's cookie jar, so the page is signed in without driving the login form.
 */
export async function signIn(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.post("/api/auth/sign-in/email", {
    data: { email: runner.email, password: runner.password },
    // What the browser sends; Better Auth checks it against APP_URL.
    headers: { origin },
  });
  if (response.status() === 429) {
    // Better Auth allows 10 sign-ins a minute per IP, and the whole suite signs in from one IP.
    throw new Error(
      "Sign-in was rate limited: more than 10 tests a minute signed in. Share one session per worker (storageState).",
    );
  }
  if (!response.ok()) {
    throw new Error(`Signing in the e2e runner failed with ${response.status()}`);
  }
}

/**
 * `login`: every test that imports `test` from here starts signed in as the seeded runner with default
 * settings. The fixture's value is the runner, for tests that assert on the email or name.
 */
export const test = base.extend<{ login: Runner }>({
  login: [
    // The second argument is Playwright's `use`; named `provide` so React's hook rules leave it alone.
    async ({ page, baseURL }, provide) => {
      if (!baseURL) throw new Error("playwright.config.ts must set use.baseURL");
      await signIn(page.request, baseURL);
      await resetRunner(page.request);
      await provide(runner);
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";

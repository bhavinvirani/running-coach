import { test as base, type APIRequestContext } from "@playwright/test";
import { resetRunner, runner, type Runner } from "./seed";

type StorageState = Awaited<ReturnType<APIRequestContext["storageState"]>>;

/** Signs the runner in through Better Auth's endpoint; the session cookie lands in `request`'s cookie jar. */
export async function signIn(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.post("/api/auth/sign-in/email", {
    data: { email: runner.email, password: runner.password },
    // What the browser sends; Better Auth checks it against APP_URL.
    headers: { origin },
  });
  if (response.status() === 429) {
    // Better Auth allows 10 sign-ins a minute per IP, and the whole suite signs in from one IP.
    throw new Error(
      "Sign-in was rate limited: more than 10 sign-ins a minute. Sign in once per worker, never per test.",
    );
  }
  if (!response.ok()) {
    throw new Error(`Signing in the e2e runner failed with ${response.status()}`);
  }
}

/**
 * Every test that imports `test` from here starts signed in as the seeded runner with default settings, no
 * runs and Garmin not connected; the `login` fixture's value is the runner, for tests that assert on the
 * email or name. Sign-in happens once per worker (`runnerSession`), so the suite stays under Better Auth's
 * 10 sign-ins a minute however many tests it has, and each test's fresh browser context starts from that
 * session's cookies (`storageState`). A test that logs out ends the shared session on the server: it must
 * use plain Playwright `test` and sign in itself, as login.spec.ts does.
 */
export const test = base.extend<{ login: Runner }, { runnerSession: StorageState }>({
  // The second argument is Playwright's `use`; named `provide` so React's hook rules leave it alone.
  runnerSession: [
    async ({ playwright }, provide, workerInfo) => {
      const { baseURL } = workerInfo.project.use;
      if (!baseURL) throw new Error("playwright.config.ts must set use.baseURL");
      const request = await playwright.request.newContext({ baseURL });
      let session: StorageState;
      try {
        await signIn(request, baseURL);
        session = await request.storageState();
      } finally {
        await request.dispose();
      }
      await provide(session);
    },
    { scope: "worker" },
  ],
  storageState: ({ runnerSession }, provide) => provide(runnerSession),
  login: [
    async ({ page }, provide) => {
      await resetRunner(page.request);
      await provide(runner);
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";

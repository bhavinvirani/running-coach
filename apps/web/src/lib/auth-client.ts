import { createAuthClient } from "better-auth/react";

/**
 * Better Auth on the same origin (`/api/auth/*`), so the session cookie is first-party everywhere,
 * including Safari and the installed PWA. Screens use the hooks in src/api/session.ts, not this client.
 */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  fetchOptions: {
    // better-fetch keeps the fetch it finds at creation; look it up per call so tests can stub it.
    customFetchImpl: (input, init) => fetch(input, init),
  },
});

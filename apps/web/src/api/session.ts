import {
  signInResponseSchema,
  signOutResponseSchema,
  type SignInRequest,
} from "@running-coach/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

/** Better Auth on the same origin: the session is a first-party cookie, also in Safari and the installed PWA. */
export function useLogIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credentials: SignInRequest) =>
      apiFetch("/api/auth/sign-in/email", {
        method: "POST",
        body: credentials,
        schema: signInResponseSchema,
      }),
    // Drop anything cached for a previous session, including the 401 that sent us here.
    onSuccess: () => queryClient.clear(),
  });
}

export function useLogOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch("/api/auth/sign-out", { method: "POST", body: {}, schema: signOutResponseSchema }),
    onSuccess: () => queryClient.clear(),
  });
}

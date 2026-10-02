import { ErrorCode } from "@running-coach/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { ApiError, codeForStatus } from "./client";

export type LogInRequest = { email: string; password: string };

type AuthResult = { error: { status: number; message?: string } | null };

/** Better Auth answers with its own error shape; turn it into the ApiError every screen understands. */
async function callAuth(run: () => Promise<AuthResult>): Promise<void> {
  let result: AuthResult;
  try {
    result = await run();
  } catch (error) {
    throw new ApiError({ status: 0, code: ErrorCode.internal, network: true, cause: error });
  }
  if (result.error) {
    throw new ApiError({
      status: result.error.status,
      code: codeForStatus(result.error.status),
      detail: result.error.message,
    });
  }
}

export function useLogIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }: LogInRequest) =>
      callAuth(() => authClient.signIn.email({ email, password })),
    // Drop anything cached for a previous session, including the 401 that sent us here.
    onSuccess: () => queryClient.clear(),
  });
}

export function useLogOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => callAuth(() => authClient.signOut()),
    onSuccess: () => queryClient.clear(),
  });
}

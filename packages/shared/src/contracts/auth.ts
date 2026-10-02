import { z } from "zod";

// Better Auth serves /api/auth/* and owns these response bodies. They are not .strict() on purpose: a
// Better Auth upgrade that adds a field must not break logging in. They pin only what the web app relies on;
// the session itself travels as an HttpOnly cookie.

/** POST /api/auth/sign-in/email */
export const signInRequestSchema = z
  .object({ email: z.email(), password: z.string().min(1) })
  .strict();
export type SignInRequest = z.infer<typeof signInRequestSchema>;

/** Response of POST /api/auth/sign-in/email. */
export const signInResponseSchema = z.object({ user: z.object({ id: z.uuid() }) });
export type SignInResponse = z.infer<typeof signInResponseSchema>;

/** Response of POST /api/auth/sign-out. */
export const signOutResponseSchema = z.object({ success: z.literal(true) });
export type SignOutResponse = z.infer<typeof signOutResponseSchema>;

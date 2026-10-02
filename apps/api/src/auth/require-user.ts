import { ErrorCode } from "@running-coach/shared";
import { fromNodeHeaders } from "better-auth/node";
import type { RequestHandler } from "express";
import { DomainError } from "../lib/errors";
import { auth } from "./auth";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's own types define Request in this global namespace; augmenting it is the documented way
  namespace Express {
    interface Request {
      /** Set by requireUser, which guards every /api router except /api/auth/*. */
      user: SessionUser;
    }
  }
}

/** 401 problem without a valid session; otherwise sets req.user from the session. */
export const requireUser: RequestHandler = async (req, res, next) => {
  const result = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
    returnHeaders: true,
  });
  if (!result.response) {
    throw new DomainError(ErrorCode.unauthorized, 401, "Sign in to continue.");
  }
  // Better Auth extends an active session after updateAge; pass its refreshed cookie on.
  const cookies = result.headers.getSetCookie();
  if (cookies.length > 0) res.append("set-cookie", cookies);
  const { id, email, name } = result.response.user;
  req.user = { id, email, name };
  next();
};

import { ErrorCode } from "@running-coach/shared";
import { Router } from "express";
import { sendProblem, toProblem } from "../lib/errors";
import { readiness } from "../lib/lifecycle";

export const healthRouter = Router();

// The server listens only after boot finishes, so a 200 means booted and every registered dependency is
// ready; the body names each one's state ("restarting" is still ready). No database query: Render polls
// this, and it must not keep Neon's compute awake.
healthRouter.get("/health", (_req, res) => {
  const { ready, failing, dependencies } = readiness();
  res.set("cache-control", "no-store");
  if (!ready) {
    sendProblem(res, toProblem(ErrorCode.internal, 503, `Not ready: ${failing.join(", ")}.`));
    return;
  }
  res.json({ status: "ok", dependencies });
});

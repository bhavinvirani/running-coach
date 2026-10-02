import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/client";
import { account, session, user, verification } from "../db/schema";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { createDefaultSettings } from "../services/settings";

const authLogger = logger.child({ module: "auth" });

/** Set by the auth handler from Express's req.ip (trust proxy 1), so a client cannot pick its own bucket. */
export const CLIENT_IP_HEADER = "x-running-coach-client-ip";

export const auth = betterAuth({
  appName: "Running Coach",
  baseURL: config.APP_URL,
  basePath: "/api/auth",
  trustedOrigins: [config.APP_URL],
  secret: config.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  emailAndPassword: {
    enabled: true,
    // The owner is created by `pnpm seed:owner`; nobody signs up.
    disableSignUp: true,
  },
  databaseHooks: {
    user: {
      create: {
        // Every user has a settings row from the start, so readers join it instead of re-declaring defaults.
        // internalAdapter.createUser (seedOwner) runs this hook too.
        after: async (created) => {
          await createDefaultSettings(created.id);
        },
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    // Better Auth turns this off outside production by default; tests must see what production does.
    enabled: true,
    storage: "memory",
    window: 60,
    max: 10,
    customRules: {
      // Reading the session is not a credential attempt and /api/me is not limited either.
      "/get-session": false,
      // Override Better Auth's tighter built-in rules (3 per 10 s on sign-in) with the one policy: 10 per 60 s.
      "/**": { window: 60, max: 10 },
    },
  },
  advanced: {
    database: { generateId: "uuid" },
    ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    // Better Auth skips the origin check when NODE_ENV is test; keep it on so tests see production behaviour.
    disableOriginCheck: false,
  },
  telemetry: { enabled: false },
  logger: {
    level: "warn",
    log: (level, message, ...args) => {
      const err = args.find((arg) => arg instanceof Error);
      authLogger[level](err ? { err } : {}, message);
    },
  },
});

export type Auth = typeof auth;

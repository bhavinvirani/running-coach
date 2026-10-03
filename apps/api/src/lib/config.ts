import { randomBytes } from "node:crypto";
import { z } from "zod";

// The only module that reads process.env. Every variable in .env.example that the API uses is parsed here once.

// Empty values (`OWNER_EMAIL=` in a copied .env.example) count as unset.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const masterKey = z
  .string()
  .refine(
    (value) => Buffer.from(value, "base64").length === 32,
    "must be base64 that decodes to 32 bytes",
  );

const postgresUrl = z
  .string()
  .refine((value) => /^postgres(ql)?:\/\//.test(value), "must be a postgres:// URL");

// Markers in the published dev, test and e2e secrets (.env.example, vitest.config.ts, playwright.config.ts).
// MASTER_KEY is base64, so it is checked decoded too ("dev-only-master-key-...").
const PUBLISHED_SECRET_MARKERS = ["dev-only", "test-only", "e2e-only"];
const SECRETS = [
  "MASTER_KEY",
  "BETTER_AUTH_SECRET",
  "CRON_SECRET",
  "COACH_SERVICE_SECRET",
] as const;

function isPublishedSecret(value: string): boolean {
  const decoded = Buffer.from(value, "base64").toString("latin1");
  return PUBLISHED_SECRET_MARKERS.some(
    (marker) => value.includes(marker) || decoded.includes(marker),
  );
}

const configObject = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Origin only: CORS, trusted origins and cookies compare against it exactly.
  APP_URL: z.url().transform((value) => new URL(value).origin),
  DATABASE_URL: postgresUrl,
  MASTER_KEY: masterKey,
  BETTER_AUTH_SECRET: z.string().min(32),
  // A random secret per boot is enough: the API spawns the Garmin service and hands it the value.
  GARMIN_SERVICE_SECRET: optional(z.string().min(16)).transform(
    (value) => value ?? randomBytes(32).toString("hex"),
  ),
  GARMIN_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(8765),
  GARMIN_FIXTURES: z
    .enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  // Requests a minute per user on each route that logs in to Garmin (garminRouteLimit in lib/rate-limit.ts).
  // Only e2e raises it: every e2e test is the one seeded runner, so six a minute would fail a test for what
  // the tests before it sent. Integration tests keep the default and cover the limit.
  GARMIN_ROUTE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(6),
  // Requests a minute per user on each route that calls Claude or queues a call (coachRouteLimit in
  // lib/rate-limit.ts): saving a key, Ask the coach. Raised only where one runner sends many (e2e).
  COACH_ROUTE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(6),
  // The daily cron's bearer token (POST /api/cron/sync); required in production (configSchema).
  CRON_SECRET: optional(z.string().min(16)),
  OWNER_EMAIL: optional(z.email()),
  OWNER_PASSWORD: optional(z.string().min(8).max(128)),
  OWNER_NAME: optional(z.string().min(1).max(100)),
  // The coach (SPEC Decisions): Opus at low effort; the fallback model takes the one retry after an
  // overloaded, rate-limited or failing call.
  COACH_MODEL: z.string().min(1).default("claude-opus-5-5"),
  COACH_FALLBACK_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  // Tests point the coach at a local fake; production leaves it unset.
  CLAUDE_BASE_URL: optional(z.url()),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(60_000),
  // The coach service (apps/coach), which runs the owner's coach on their Claude plan. The plan is
  // offered only when both are set (coachServiceOf); one without the other leaves it off with a warning
  // at boot instead of failing it, because Render fills the secret itself and the URL is pasted by hand.
  // http(s) only: a bare "host:port" parses as a URL whose scheme is the host.
  COACH_SERVICE_URL: optional(
    z.url({ protocol: /^https?$/ }).transform((value) => new URL(value).origin),
  ),
  COACH_SERVICE_SECRET: optional(z.string().min(32)),
  // Render's free service sleeps after 15 min idle and takes about 60 s to wake: /health is polled this
  // long before a call gives up as unavailable.
  COACH_SERVICE_WAKE_MS: z.coerce.number().int().min(100).max(600_000).default(120_000),
  // Between /health polls while the service wakes; tests shorten it.
  COACH_SERVICE_WAKE_POLL_MS: z.coerce.number().int().min(10).max(60_000).default(5_000),
  // One POST /v1/run: Claude Code's start-up (about 11 s at 0.1 CPU), the call, its own capped retries
  // and its switch to the fallback model.
  COACH_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(150_000),
});

const configSchema = configObject.superRefine((value, ctx) => {
  if (value.NODE_ENV !== "production") return;
  // Without it the cron endpoint refuses every call and no daily sync ever runs, silently.
  if (value.CRON_SECRET === undefined) {
    ctx.addIssue({ code: "custom", path: ["CRON_SECRET"], message: "is required in production" });
  }
  for (const key of SECRETS) {
    const secret = value[key];
    if (secret !== undefined && isPublishedSecret(secret)) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: "is a published dev or test value; set a new random secret in production",
      });
    }
  }
});

// System variables the Garmin child process needs to run Python; the API's secrets never reach it.
const INHERITED_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TZ", "SSL_CERT_FILE"];

/** The allowlisted system environment, for spawning the Garmin service. */
export function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export type Config = z.infer<typeof configSchema>;

export interface CoachService {
  /** Origin of the coach service. */
  url: string;
  /** Sent as x-coach-secret; never logged. */
  secret: string;
}

/** The coach service when both its URL and its secret are set, else null: the Claude plan is off. */
export function coachServiceOf(
  value: Pick<Config, "COACH_SERVICE_URL" | "COACH_SERVICE_SECRET">,
): CoachService | null {
  const { COACH_SERVICE_URL: url, COACH_SERVICE_SECRET: secret } = value;
  return url === undefined || secret === undefined ? null : { url, secret };
}

/** The boot warning for a coach service with only one of its two variables set; null when there is none. */
export function coachServiceWarning(
  value: Pick<Config, "COACH_SERVICE_URL" | "COACH_SERVICE_SECRET">,
): string | null {
  const urlSet = value.COACH_SERVICE_URL !== undefined;
  if (urlSet === (value.COACH_SERVICE_SECRET !== undefined)) return null;
  const missing = urlSet ? "COACH_SERVICE_SECRET" : "COACH_SERVICE_URL";
  return `${missing} is not set, so the Claude plan is off; set both COACH_SERVICE_URL and COACH_SERVICE_SECRET to offer it`;
}

export type ConfigResult =
  { ok: true; config: Config } | { ok: false; problems: { variable: string; message: string }[] };

/** Parses an environment without side effects; values never appear in the problems. */
export function parseConfig(env: Record<string, string | undefined>): ConfigResult {
  const result = configSchema.safeParse(env);
  if (result.success) return { ok: true, config: result.data };
  return {
    ok: false,
    problems: result.error.issues.map((issue) => ({
      variable: issue.path.join("."),
      message: issue.message,
    })),
  };
}

function loadConfig(): Config {
  const result = parseConfig(process.env);
  if (result.ok) return result.config;
  console.error("Invalid configuration; fix these environment variables (see .env.example):");
  for (const problem of result.problems) console.error(`  ${problem.variable}: ${problem.message}`);
  process.exit(1);
}

export const config: Config = loadConfig();

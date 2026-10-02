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

const configSchema = z.object({
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

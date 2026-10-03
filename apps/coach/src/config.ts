import { z } from "zod";

// The only module that reads process.env. The coach service holds the owner's Claude plan token and the
// secret the API calls it with; nothing else of the app's configuration reaches it.

// Empty values (`CLAUDE_CODE_OAUTH_TOKEN=` in a copied .env.example) count as unset.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

// Markers in the published dev, test and e2e secrets (.env.example, vitest.config.ts, playwright.config.ts).
const PUBLISHED_SECRET_MARKERS = ["dev-only", "test-only", "e2e-only"];

const configObject = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Render sets PORT; 8777 sits beside the API's 3000 and the Garmin service's 8765 locally.
  PORT: z.coerce.number().int().min(1).max(65535).default(8777),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // The API sends it in x-coach-secret; Render generates it (generateValue) and shares it with the API.
  COACH_SERVICE_SECRET: z.string().min(32),
  // From `claude setup-token` on the owner's Claude plan. Required in production; in development without
  // it Claude Code uses the laptop's own login. An API key here would bill the API instead of the plan.
  CLAUDE_CODE_OAUTH_TOKEN: optional(
    z
      .string()
      .min(1)
      .refine((value) => !value.startsWith("sk-ant-api"), {
        message: "is an API key; set the plan token from claude setup-token",
      }),
  ),
  // Tests and e2e point it at test/fake-claude-code.mjs; production runs the SDK's bundled binary.
  CLAUDE_CODE_EXECUTABLE: optional(z.string().min(1)),
  // One run's budget, from spawn to result: Claude Code starts in about 11 s on 0.1 CPU, then the model.
  COACH_RUN_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(120_000),
});

const configSchema = configObject.superRefine((value, ctx) => {
  if (value.NODE_ENV !== "production") return;
  if (value.CLAUDE_CODE_OAUTH_TOKEN === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["CLAUDE_CODE_OAUTH_TOKEN"],
      message: "is required in production",
    });
  }
  if (PUBLISHED_SECRET_MARKERS.some((marker) => value.COACH_SERVICE_SECRET.includes(marker))) {
    ctx.addIssue({
      code: "custom",
      path: ["COACH_SERVICE_SECRET"],
      message: "is a published dev or test value; set a new random secret in production",
    });
  }
});

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

/** The process's configuration, or exit 1 naming each invalid variable. */
export function loadConfig(): Config {
  const result = parseConfig(process.env);
  if (result.ok) return result.config;
  console.error("Invalid configuration; fix these environment variables (see .env.example):");
  for (const problem of result.problems) console.error(`  ${problem.variable}: ${problem.message}`);
  process.exit(1);
}

/**
 * The interface the server listens on. Render routes to the container's port, so production listens on
 * every interface; anywhere else runs may use the laptop's own Claude login, so only loopback answers.
 */
export function listenHost(nodeEnv: Config["NODE_ENV"]): string {
  return nodeEnv === "production" ? "0.0.0.0" : "127.0.0.1";
}

// What Claude Code needs from the system to run. USER and LOGNAME let it read the laptop's login from
// the macOS keychain, so they go only to a development run without a token.
const SYSTEM_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG"];
const KEYCHAIN_ENV_KEYS = ["USER", "LOGNAME"];

/** The allowlisted system variables for Claude Code's environment; never a secret or an ANTHROPIC_* key. */
export function systemEnv(options: { keychainLogin: boolean }): Record<string, string> {
  const keys = options.keychainLogin ? [...SYSTEM_ENV_KEYS, ...KEYCHAIN_ENV_KEYS] : SYSTEM_ENV_KEYS;
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  return env;
}

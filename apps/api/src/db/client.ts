import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import * as schema from "./schema";

// Small pool for a 512 MB box and Neon Free's connection limits; pg-boss keeps its own few connections.
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: "running-coach-api",
});

// An idle client losing its connection (Neon suspending, a restart) must not crash the process.
pool.on("error", (err) => {
  logger.warn({ err }, "idle database client failed");
});

export const db = drizzle({ client: pool, schema });

export type Db = typeof db;
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

import { type SQL, sql } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";

// Columns every table has (migrations rule): uuid id from gen_random_uuid(), created_at and updated_at.

export const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);

export const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * An enum column's values as the list in its CHECK constraint, `${column} in (${inList(values)})`. Every enum
 * column builds its check from the same values its type comes from (a shared zod enum where one exists).
 * Values come from code, never from input, so inlining them is safe.
 */
export const inList = (values: readonly string[]): SQL =>
  sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", "));

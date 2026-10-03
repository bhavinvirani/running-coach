import { Writable } from "node:stream";
import { DrizzleQueryError } from "drizzle-orm";
import pino from "pino";
import { describe, expect, it } from "vitest";
import {
  errSerializer,
  loggerOptions,
  safeErrorMessage,
  withRequestId,
} from "../../src/lib/logger";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  return { log: pino({ ...loggerOptions, level: "info" }, stream), lines };
}

describe("logger", () => {
  it("redacts secrets and personal data at the top level and nested", () => {
    const { log, lines } = capture();

    log.info(
      {
        email: "runner@example.com",
        password: "hunter2",
        tokenBundle: { di_token: "fixture-token" },
        headers: {
          authorization: "Bearer abc",
          cookie: "session=abc",
          "set-cookie": ["s=abc"],
          "x-coach-secret": "coach-shared-secret-value",
        },
        user: { email: "runner@example.com", apiKey: "sk-ant-fake" },
        userId: "4f1c2a8e-0000-4000-8000-000000000001",
      },
      "event",
    );

    const text = JSON.stringify(lines);
    for (const secret of [
      "runner@example.com",
      "hunter2",
      "fixture-token",
      "Bearer",
      "session=abc",
      "s=abc",
      "sk-ant",
      "coach-shared-secret-value",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(lines[0]?.userId).toBe("4f1c2a8e-0000-4000-8000-000000000001");
  });

  it("adds the request id to every line written inside its context", () => {
    const { log, lines } = capture();

    withRequestId("req-9", () => log.info("inside"));
    log.info("outside");

    expect(lines[0]).toMatchObject({ msg: "inside", requestId: "req-9", level: "info" });
    expect(lines[1]).not.toHaveProperty("requestId");
  });
});

describe("err serializer", () => {
  const TOKEN = "sess_tok_abc";
  const failedQuery = () =>
    new DrizzleQueryError(
      'select "id" from "session" where "token" = $1',
      [TOKEN, "runner@example.com"],
      new Error("Connection terminated"),
    );

  it("keeps a failed query's parameters out of the message, stack and fields, also from a cause", () => {
    const { log, lines } = capture();

    log.error({ err: new Error("request failed", { cause: failedQuery() }) }, "boom");
    log.error({ err: failedQuery() }, "boom");

    const text = JSON.stringify(lines);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("runner@example.com");
    expect(lines[0]?.err).toMatchObject({
      message: expect.stringContaining('where "token" = $1') as unknown,
      stack: expect.stringContaining("Connection terminated") as unknown,
    });
    expect(lines[1]?.err).toMatchObject({ query: expect.stringContaining("$1") as unknown });
    expect(lines[1]?.err).not.toHaveProperty("params");
  });

  it("drops pg's detail, which quotes the conflicting value", () => {
    const { log, lines } = capture();
    const duplicate = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      detail: "Key (email)=(runner@example.com) already exists.",
    });

    log.error({ err: duplicate }, "boom");

    expect(lines[0]?.err).toMatchObject({ code: "23505" });
    expect(lines[0]?.err).not.toHaveProperty("detail");
  });

  it("scrubs an error pino-http already serialized", () => {
    const serialized = errSerializer(
      pino.stdSerializers.err(new Error("request failed", { cause: failedQuery() })),
    );

    expect(JSON.stringify(serialized)).not.toContain(TOKEN);
  });

  it("gives seed-owner a message with causes and without parameters", () => {
    const message = safeErrorMessage(new Error("seed failed", { cause: failedQuery() }));

    expect(message).toBe(
      'seed failed: Failed query: select "id" from "session" where "token" = $1: Connection terminated',
    );
    expect(safeErrorMessage("plain text")).toBe("plain text");
  });
});

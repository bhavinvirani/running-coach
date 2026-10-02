import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { loggerOptions, withRequestId } from "../../src/lib/logger";

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
        headers: { authorization: "Bearer abc", cookie: "session=abc", "set-cookie": ["s=abc"] },
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

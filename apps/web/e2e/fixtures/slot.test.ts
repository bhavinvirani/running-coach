// @vitest-environment node
import { createServer, type Server } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { firstBusyPort, resolveSlot, slotValues, type SlotSource } from "./slot";

// Importing slot.ts resolves this folder's own slot; a fixed one keeps these tests independent of the folder
// they run in (a linked worktree without .e2e-slot would throw on import). unstubEnvs restores it.
vi.hoisted(() => {
  vi.stubEnv("E2E_SLOT", "1");
});

const filePath = "/repo/.e2e-slot";

function source(overrides: Partial<SlotSource>): SlotSource {
  return { env: undefined, file: undefined, filePath, linkedWorktree: false, ...overrides };
}

describe("slotValues", () => {
  it("keeps the main folder's ports, database and nonce on slot 0", () => {
    expect(slotValues(0)).toEqual({
      slot: 0,
      webPort: 4173,
      garminServicePort: 8775,
      fakeClaudePort: 8776,
      coachServicePort: 8778,
      database: "running_coach_e2e",
      fakeClaudeCodeNonce: "e2e-plan",
    });
  });

  it("moves every port up by 20 and suffixes the database and nonce on slot 2", () => {
    expect(slotValues(2)).toEqual({
      slot: 2,
      webPort: 4193,
      garminServicePort: 8795,
      fakeClaudePort: 8796,
      coachServicePort: 8798,
      database: "running_coach_e2e_2",
      fakeClaudeCodeNonce: "e2e-plan-2",
    });
  });
});

describe("resolveSlot", () => {
  it("takes E2E_SLOT over the file", () => {
    expect(resolveSlot(source({ env: "4", file: "2" }))).toBe(4);
  });

  it("takes the file when E2E_SLOT is unset", () => {
    expect(resolveSlot(source({ file: "2" }))).toBe(2);
  });

  it("takes the file when E2E_SLOT is empty", () => {
    expect(resolveSlot(source({ env: "", file: "2" }))).toBe(2);
  });

  it("gives slot 0 in the main folder when neither E2E_SLOT nor the file is there", () => {
    expect(resolveSlot(source({}))).toBe(0);
  });

  it("accepts a slot written with a trailing newline", () => {
    expect(resolveSlot(source({ file: "3\n" }))).toBe(3);
  });

  it("refuses slot 0 from E2E_SLOT in a linked worktree and says how to pick another", () => {
    expect(() => resolveSlot(source({ env: "0", linkedWorktree: true }))).toThrow(
      /linked git worktree on e2e slot 0 \(E2E_SLOT\).*ports 4173, 8775, 8776, 8778 and database running_coach_e2e.*from 1 to 9.*\/repo\/\.e2e-slot \(pnpm worktree:add does it\), or set E2E_SLOT/,
    );
  });

  it("refuses slot 0 in a linked worktree that has no .e2e-slot", () => {
    expect(() => resolveSlot(source({ linkedWorktree: true }))).toThrow(
      "slot 0 (/repo/.e2e-slot does not exist)",
    );
  });

  it("accepts slot 1 in a linked worktree", () => {
    expect(resolveSlot(source({ file: "1", linkedWorktree: true }))).toBe(1);
  });

  it.each(["abc", "10", "-1", "1.5", ""])(
    "rejects %j in the file and names the file and the allowed values",
    (file) => {
      expect(() => resolveSlot(source({ file }))).toThrow(
        `The e2e slot from /repo/.e2e-slot is ${JSON.stringify(file)}; it must be one digit from 0 to 9.`,
      );
    },
  );

  it("rejects a bad E2E_SLOT and names E2E_SLOT", () => {
    expect(() => resolveSlot(source({ env: "abc", file: "2" }))).toThrow(
      'The e2e slot from E2E_SLOT is "abc"; it must be one digit from 0 to 9.',
    );
  });
});

/** A server on a free loopback port, for a slot whose web port it holds. */
async function listenOnFreePort(): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

describe("firstBusyPort", () => {
  it("names the port a second run in the same folder would find taken", async () => {
    const server = await listenOnFreePort();
    try {
      const port = portOf(server);
      expect(await firstBusyPort({ ...slotValues(9), webPort: port })).toBe(port);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("finds nothing once that run's servers have stopped", async () => {
    const server = await listenOnFreePort();
    const port = portOf(server);
    await new Promise((resolve) => server.close(resolve));
    const values = slotValues(9);
    // Slot 9 is never written by pnpm worktree:add before eight others exist, so its ports are free here.
    expect(await firstBusyPort({ ...values, webPort: port })).toBeUndefined();
  });
});

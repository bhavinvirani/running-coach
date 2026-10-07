import { readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";

/**
 * Where a folder's e2e slot comes from: E2E_SLOT, else the git-ignored .e2e-slot at the repo root that
 * `pnpm worktree:add` writes, else 0. linkedWorktree is true when the root's .git is a file, as in every
 * worktree but the main folder.
 */
export interface SlotSource {
  env: string | undefined;
  /** The file's contents, or undefined when there is no file. */
  file: string | undefined;
  filePath: string;
  linkedWorktree: boolean;
}

/** What one slot's e2e run listens on and writes to, so runs in different worktrees never meet. */
export interface SlotValues {
  slot: number;
  webPort: number;
  garminServicePort: number;
  fakeClaudePort: number;
  coachServicePort: number;
  database: string;
  fakeClaudeCodeNonce: string;
}

/**
 * Slot N moves every port up by 10·N and suffixes the database and the fake Claude Code nonce; slot 0 keeps
 * the values the main folder and CI always had. Ports end in 3, 5, 6 and 8, so no slot lands on dev's 8765
 * or 8777.
 */
export function slotValues(slot: number): SlotValues {
  const offset = 10 * slot;
  return {
    slot,
    webPort: 4173 + offset,
    garminServicePort: 8775 + offset,
    fakeClaudePort: 8776 + offset,
    coachServicePort: 8778 + offset,
    database: slot === 0 ? "running_coach_e2e" : `running_coach_e2e_${slot}`,
    fakeClaudeCodeNonce: slot === 0 ? "e2e-plan" : `e2e-plan-${slot}`,
  };
}

/**
 * The slot a source names. Throws on anything but one digit, and on slot 0 in a linked worktree: two
 * folders on slot 0 would share ports and a database the e2e run drops and recreates.
 */
export function resolveSlot({ env, file, filePath, linkedWorktree }: SlotSource): number {
  let value = "0";
  let origin = `${filePath} does not exist`;
  if (env !== undefined && env !== "") {
    value = env;
    origin = "E2E_SLOT";
  } else if (file !== undefined) {
    value = file;
    origin = filePath;
  }

  const trimmed = value.trim();
  if (!/^[0-9]$/.test(trimmed)) {
    throw new Error(
      `The e2e slot from ${origin} is ${JSON.stringify(value)}; it must be one digit from 0 to 9.`,
    );
  }

  const slot = Number(trimmed);
  if (slot === 0 && linkedWorktree) {
    const main = slotValues(0);
    throw new Error(
      `This folder is a linked git worktree on e2e slot 0 (${origin}), but slot 0 (ports ${main.webPort}, ` +
        `${main.garminServicePort}, ${main.fakeClaudePort}, ${main.coachServicePort} and database ` +
        `${main.database}) belongs to the main folder: write a number from 1 to 9 that no other worktree ` +
        `uses into ${filePath} (pnpm worktree:add does it), or set E2E_SLOT.`,
    );
  }
  return slot;
}

/** Whether anything accepts a connection on this loopback port, over IPv4 or IPv6. */
async function listening(port: number): Promise<boolean> {
  const answers = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ host, port });
      socket.setTimeout(1_000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(false));
    });
  const [ipv4, ipv6] = await Promise.all([answers("127.0.0.1"), answers("::1")]);
  return ipv4 || ipv6;
}

/**
 * The first of a slot's ports something listens on, or undefined when all are free. Playwright clears
 * test-results/ before it checks any web server's port, so a second run in the same folder would delete
 * the running one's traces before failing; playwright.config.ts asks this first.
 */
export async function firstBusyPort(values: SlotValues): Promise<number | undefined> {
  const ports = [
    values.webPort,
    values.garminServicePort,
    values.fakeClaudePort,
    values.coachServicePort,
  ];
  const busy = await Promise.all(ports.map(listening));
  return ports.find((_, index) => busy[index]);
}

function readSlotSource(): SlotSource {
  const repoRoot = path.resolve(import.meta.dirname, "../../../..");
  const filePath = path.join(repoRoot, ".e2e-slot");
  let file: string | undefined;
  try {
    file = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    env: process.env.E2E_SLOT,
    file,
    filePath,
    linkedWorktree:
      statSync(path.join(repoRoot, ".git"), { throwIfNoEntry: false })?.isFile() ?? false,
  };
}

/**
 * This folder's slot, read once when playwright.config.ts or a spec loads: a bad or missing slot in a
 * linked worktree fails the run before any server starts or any database is reset.
 */
export const e2eSlot: SlotValues = slotValues(resolveSlot(readSlotSource()));

// Readiness and shutdown hooks. Boot steps (Garmin child process, pg-boss) register a readiness check that
// /health consults, and a stop function that SIGTERM runs, in reverse order of registration.

type ReadinessCheck = () => boolean;

const readinessChecks = new Map<string, ReadinessCheck>();
const shutdownHooks: { name: string; stop: () => Promise<void> }[] = [];

/** check() returns false while the dependency is down; /health then answers 503 naming it. */
export function registerReadinessCheck(name: string, check: ReadinessCheck): void {
  readinessChecks.set(name, check);
}

function safeCheck(check: ReadinessCheck): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

export function readiness(): { ready: boolean; failing: string[] } {
  const failing: string[] = [];
  for (const [name, check] of readinessChecks) {
    if (!safeCheck(check)) failing.push(name);
  }
  return { ready: failing.length === 0, failing };
}

export function onShutdown(name: string, stop: () => Promise<void>): void {
  shutdownHooks.push({ name, stop });
}

/** Runs every stop hook, newest first; one failing hook does not skip the others. */
export async function runShutdownHooks(
  onError: (name: string, err: unknown) => void,
): Promise<void> {
  for (const hook of [...shutdownHooks].reverse()) {
    try {
      await hook.stop();
    } catch (err) {
      onError(hook.name, err);
    }
  }
}

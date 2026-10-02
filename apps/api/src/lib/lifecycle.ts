// Readiness and shutdown hooks. Boot steps (Garmin child process, pg-boss) register a readiness check that
// /health consults, and a stop function that SIGTERM runs, in reverse order of registration.

export interface DependencyHealth {
  /** Shown in the /health body, such as "up" or "restarting". */
  state: string;
  /** False makes /health answer 503 naming the dependency. */
  ready: boolean;
}

type ReadinessCheck = () => DependencyHealth;

const readinessChecks = new Map<string, ReadinessCheck>();
const shutdownHooks: { name: string; stop: () => Promise<void> }[] = [];

export function registerReadinessCheck(name: string, check: ReadinessCheck): void {
  readinessChecks.set(name, check);
}

function safeCheck(check: ReadinessCheck): DependencyHealth {
  try {
    return check();
  } catch {
    return { state: "unknown", ready: false };
  }
}

export function readiness(): {
  ready: boolean;
  failing: string[];
  dependencies: Record<string, string>;
} {
  const failing: string[] = [];
  const dependencies: Record<string, string> = {};
  for (const [name, check] of readinessChecks) {
    const { state, ready } = safeCheck(check);
    dependencies[name] = state;
    if (!ready) failing.push(`${name} (${state})`);
  }
  return { ready: failing.length === 0, failing, dependencies };
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

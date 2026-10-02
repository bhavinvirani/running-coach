import { timeoutManager, type TimeoutProvider } from "@tanstack/react-query";

type Poll = { callback: () => void; delay: number };

/**
 * Holds TanStack Query's `refetchInterval` polls instead of letting the clock run them: a test reads how
 * often each would run and fires them when it chooses, without waiting seconds. Timeouts (stale, gc,
 * retry) keep the real clock, so Testing Library's waitFor works as usual. Call it once at the top of a
 * test file, before any QueryClient exists: TanStack cannot switch timer providers midway, and each test
 * file gets its own module instance, so the hold never leaks into another file.
 */
export function holdPolls() {
  const polls = new Map<number, Poll>();
  let nextId = 1;
  const provider: TimeoutProvider<number> = {
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (id) => window.clearTimeout(id),
    setInterval: (callback, delay) => {
      const id = nextId++;
      polls.set(id, { callback, delay });
      return id;
    },
    clearInterval: (id) => {
      if (id !== undefined) polls.delete(id);
    },
  };
  timeoutManager.setTimeoutProvider(provider);

  return {
    /** How often each scheduled poll would run, in ms; empty when nothing polls. */
    delays: () => [...polls.values()].map((poll) => poll.delay),
    /** Runs every scheduled poll once, as if its interval had just elapsed. */
    fire: () => {
      for (const poll of [...polls.values()]) poll.callback();
    },
  };
}

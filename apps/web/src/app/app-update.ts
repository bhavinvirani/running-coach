import type { QueryClient } from "@tanstack/react-query";
import { createContext } from "react";
import type { DataRouter } from "react-router";

/** When this tab last reloaded by itself (sessionStorage outlives the reload, and is per tab). */
const RELOADED_AT_KEY = "running-coach:app-update:reloaded-at";
/** One automatic reload per tab in this window: a reload that did not help is never repeated. */
export const RELOAD_GUARD_MS = 5 * 60_000;
/**
 * A screen that keeps failing (a poll every few seconds) asks for a new sw.js at most this often. A check
 * that failed (offline, the server waking) does not count, so the next mismatch asks again.
 */
export const CHECK_INTERVAL_MS = 30_000;

type AppUpdateOptions = {
  router: Pick<DataRouter, "state" | "subscribe">;
  /** A write waiting for its answer holds a reload back; its mutation cache tells when it has the answer. */
  queryClient: Pick<QueryClient, "isMutating" | "getMutationCache">;
  /** navigator.serviceWorker in a build; undefined under `vite dev` and where the browser has none. */
  serviceWorker: ServiceWorkerContainer | undefined;
  /** index.html as this page fetches it: from its service worker's precache, else the server. */
  fetchShell?: () => Promise<string>;
  /** The entry script of the page that is running. */
  runningEntry?: () => string | null;
  reload?: () => void;
  storage?: () => Storage;
  now?: () => number;
};

export type AppUpdates = {
  /**
   * The server runs another version than this page: a 2xx this version cannot read, or a screen whose code
   * is gone. `onScreen` when a route's error boundary shows it, so the screen has nothing left to lose.
   */
  versionMismatch(onScreen: boolean): void;
};

/** The running app's updates, for ScreenErrorBoundary; none in tests that render routes without main.tsx. */
export const AppUpdatesContext = createContext<AppUpdates | undefined>(undefined);

function entryScript(root: ParentNode): string | null {
  return root.querySelector('script[type="module"][src]')?.getAttribute("src") ?? null;
}

async function fetchIndexHtml(): Promise<string> {
  const response = await fetch("/index.html", { cache: "no-store" });
  if (!response.ok) throw new Error(`index.html answered ${response.status}`);
  return response.text();
}

/**
 * Keeps an open app on the version the server runs. sw.js serves the precached shell first, so the open
 * after a deploy or a rollback runs the version the device holds; the server's sw.js installs meanwhile and
 * takes over the page (skipWaiting, clientsClaim), which changes nothing until the page loads again. This
 * reloads only where nothing is lost, so never while a write waits for its answer (Sync now), which a reload
 * would drop:
 * - at a screen change once a newer worker controls the page: the screen being left goes anyway;
 * - when a route's error boundary shows a version mismatch, as soon as a reload would load another version
 *   and no write is in flight, at most once per tab in RELOAD_GUARD_MS and never when sessionStorage cannot
 *   record it. A reload loads what the page's worker answers for index.html, else what the server answers;
 *   a page that an active worker does not control (a hard reload) would reload from that worker, so it
 *   waits for a worker to claim it. With no other version (a bug in the server's answer) the boundary's
 *   Reload stays.
 * It checks for a new sw.js at start, on every return to the foreground (an installed iOS app resumed from
 * the app switcher loads nothing, so the browser never checks by itself) and after a mismatch. Nothing waits
 * on a check: the takeover, or a new worker reaching "activated" where an engine misses controllerchange
 * (whoever's check found it, the browser's own too), starts the reload.
 */
export function startAppUpdates({
  router,
  queryClient,
  serviceWorker,
  fetchShell = fetchIndexHtml,
  runningEntry = () => entryScript(document),
  reload = () => window.location.reload(),
  storage = () => window.sessionStorage,
  now = Date.now,
}: AppUpdateOptions): AppUpdates {
  // The worker whose version this page runs: the one that served it, or, for a page none served (a first
  // visit, a hard reload), the first one that claims it.
  let ownWorker = serviceWorker?.controller ?? null;
  let mismatchOnScreen = false;
  // The boundary's reload, held back while a write waited for its answer; it belongs to that screen.
  let reloadHeld = false;
  let lastCheckAt = Number.NEGATIVE_INFINITY;
  let leaving = false;

  const leave = () => {
    if (leaving) return;
    leaving = true;
    reload();
  };

  const newerWorkerInControl = () => {
    const controller = serviceWorker?.controller ?? null;
    return ownWorker !== null && controller !== null && controller !== ownWorker;
  };

  function guardAllows(): boolean {
    try {
      const store = storage();
      const last = Number(store.getItem(RELOADED_AT_KEY));
      if (last > 0 && Math.abs(now() - last) < RELOAD_GUARD_MS) return false;
      store.setItem(RELOADED_AT_KEY, String(now()));
      return true;
    } catch {
      // Without a record, nothing proves this is not the second reload in a row.
      return false;
    }
  }

  /** A worker is active but does not control this page (a hard reload bypassed it): a reload would use it. */
  async function activeWorkerBypassed(): Promise<boolean> {
    if (!serviceWorker || serviceWorker.controller) return false;
    // A browser that refuses workers may reject: then nothing but the server answers a reload.
    const registration = await serviceWorker.getRegistration().catch(() => undefined);
    return Boolean(registration?.active);
  }

  async function reloadLoadsOtherVersion(): Promise<boolean> {
    // This page's fetch would ask the server, not that worker. A newer worker claims the page when it
    // activates, and its controllerchange decides again.
    if (await activeWorkerBypassed()) return false;
    try {
      const shell = new DOMParser().parseFromString(await fetchShell(), "text/html");
      const theirs = entryScript(shell);
      const ours = runningEntry();
      return theirs !== null && ours !== null && theirs !== ours;
    } catch {
      // Offline, or the server asleep: the boundary's Reload stays.
      return false;
    }
  }

  async function reloadIntoServerVersion() {
    if (!mismatchOnScreen || leaving) return;
    // Asked again once index.html answers: the runner may have left the failed screen meanwhile.
    if (!(await reloadLoadsOtherVersion()) || !mismatchOnScreen) return;
    // Before the guard, which a held reload must not spend. The reloaded page would not sync again, so a sync
    // in flight would leave it showing the runs from before.
    if (queryClient.isMutating() > 0) {
      reloadHeld = true;
      return;
    }
    if (guardAllows()) leave();
  }

  // Where an engine misses controllerchange, a new worker reaching "activated" is the takeover. One handler
  // for every worker, so a worker found twice is followed once (addEventListener skips a repeat).
  function onWorkerStateChange(this: ServiceWorker) {
    if (this.state === "activated") void reloadIntoServerVersion();
  }
  const follow = (worker: ServiceWorker | null) =>
    worker?.addEventListener("statechange", onWorkerStateChange);

  function checkForUpdate() {
    const startedAt = now();
    lastCheckAt = startedAt;
    void serviceWorker
      ?.getRegistration()
      // None when the browser refused the worker (Playwright blocks service workers). A new sw.js that the
      // check finds announces itself with updatefound.
      .then((registration) => registration?.update())
      // Offline, or the server too slow to wake: the next start, return to the foreground or mismatch checks
      // again. A newer check that started meanwhile keeps its time.
      .catch((error: unknown) => {
        if (lastCheckAt === startedAt) lastCheckAt = Number.NEGATIVE_INFINITY;
        console.warn("Checking for a new version of the app failed", error);
      });
  }

  let pathname = router.state.location.pathname;
  router.subscribe((state) => {
    // A new pathname is a finished navigation to another screen; revalidation and search changes keep it.
    if (state.location.pathname === pathname) return;
    pathname = state.location.pathname;
    mismatchOnScreen = false;
    reloadHeld = false;
    if (newerWorkerInControl() && queryClient.isMutating() === 0) leave();
  });

  // The last write has its answer: a reload one held back decides again.
  queryClient.getMutationCache().subscribe(() => {
    if (!reloadHeld || queryClient.isMutating() > 0) return;
    reloadHeld = false;
    void reloadIntoServerVersion();
  });

  if (serviceWorker) {
    serviceWorker.addEventListener("controllerchange", () => {
      ownWorker ??= serviceWorker.controller;
      void reloadIntoServerVersion();
    });
    const register = () => {
      // vite-plugin-pwa's registerSW.js used this URL and scope, so an installed app's registration updates
      // in place. Registering again never looks for a new sw.js, so check right after.
      serviceWorker
        .register("/sw.js", { scope: "/" })
        // Playwright's block resolves undefined.
        .then((registration: ServiceWorkerRegistration | undefined) => {
          if (registration) {
            // Every new sw.js, whoever's check found it (the browser's own runs after a navigation), and
            // one whose install began before this page listened.
            registration.addEventListener("updatefound", () => follow(registration.installing));
            follow(registration.installing ?? registration.waiting);
          }
          checkForUpdate();
        })
        .catch((error: unknown) => console.error("Registering the service worker failed", error));
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdate();
    });
  }

  return {
    versionMismatch(onScreen) {
      if (onScreen) {
        mismatchOnScreen = true;
        void reloadIntoServerVersion();
        checkForUpdate();
      } else if (now() - lastCheckAt >= CHECK_INTERVAL_MS) {
        checkForUpdate();
      }
    },
  };
}

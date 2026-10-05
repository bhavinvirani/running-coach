import type { QueryClient } from "@tanstack/react-query";
import { createContext } from "react";
import type { DataRouter } from "react-router";

/** When this tab last reloaded by itself (sessionStorage outlives the reload, and is per tab). */
const RELOADED_AT_KEY = "running-coach:app-update:reloaded-at";
/** One automatic reload per tab in this window: a reload that did not help is never repeated. */
export const RELOAD_GUARD_MS = 5 * 60_000;
/** A screen that keeps failing (a poll every few seconds) asks for a new sw.js at most this often. */
export const CHECK_INTERVAL_MS = 30_000;

type AppUpdateOptions = {
  router: Pick<DataRouter, "state" | "subscribe">;
  queryClient: Pick<QueryClient, "isMutating">;
  /** navigator.serviceWorker in a build; undefined under `vite dev` and where the browser has none. */
  serviceWorker: ServiceWorkerContainer | undefined;
  /** index.html as a reload would get it: from this page's service worker's precache, else the server. */
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
 * reloads only where nothing is lost:
 * - at the next screen change once a newer worker controls the page, unless a write is still waiting for its
 *   answer (Sync now): the screen being left goes anyway;
 * - when a route's error boundary shows a version mismatch, as soon as a reload would load another version
 *   (what the page's worker, or without one the server, answers for index.html), at most once per tab in
 *   RELOAD_GUARD_MS and never when sessionStorage cannot record it. With no other version (a bug in the
 *   server's answer) the boundary's Reload stays.
 * It checks for a new sw.js at start, on every return to the foreground (an installed iOS app resumed from
 * the app switcher loads nothing, so the browser never checks by itself) and after a mismatch. Nothing waits
 * on a check: the takeover, or the worker reaching "activated" where an engine misses controllerchange,
 * starts the reload.
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

  async function reloadLoadsOtherVersion(): Promise<boolean> {
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
    if ((await reloadLoadsOtherVersion()) && mismatchOnScreen && guardAllows()) leave();
  }

  function checkForUpdate() {
    lastCheckAt = now();
    void serviceWorker
      ?.getRegistration()
      .then(async (registration) => {
        // None in dev, or when the browser refused it (Playwright blocks service workers).
        if (!registration) return;
        await registration.update();
        const incoming = registration.installing ?? registration.waiting;
        incoming?.addEventListener("statechange", () => {
          if (incoming.state === "activated") void reloadIntoServerVersion();
        });
      })
      // Offline, or the server too slow to wake: the next start or return to the foreground checks again.
      .catch((error: unknown) =>
        console.warn("Checking for a new version of the app failed", error),
      );
  }

  let pathname = router.state.location.pathname;
  router.subscribe((state) => {
    // A new pathname is a finished navigation to another screen; revalidation and search changes keep it.
    if (state.location.pathname === pathname) return;
    pathname = state.location.pathname;
    mismatchOnScreen = false;
    if (newerWorkerInControl() && queryClient.isMutating() === 0) leave();
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
        .then(checkForUpdate)
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

import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { createMemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backgroundAndReturn, settle } from "@/test/lifecycle";
import { CHECK_INTERVAL_MS, RELOAD_GUARD_MS, startAppUpdates } from "./app-update";

const ours = "/assets/index-ours.js";
const theirs = "/assets/index-theirs.js";
const shell = (entry: string) =>
  `<!doctype html><script type="module" crossorigin src="${entry}"></script>`;

/** A service worker of the registration: installing, then activated, as Workbox's skipWaiting runs it. */
class FakeWorker extends EventTarget {
  state: ServiceWorkerState = "installing";
  activate() {
    this.state = "activated";
    this.dispatchEvent(new Event("statechange"));
  }
}

/** navigator.serviceWorker as the app sees it: the controller, takeovers, and update checks. */
class FakeServiceWorkers extends EventTarget {
  controller: object | null;
  /** What the next update() finds on the server: a new sw.js. */
  nextUpdate: FakeWorker | null = null;
  readonly registration = Object.assign(new EventTarget(), {
    installing: null as FakeWorker | null,
    waiting: null as FakeWorker | null,
    active: null as FakeWorker | null,
    update: vi.fn(() => {
      if (this.nextUpdate) this.installs(this.nextUpdate);
      this.nextUpdate = null;
      return Promise.resolve();
    }),
  });
  readonly register = vi.fn(() => Promise.resolve(this.registration));

  constructor(controlled: boolean) {
    super();
    this.controller = controlled ? {} : null;
  }

  getRegistration() {
    return Promise.resolve(this.registration);
  }

  /** A new sw.js starts installing, found by this page's update() or by the browser's own check. */
  installs(worker: FakeWorker) {
    this.registration.installing = worker;
    this.registration.dispatchEvent(new Event("updatefound"));
  }

  /** A new sw.js activated and claimed this page (skipWaiting, clientsClaim). */
  takeOver() {
    this.controller = {};
    this.dispatchEvent(new Event("controllerchange"));
  }
}

type StartOptions = {
  controlled?: boolean;
  serviceWorker?: FakeServiceWorkers | null;
  shell?: () => Promise<string>;
  storage?: () => Storage;
  now?: () => number;
};

function start({
  controlled = true,
  serviceWorker = new FakeServiceWorkers(controlled),
  shell: fetchShell = () => Promise.resolve(shell(ours)),
  storage = () => sessionStorage,
  now = Date.now,
}: StartOptions = {}) {
  const router = createMemoryRouter(
    [{ path: "/" }, { path: "/plan" }, { path: "/plan/goal" }, { path: "/settings" }],
    { initialEntries: ["/"] },
  );
  const queryClient = new QueryClient();
  const reload = vi.fn();
  const updates = startAppUpdates({
    router,
    queryClient,
    serviceWorker: (serviceWorker ?? undefined) as ServiceWorkerContainer | undefined,
    fetchShell,
    runningEntry: () => ours,
    reload,
    storage,
    now,
  });
  return { router, queryClient, serviceWorker, reload, updates };
}

/** A write waiting for its answer, as Sync now's does for seconds; the result answers it. */
function writeInFlight(queryClient: QueryClient): () => Promise<void> {
  let answer = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const done = new MutationObserver(queryClient, { mutationFn: () => answered }).mutate();
  return async () => {
    answer();
    await done;
  };
}

describe("startAppUpdates", () => {
  beforeEach(() => sessionStorage.clear());

  it("registers /sw.js at the root and checks for a new version at start and on every return to the foreground", async () => {
    const { serviceWorker } = start();
    await settle();
    expect(serviceWorker?.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(serviceWorker?.registration.update).toHaveBeenCalledOnce();

    backgroundAndReturn();
    await settle();
    expect(serviceWorker?.registration.update).toHaveBeenCalledTimes(2);
  });

  it("goes on quietly when the browser refuses the worker, as Playwright's block does", async () => {
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const refused = new FakeServiceWorkers(false);
    refused.register.mockResolvedValue(undefined as never);
    vi.spyOn(refused, "getRegistration").mockResolvedValue(undefined as never);
    const { updates, reload } = start({
      serviceWorker: refused,
      shell: () => Promise.resolve(shell(theirs)),
    });
    backgroundAndReturn();
    updates.versionMismatch(false);
    await settle();
    expect(reload).not.toHaveBeenCalled();

    // With no worker to answer it, index.html comes from the server, as in the e2e flows.
    updates.versionMismatch(true);
    await settle();
    expect(reload).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  describe("a page left open", () => {
    it("loads a newer version at the next screen change after it takes over, never before", async () => {
      const { router, serviceWorker, reload } = start();
      serviceWorker?.takeOver();
      await settle();
      expect(reload).not.toHaveBeenCalled();

      await router.navigate("/plan");
      expect(reload).toHaveBeenCalledOnce();
    });

    it("keeps the screen for a revalidation or new search params; only another screen counts", async () => {
      const { router, serviceWorker, reload } = start();
      serviceWorker?.takeOver();
      await router.revalidate();
      await router.navigate("/?week=2");
      await router.navigate("/?week=2", { replace: true });
      expect(reload).not.toHaveBeenCalled();
      await router.navigate("/settings");
      expect(reload).toHaveBeenCalledOnce();
    });

    it("waits for the next screen change while a write waits for its answer (Sync now)", async () => {
      const { router, queryClient, serviceWorker, reload } = start();
      const answer = writeInFlight(queryClient);
      serviceWorker?.takeOver();
      await router.navigate("/plan");
      // The screen it opened shows content, so the answer alone reloads nothing.
      await answer();
      await settle();
      expect(reload).not.toHaveBeenCalled();

      await router.navigate("/");
      expect(reload).toHaveBeenCalledOnce();
    });

    it("notices a newer worker in control at the next screen change even without a controllerchange", async () => {
      const { router, serviceWorker, reload } = start();
      if (serviceWorker) serviceWorker.controller = {};
      await router.navigate("/plan");
      expect(reload).toHaveBeenCalledOnce();
    });

    it("stays on a page its first worker claims (a first visit), and moves on at the takeover after it", async () => {
      const { router, serviceWorker, reload } = start({ controlled: false });
      serviceWorker?.takeOver();
      await router.navigate("/plan");
      expect(reload).not.toHaveBeenCalled();

      serviceWorker?.takeOver();
      await router.navigate("/");
      expect(reload).toHaveBeenCalledOnce();
    });
  });

  describe("a version mismatch", () => {
    it("on screen reloads at once when a reload would load another version", async () => {
      const { updates, reload } = start({ shell: () => Promise.resolve(shell(theirs)) });
      updates.versionMismatch(true);
      await settle();
      expect(reload).toHaveBeenCalledOnce();
    });

    it("on screen never reloads while a reload would load the same version, and looks for a new one", async () => {
      const { updates, reload, serviceWorker } = start();
      await settle();
      updates.versionMismatch(true);
      await settle();
      expect(reload).not.toHaveBeenCalled();
      expect(serviceWorker?.registration.update).toHaveBeenCalledTimes(2);
    });

    it("on screen never reloads for an index.html with no entry script (a Wi-Fi sign-in page)", async () => {
      const { updates, reload } = start({
        serviceWorker: null,
        shell: () => Promise.resolve("<!doctype html><title>Sign in to Wi-Fi</title>"),
      });
      updates.versionMismatch(true);
      await settle();
      expect(reload).not.toHaveBeenCalled();
    });

    it("on screen reloads as soon as the server's version takes over", async () => {
      let entry = ours;
      const { updates, reload, serviceWorker } = start({
        shell: () => Promise.resolve(shell(entry)),
      });
      updates.versionMismatch(true);
      await settle();
      expect(reload).not.toHaveBeenCalled();

      entry = theirs;
      serviceWorker?.takeOver();
      await settle();
      expect(reload).toHaveBeenCalledOnce();
    });

    it("on screen counts the new worker reaching activated as the takeover when no controllerchange comes", async () => {
      let entry = ours;
      const serviceWorker = new FakeServiceWorkers(true);
      const incoming = new FakeWorker();
      serviceWorker.nextUpdate = incoming;
      const { updates, reload } = start({
        serviceWorker,
        shell: () => Promise.resolve(shell(entry)),
      });
      await settle();
      updates.versionMismatch(true);
      await settle();
      expect(reload).not.toHaveBeenCalled();

      entry = theirs;
      incoming.activate();
      await settle();
      expect(reload).toHaveBeenCalledOnce();
    });

    it("on screen counts a worker the browser's own check found reaching activated as the takeover", async () => {
      let entry = ours;
      const serviceWorker = new FakeServiceWorkers(true);
      const { updates, reload } = start({
        serviceWorker,
        shell: () => Promise.resolve(shell(entry)),
      });
      await settle();
      updates.versionMismatch(true);
      await settle();

      // After a navigation, not in this page's update().
      const incoming = new FakeWorker();
      serviceWorker.installs(incoming);
      entry = theirs;
      incoming.activate();
      await settle();
      expect(reload).toHaveBeenCalledOnce();
    });

    it("on screen counts a worker installing before this page listened reaching activated as the takeover", async () => {
      let entry = ours;
      const serviceWorker = new FakeServiceWorkers(true);
      const incoming = new FakeWorker();
      serviceWorker.registration.installing = incoming;
      const { updates, reload } = start({
        serviceWorker,
        shell: () => Promise.resolve(shell(entry)),
      });
      await settle();
      updates.versionMismatch(true);
      await settle();
      expect(reload).not.toHaveBeenCalled();

      entry = theirs;
      incoming.activate();
      await settle();
      expect(reload).toHaveBeenCalledOnce();
    });

    it("on screen waits for a worker to claim a page an active one does not control (a hard reload)", async () => {
      // The server runs another version, but a reload would come from the active worker's precache.
      const serviceWorker = new FakeServiceWorkers(false);
      serviceWorker.registration.active = new FakeWorker();
      const { updates, reload } = start({
        serviceWorker,
        shell: () => Promise.resolve(shell(theirs)),
      });
      updates.versionMismatch(true);
      await settle();
      expect(reload).not.toHaveBeenCalled();

      // The server's version claims the page; index.html now comes from its precache.
      serviceWorker.takeOver();
      await settle();
      expect(reload).toHaveBeenCalledOnce();
    });

    it("on screen waits while a write waits for its answer (Sync now), then reloads once it has it", async () => {
      const { router, queryClient, serviceWorker, updates, reload } = start({
        shell: () => Promise.resolve(shell(theirs)),
      });
      const answer = writeInFlight(queryClient);
      // The write held back the reload at this tab tap, and the screen it opened cannot read its answer.
      serviceWorker?.takeOver();
      await router.navigate("/plan");
      updates.versionMismatch(true);
      await settle();
      expect(reload).not.toHaveBeenCalled();
      // The held reload has not spent the once-per-tab allowance.
      expect(sessionStorage.length).toBe(0);

      await answer();
      await settle();
      expect(reload).toHaveBeenCalledOnce();
    });

    it("on screen forgets a reload a write held back once the runner moves to another screen", async () => {
      const { router, queryClient, updates, reload } = start({
        shell: () => Promise.resolve(shell(theirs)),
      });
      const answer = writeInFlight(queryClient);
      updates.versionMismatch(true);
      await settle();
      await router.navigate("/plan/goal");
      await answer();
      await settle();
      expect(reload).not.toHaveBeenCalled();
    });

    it("on screen is forgotten once the runner moves to another screen", async () => {
      let entry = ours;
      const { router, updates, reload, serviceWorker } = start({
        shell: () => Promise.resolve(shell(entry)),
      });
      updates.versionMismatch(true);
      await settle();
      await router.navigate("/plan/goal");

      entry = theirs;
      serviceWorker?.takeOver();
      await settle();
      expect(reload).not.toHaveBeenCalled();
    });

    it.each([
      { worker: "a service worker", serviceWorker: () => new FakeServiceWorkers(true) },
      { worker: "no service worker", serviceWorker: () => null },
    ])(
      "on screen never reloads the screen the runner moved to before index.html answered, with $worker",
      async ({ serviceWorker }) => {
        let answer: (html: string) => void = () => {};
        const { router, updates, reload } = start({
          serviceWorker: serviceWorker(),
          shell: () =>
            new Promise<string>((resolve) => {
              answer = resolve;
            }),
        });
        updates.versionMismatch(true);
        await settle();
        await router.navigate("/plan/goal");
        answer(shell(theirs));
        await settle();
        expect(reload).not.toHaveBeenCalled();
      },
    );

    it("in the background keeps the screen and only looks for a new version, at most every 30 s", async () => {
      let now = 0;
      const { updates, reload, serviceWorker } = start({
        shell: () => Promise.resolve(shell(theirs)),
        now: () => now,
      });
      await settle();
      now = CHECK_INTERVAL_MS;
      updates.versionMismatch(false);
      updates.versionMismatch(false);
      await settle();
      expect(reload).not.toHaveBeenCalled();
      expect(serviceWorker?.registration.update).toHaveBeenCalledTimes(2);
    });

    it("in the background looks again at once when the last check failed", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let now = 0;
      const { updates, serviceWorker } = start({ now: () => now });
      await settle();
      serviceWorker?.registration.update.mockRejectedValueOnce(new TypeError("Load failed"));
      now = 60_000;
      backgroundAndReturn();
      await settle();

      now += 2_000;
      updates.versionMismatch(false);
      updates.versionMismatch(false);
      await settle();
      expect(serviceWorker?.registration.update).toHaveBeenCalledTimes(3);
    });

    it("reloads by itself at most once per tab in five minutes", async () => {
      let now = 1_000_000;
      const options = { shell: () => Promise.resolve(shell(theirs)), now: () => now };
      const first = start(options);
      first.updates.versionMismatch(true);
      await settle();
      expect(first.reload).toHaveBeenCalledOnce();

      // The reloaded page, still unable to read the server's answer.
      const reloaded = start(options);
      reloaded.updates.versionMismatch(true);
      await settle();
      expect(reloaded.reload).not.toHaveBeenCalled();

      now += RELOAD_GUARD_MS;
      const later = start(options);
      later.updates.versionMismatch(true);
      await settle();
      expect(later.reload).toHaveBeenCalledOnce();
    });

    it("never reloads by itself when sessionStorage throws, nor when index.html cannot be fetched", async () => {
      const blocked = start({
        shell: () => Promise.resolve(shell(theirs)),
        storage: () => {
          throw new DOMException("blocked", "SecurityError");
        },
      });
      blocked.updates.versionMismatch(true);
      const offline = start({ shell: () => Promise.reject(new TypeError("Failed to fetch")) });
      offline.updates.versionMismatch(true);
      await settle();
      expect(blocked.reload).not.toHaveBeenCalled();
      expect(offline.reload).not.toHaveBeenCalled();
    });

    it("without a service worker, reloads on screen only when the server's index.html has another entry", async () => {
      const newer = start({ serviceWorker: null, shell: () => Promise.resolve(shell(theirs)) });
      newer.updates.versionMismatch(false);
      await settle();
      expect(newer.reload).not.toHaveBeenCalled();
      newer.updates.versionMismatch(true);
      await settle();
      expect(newer.reload).toHaveBeenCalledOnce();

      sessionStorage.clear();
      const same = start({ serviceWorker: null });
      same.updates.versionMismatch(true);
      await settle();
      expect(same.reload).not.toHaveBeenCalled();
    });
  });
});

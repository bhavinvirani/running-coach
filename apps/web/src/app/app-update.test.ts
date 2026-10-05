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
  /** What the next update() finds on the server: a new sw.js, installing. */
  nextUpdate: FakeWorker | null = null;
  readonly registration = {
    installing: null as FakeWorker | null,
    waiting: null as FakeWorker | null,
    update: vi.fn(() => {
      this.registration.installing = this.nextUpdate;
      return Promise.resolve();
    }),
  };
  readonly register = vi.fn(() => Promise.resolve(this.registration));

  constructor(controlled: boolean) {
    super();
    this.controller = controlled ? {} : null;
  }

  getRegistration() {
    return Promise.resolve(this.registration);
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
  mutating?: () => number;
  now?: () => number;
};

function start({
  controlled = true,
  serviceWorker = new FakeServiceWorkers(controlled),
  shell: fetchShell = () => Promise.resolve(shell(ours)),
  storage = () => sessionStorage,
  mutating = () => 0,
  now = Date.now,
}: StartOptions = {}) {
  const router = createMemoryRouter(
    [{ path: "/" }, { path: "/plan" }, { path: "/plan/goal" }, { path: "/settings" }],
    { initialEntries: ["/"] },
  );
  const reload = vi.fn();
  const updates = startAppUpdates({
    router,
    queryClient: { isMutating: mutating },
    serviceWorker: (serviceWorker ?? undefined) as ServiceWorkerContainer | undefined,
    fetchShell,
    runningEntry: () => ours,
    reload,
    storage,
    now,
  });
  return { router, serviceWorker, reload, updates };
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
    const refused = new FakeServiceWorkers(false);
    refused.register.mockResolvedValue(undefined as never);
    vi.spyOn(refused, "getRegistration").mockResolvedValue(undefined as never);
    const { updates, reload } = start({ serviceWorker: refused });
    backgroundAndReturn();
    updates.versionMismatch(false);
    await settle();
    expect(reload).not.toHaveBeenCalled();
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
      let mutating = 1;
      const { router, serviceWorker, reload } = start({ mutating: () => mutating });
      serviceWorker?.takeOver();
      await router.navigate("/plan");
      expect(reload).not.toHaveBeenCalled();

      mutating = 0;
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

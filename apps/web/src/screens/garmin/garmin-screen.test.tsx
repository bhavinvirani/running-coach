import {
  ErrorCode,
  type FinishGarminLoginRequest,
  type MeResponse,
  type StartGarminLoginRequest,
} from "@running-coach/shared";
import type { QueryClient } from "@tanstack/react-query";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { LOGIN_WAITS_MS } from "@/api/garmin";
import { detailKey } from "@/api/query-keys";
import {
  errorMessages,
  garminRemovalErrorMessage,
  garminSignInErrorMessage,
  networkErrorMessage,
} from "@/lib/errors";
import { json, never, notFound, problem, stubFetch, type FakeRequest } from "@/test/fake-api";
import { meFixture } from "@/test/fixtures";
import {
  FIXTURE_CODE,
  FIXTURE_EMAIL,
  FIXTURE_PASSWORD,
  NO_CODE_EMAIL,
  RATE_LIMITED_EMAIL,
  codeNeededFixture,
  disconnectedFixture,
  garminConnectedFixture,
  syncedFixture,
} from "@/test/fixtures-garmin-login";
import { renderScreen } from "@/test/render";
import { garminCopy } from "./garmin-copy";
import { GarminScreen } from "./garmin-screen";

type Answer = Response | Promise<Response>;

/** Answers that replace the fake's own for one request: a held promise, or an error. */
type Overrides = {
  login?: (request: StartGarminLoginRequest) => Answer | undefined;
  code?: (request: FinishGarminLoginRequest) => Answer | undefined;
  disconnect?: (workouts: string | null) => Answer | undefined;
};

/** What src/lib/errors.ts says for Garmin's 429 on a sign-in, and for a removal Garmin turned down. */
const signInLimited = garminSignInErrorMessage(
  new ApiError({ status: 429, code: ErrorCode.garminRateLimited }),
);
const removalNeedsLogin = garminRemovalErrorMessage(
  new ApiError({ status: 409, code: ErrorCode.garminAuthExpired }),
);

/** Removed workouts the fake API answers for a disconnect with remove. */
const REMOVED = 3;

/**
 * A tiny in-memory API over the fixture Garmin, as the real API answers: any email with FIXTURE_PASSWORD,
 * then FIXTURE_CODE; RATE_LIMITED_EMAIL gets Garmin's 429, NO_CODE_EMAIL connects without a code; a wrong
 * code keeps the login until the third, and a code with no login pending is a lost login. Connecting and
 * disconnecting change the status /api/me answers; a removal with an expired login is refused and the
 * login stays expired.
 */
function fakeGarminApi(initial: MeResponse, overrides: Overrides = {}) {
  let me = initial;
  let pendingLogin: { wrongCodes: number } | null = null;
  const setStatus = (status: MeResponse["garmin"]["status"]) => {
    me = { ...me, garmin: { ...me.garmin, status } };
  };
  const calls = stubFetch(({ method, path, body, query }: FakeRequest) => {
    if (method === "GET" && path === "/api/me") return json(me);
    if (method === "POST" && path === "/api/sync") return json(syncedFixture());
    if (method === "POST" && path === "/api/garmin/login") {
      const request = body as StartGarminLoginRequest;
      const override = overrides.login?.(request);
      if (override) return override;
      if (request.email === RATE_LIMITED_EMAIL) return problem(429, ErrorCode.garminRateLimited);
      if (request.password !== FIXTURE_PASSWORD) {
        return problem(422, ErrorCode.garminCredentialsRejected);
      }
      if (request.email === NO_CODE_EMAIL) {
        setStatus("ok");
        return json(garminConnectedFixture());
      }
      pendingLogin = { wrongCodes: 0 };
      return json(codeNeededFixture());
    }
    if (method === "POST" && path === "/api/garmin/login/code") {
      const request = body as FinishGarminLoginRequest;
      const override = overrides.code?.(request);
      if (override) return override;
      if (pendingLogin === null) return problem(409, ErrorCode.garminLoginLost);
      if (request.mfaCode !== FIXTURE_CODE) {
        pendingLogin.wrongCodes += 1;
        if (pendingLogin.wrongCodes < 3) return problem(422, ErrorCode.garminMfaRejected);
        pendingLogin = null;
        return problem(409, ErrorCode.garminLoginLost);
      }
      pendingLogin = null;
      setStatus("ok");
      return json(garminConnectedFixture());
    }
    if (method === "DELETE" && path === "/api/garmin/connection") {
      const workouts = query.get("workouts");
      const override = overrides.disconnect?.(workouts);
      if (override) return override;
      if (workouts === "remove" && me.garmin.status !== "ok") {
        return problem(409, ErrorCode.garminAuthExpired);
      }
      setStatus("not_connected");
      return json(disconnectedFixture(workouts === "remove" ? REMOVED : 0));
    }
    return notFound();
  });
  return {
    calls,
    /** The pending login is gone from the Garmin service: 5 min passed, or it restarted. */
    forgetLogin: () => {
      pendingLogin = null;
    },
    /** Garmin sent a code for a start the test answered itself (a held login). */
    awaitCode: () => {
      pendingLogin = { wrongCodes: 0 };
    },
    /** What the API says from now on, as after Garmin turned a removal down. */
    serverSays: (next: MeResponse) => {
      me = next;
    },
  };
}

const notConnected = () => meFixture({ garmin: { status: "not_connected", lastSyncAt: null } });
const expired = () =>
  meFixture({ garmin: { status: "expired", lastSyncAt: "2026-09-20T05:00:00Z" } });

function renderGarmin(me: MeResponse = meFixture(), overrides: Overrides = {}) {
  const api = fakeGarminApi(me, overrides);
  return { ...api, ...renderScreen(<GarminScreen />, { path: "/settings/garmin" }) };
}

/** The Connection card: Status, Last sync and the line the last connect or disconnect left. */
const connection = () => screen.getByRole("region", { name: garminCopy.connection });
const findConnection = () => screen.findByRole("region", { name: garminCopy.connection });
/** The Sign in card holds the form's fields; its alert, buttons and the laptop line sit under it. */
const signInCard = () => screen.getByRole("region", { name: garminCopy.signIn });
const findSignInCard = () => screen.findByRole("region", { name: garminCopy.signIn });
const requests = (calls: FakeRequest[]) => calls.map((call) => `${call.method} ${call.path}`);
const sent = (calls: FakeRequest[], request: string) =>
  requests(calls).filter((each) => each === request).length;
const meReads = (calls: FakeRequest[]) => calls.filter((call) => call.path === "/api/me").length;

/** Holds one answer until the test gives it. */
function held() {
  let give!: (response: Response) => void;
  const answer = new Promise<Response>((resolve) => (give = resolve));
  return { answer, give: (response: Response) => act(() => give(response)) };
}

async function typeCredentials(email: string, password: string) {
  const card = await findSignInCard();
  await userEvent.type(within(card).getByLabelText(garminCopy.email), email);
  await userEvent.type(within(card).getByLabelText(garminCopy.password), password);
}

async function signIn(email = FIXTURE_EMAIL, password = FIXTURE_PASSWORD, verb = "Connect Garmin") {
  await typeCredentials(email, password);
  await userEvent.click(screen.getByRole("button", { name: verb }));
}

async function sendCode(code: string, verb = "Connect Garmin") {
  const field = await within(await findSignInCard()).findByLabelText(garminCopy.code);
  await userEvent.clear(field);
  await userEvent.type(field, code);
  await userEvent.click(screen.getByRole("button", { name: verb }));
}

/** Everything the app keeps: both caches, the address and storage. */
function keptByTheApp(queryClient: QueryClient, location: unknown): string {
  return JSON.stringify([
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => [query.queryKey, query.state]),
    queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
    location,
    { ...localStorage },
    { ...sessionStorage },
  ]);
}

describe("GarminScreen", () => {
  it("shows a skeleton of the connected screen under the title and Back while loading", () => {
    stubFetch(never);
    renderScreen(<GarminScreen />, { path: "/settings/garmin" });

    expect(screen.getByRole("heading", { level: 1, name: "Garmin" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/settings");
    const skeleton = screen.getByRole("status", { name: "Loading Garmin" });
    // The Connection heading's line over its surface-1 card of Status and Last sync, then Disconnect
    // Garmin's 44 px button on the screen.
    const card = skeleton.querySelector(".bg-surface-1");
    expect(card).toHaveClass("rounded-md", "divide-y", "px-4");
    expect(card?.previousElementSibling).toHaveClass("h-5.5");
    expect(card?.querySelectorAll(".min-h-12")).toHaveLength(2);
    expect(skeleton.lastElementChild).toHaveClass("h-11");
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return attempts === 1 ? problem(500, ErrorCode.internal) : json(meFixture());
    });
    renderScreen(<GarminScreen />, { path: "/settings/garmin" });

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the connection and offers Retry when a background reload fails", async () => {
    let failing = false;
    stubFetch(() => (failing ? problem(503, ErrorCode.internal) : json(meFixture())));
    const { queryClient } = renderScreen(<GarminScreen />, { path: "/settings/garmin" });
    await findConnection();

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: detailKey("me") }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(within(connection()).getByText("Connected")).toBeInTheDocument();
  });

  it("shows the Connection card with the last sync in the runner's time zone and Disconnect Garmin under it, without a sign-in form", async () => {
    renderGarmin();

    const card = await findConnection();
    // The heading above the card names what it holds; the screen's title is the one "Garmin".
    expect(screen.getByRole("heading", { level: 2, name: "Connection" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Garmin" })).toHaveLength(1);
    expect(card.lastElementChild).toHaveClass("rounded-md", "bg-surface-1");
    expect(within(card).getByText("Connected")).toHaveClass("text-good");
    // 06:12 UTC is 07:12 in London in September (BST).
    expect(within(card).getByText("Sun 27 Sep 2026, 07:12")).toBeInTheDocument();
    expect(within(card).queryByRole("button")).not.toBeInTheDocument();
    const disconnect = screen.getByRole("button", { name: "Disconnect Garmin" });
    expect(disconnect).toHaveClass("self-start");
    expect(card.compareDocumentPosition(disconnect)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByRole("region", { name: garminCopy.signIn })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(garminCopy.password)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("garmin:connect");
  });

  it("offers email and password with what connecting does and the laptop as a fallback when not connected", async () => {
    renderGarmin(notConnected());

    expect(within(await findConnection()).getByText("Not connected")).toHaveClass("text-ink");
    expect(within(connection()).queryByText("Last sync")).not.toBeInTheDocument();
    const card = signInCard();
    expect(screen.getByRole("heading", { level: 2, name: "Sign in" })).toBeInTheDocument();
    expect(within(card).getByText(garminCopy.connectIntro)).toHaveClass("text-body", "text-ink-2");
    const email = within(card).getByLabelText(garminCopy.email);
    expect(email).toHaveAttribute("type", "email");
    const password = within(card).getByLabelText(garminCopy.password);
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAccessibleDescription(garminCopy.passwordHelp);
    // A third party's login on the app's origin: password managers must neither offer the app's own login
    // (username, current-password on the login screen) nor save the Garmin password over it.
    for (const [field, name] of [
      [email, "garmin-email"],
      [password, "garmin-password"],
    ] as const) {
      expect(field).toHaveAttribute("name", name);
      expect(field).toHaveAttribute("autocomplete", "off");
      expect(field).toHaveAttribute("data-1p-ignore");
      expect(field).toHaveAttribute("data-lpignore", "true");
      expect(field).toHaveAttribute("data-bwignore");
    }
    const help = screen.getByText("pnpm garmin:connect").closest("p");
    expect(help).toHaveTextContent(
      /^If signing in here does not work, run pnpm garmin:connect with this app's address on your laptop\.$/,
    );
    expect(help).toHaveClass("text-caption", "text-ink-2");
    expect(screen.queryByRole("button", { name: "Disconnect Garmin" })).not.toBeInTheDocument();

    // The fields sit in the card, the button under it, as on the goal form.
    expect(within(card).queryByRole("button")).not.toBeInTheDocument();
    const connect = screen.getByRole("button", { name: "Connect Garmin" });
    expect(connect).toBeDisabled();
    await userEvent.type(email, FIXTURE_EMAIL);
    expect(connect).toBeDisabled();
    await userEvent.type(password, FIXTURE_PASSWORD);
    expect(connect).toBeEnabled();
  });

  it("says what is wrong with an email Garmin cannot take and sends nothing", async () => {
    const { calls } = renderGarmin(notConnected());

    await signIn("runner@", FIXTURE_PASSWORD);

    expect(await screen.findByRole("alert")).toHaveTextContent(garminCopy.badEmail);
    expect(requests(calls)).toEqual(["GET /api/me"]);
  });

  it("holds the form with Connecting Garmin… and no spinner while Garmin answers, then asks for the code with the password let go (2FA)", async () => {
    const login = held();
    const { calls } = renderGarmin(notConnected(), { login: () => login.answer });

    await signIn();

    const card = signInCard();
    const pending = screen.getByRole("button", { name: "Connecting Garmin…" });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(within(card).getByLabelText(garminCopy.email)).toHaveAttribute("readonly");
    expect(within(card).getByLabelText(garminCopy.password)).toHaveAttribute("readonly");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    login.give(json(codeNeededFixture()));

    const code = await within(card).findByLabelText(garminCopy.code);
    // Focus lands in the field, so the field itself says where the code comes from.
    expect(code).toHaveAccessibleDescription(garminCopy.codeSent);
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(code).toHaveAttribute("inputmode", "numeric");
    await vi.waitFor(() => expect(code).toHaveFocus());
    expect(within(card).queryByLabelText(garminCopy.password)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(FIXTURE_PASSWORD)).not.toBeInTheDocument();
    // The code step keeps the flow's verb.
    expect(screen.getByRole("button", { name: "Connect Garmin" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start again" })).toBeEnabled();
    const start = calls.find((call) => call.path === "/api/garmin/login");
    expect(start?.method).toBe("POST");
    expect(start?.body).toEqual({ email: FIXTURE_EMAIL, password: FIXTURE_PASSWORD });
    expect(start?.query.toString()).toBe("");
  });

  it("connects after the code: sends the code without spaces, then Sync now's request, reads /api/me again and keeps neither secret (2FA)", async () => {
    const { calls, queryClient, router } = renderGarmin(notConnected());

    await signIn();
    await sendCode("123 456");

    const line = await within(connection()).findByRole("status");
    expect(line).toHaveTextContent(/^Garmin connected\.$/);
    await vi.waitFor(() => expect(line).toHaveFocus());
    expect(within(connection()).getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByLabelText(garminCopy.code)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect Garmin" })).toBeInTheDocument();
    await vi.waitFor(() => expect(requests(calls)).toContain("POST /api/sync"));
    await vi.waitFor(() => expect(meReads(calls)).toBeGreaterThan(1));
    const sent = requests(calls).filter((request) => request.startsWith("POST"));
    expect(sent).toEqual([
      "POST /api/garmin/login",
      "POST /api/garmin/login/code",
      "POST /api/sync",
    ]);
    expect(calls.find((call) => call.path === "/api/garmin/login/code")?.body).toEqual({
      mfaCode: FIXTURE_CODE,
    });
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
    const kept = keptByTheApp(queryClient, router.state.location);
    expect(kept).not.toContain(FIXTURE_PASSWORD);
    expect(kept).not.toContain(FIXTURE_CODE);
  });

  it("checks the code before sending it and sends nothing for one that is not 4 to 10 digits", async () => {
    const { calls } = renderGarmin(notConnected());

    await signIn();
    await sendCode("12ab");

    expect(await screen.findByRole("alert")).toHaveTextContent(garminCopy.badCode);
    expect(calls.some((call) => call.path === "/api/garmin/login/code")).toBe(false);
    expect(screen.getByLabelText(garminCopy.code)).toBeInTheDocument();
  });

  it("stays on the code step after a wrong code, and the right one then connects the same login (wrong 2FA code)", async () => {
    const { calls } = renderGarmin(notConnected());

    await signIn();
    await sendCode("111111");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.garmin_mfa_rejected);
    expect(alert).toHaveClass("text-body", "text-ink");
    expect(screen.getByLabelText(garminCopy.code)).toHaveValue("111111");

    await sendCode(FIXTURE_CODE);

    expect(await within(connection()).findByText("Garmin connected.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(requests(calls).filter((request) => request.includes("/api/garmin/login"))).toEqual([
      "POST /api/garmin/login",
      "POST /api/garmin/login/code",
      "POST /api/garmin/login/code",
    ]);
  });

  it("goes back to step 1 with its message, the email kept and focus in the password, when the login is lost (5 min passed or a restart)", async () => {
    const { forgetLogin } = renderGarmin(notConnected());

    await signIn();
    await screen.findByLabelText(garminCopy.code);
    forgetLogin();
    await sendCode(FIXTURE_CODE);

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.garmin_login_lost);
    expect(screen.queryByLabelText(garminCopy.code)).not.toBeInTheDocument();
    expect(screen.getByLabelText(garminCopy.email)).toHaveValue(FIXTURE_EMAIL);
    const password = screen.getByLabelText(garminCopy.password);
    expect(password).toHaveValue("");
    await vi.waitFor(() => expect(password).toHaveFocus());
    expect(within(connection()).getByText("Not connected")).toBeInTheDocument();
  });

  it("goes back to step 1 after the third wrong code, which drops the login (lost login)", async () => {
    renderGarmin(notConnected());

    await signIn();
    await sendCode("111111");
    await screen.findByRole("alert");
    await sendCode("222222");
    await sendCode("333333");

    expect(await screen.findByLabelText(garminCopy.password)).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent(errorMessages.garmin_login_lost);
  });

  it("starts again on step 1 with the email kept and the password cleared, also after leaving and coming back", async () => {
    const { calls, router } = renderGarmin(notConnected());

    await signIn();
    await screen.findByLabelText(garminCopy.code);
    await userEvent.click(screen.getByRole("button", { name: "Start again" }));

    expect(screen.queryByLabelText(garminCopy.code)).not.toBeInTheDocument();
    expect(screen.getByLabelText(garminCopy.email)).toHaveValue(FIXTURE_EMAIL);
    const password = screen.getByLabelText(garminCopy.password);
    expect(password).toHaveValue("");
    await vi.waitFor(() => expect(password).toHaveFocus());
    expect(requests(calls)).toEqual(["GET /api/me", "POST /api/garmin/login"]);

    await act(() => router.navigate("/settings"));
    await act(() => router.navigate("/settings/garmin"));

    expect(await screen.findByLabelText(garminCopy.password)).toBeInTheDocument();
    expect(screen.queryByLabelText(garminCopy.code)).not.toBeInTheDocument();
  });

  it("goes back to step 1 with Garmin's limit sentence when Garmin answers the code with a 429, which drops the login (Garmin 429 on the code)", async () => {
    const { calls } = renderGarmin(notConnected(), {
      code: () => problem(429, ErrorCode.garminRateLimited),
    });

    await signIn();
    await sendCode(FIXTURE_CODE);

    expect(await screen.findByRole("alert")).toHaveTextContent(signInLimited);
    expect(screen.queryByLabelText(garminCopy.code)).not.toBeInTheDocument();
    expect(screen.getByLabelText(garminCopy.email)).toHaveValue(FIXTURE_EMAIL);
    const password = screen.getByLabelText(garminCopy.password);
    expect(password).toHaveValue("");
    await vi.waitFor(() => expect(password).toHaveFocus());
    expect(sent(calls, "POST /api/garmin/login/code")).toBe(1);
  });

  it("goes back to step 1 with its message when the API's proof of the new login fails after the code (proof failure)", async () => {
    renderGarmin(notConnected(), { code: () => problem(409, ErrorCode.garminAuthExpired) });

    await signIn();
    await sendCode(FIXTURE_CODE);

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.garmin_auth_expired);
    expect(screen.queryByLabelText(garminCopy.code)).not.toBeInTheDocument();
    expect(screen.getByLabelText(garminCopy.email)).toHaveValue(FIXTURE_EMAIL);
    expect(screen.getByLabelText(garminCopy.password)).toHaveValue("");
    expect(within(connection()).getByText("Not connected")).toBeInTheDocument();
  });

  it("keeps the code step when the code did not reach Garmin, got no answer or met the app's own limit, and the same login then connects (Garmin outage)", async () => {
    let answer: () => Answer | undefined = () => problem(502, ErrorCode.garminUnavailable);
    const { calls } = renderGarmin(notConnected(), { code: () => answer() });
    const connect = () => userEvent.click(screen.getByRole("button", { name: "Connect Garmin" }));
    const expectCodeStep = async (message: string) => {
      await vi.waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
      expect(screen.getByLabelText(garminCopy.code)).toHaveValue(FIXTURE_CODE);
    };

    await signIn();
    await sendCode(FIXTURE_CODE);
    await expectCodeStep(errorMessages.garmin_unavailable);

    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    await connect();
    await expectCodeStep(networkErrorMessage);

    answer = () => problem(429, ErrorCode.rateLimited);
    await connect();
    await expectCodeStep(errorMessages.rate_limited);

    answer = () => undefined;
    await connect();

    expect(await within(connection()).findByText("Garmin connected.")).toBeInTheDocument();
    expect(sent(calls, "POST /api/garmin/login")).toBe(1);
    expect(sent(calls, "POST /api/garmin/login/code")).toBe(4);
  });

  it("still reads Connecting Garmin…, held, after leaving mid-sign-in and coming back, sends no second start, and swaps to the code once Garmin sends it (navigation)", async () => {
    const login = held();
    const { calls, router, awaitCode } = renderGarmin(notConnected(), {
      login: () => login.answer,
    });

    await signIn();
    await act(() => router.navigate("/settings"));
    expect(screen.getByText("Route not under test")).toBeInTheDocument();
    await act(() => router.navigate("/settings/garmin"));

    const card = await findSignInCard();
    const pending = screen.getByRole("button", { name: "Connecting Garmin…" });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(within(card).getByLabelText(garminCopy.email)).toHaveAttribute("readonly");
    expect(within(card).getByLabelText(garminCopy.password)).toHaveAttribute("readonly");

    awaitCode();
    login.give(json(codeNeededFixture()));

    const code = await screen.findByLabelText(garminCopy.code);
    await vi.waitFor(() => expect(code).toHaveFocus());
    expect(sent(calls, "POST /api/garmin/login")).toBe(1);
    await sendCode(FIXTURE_CODE);
    expect(await within(connection()).findByText("Garmin connected.")).toBeInTheDocument();
  });

  it("opens on the code step when Garmin sent the code while the screen was left, and that code connects (navigation, 2FA)", async () => {
    const login = held();
    const { calls, router, queryClient, awaitCode } = renderGarmin(notConnected(), {
      login: () => login.answer,
    });

    await signIn();
    await act(() => router.navigate("/settings"));
    awaitCode();
    login.give(json(codeNeededFixture()));
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
    await act(() => router.navigate("/settings/garmin"));

    const code = await screen.findByLabelText(garminCopy.code);
    expect(code).toHaveAccessibleDescription(garminCopy.codeSent);
    expect(screen.queryByLabelText(garminCopy.password)).not.toBeInTheDocument();
    await sendCode(FIXTURE_CODE);

    expect(await within(connection()).findByText("Garmin connected.")).toBeInTheDocument();
    expect(sent(calls, "POST /api/garmin/login")).toBe(1);
  });

  it("opens on the code step while Garmin waits for it, and on step 1 once its 5 minutes have passed (navigation, lost login)", async () => {
    const { router } = renderGarmin(notConnected());

    await signIn();
    await screen.findByLabelText(garminCopy.code);
    await act(() => router.navigate("/settings"));
    await act(() => router.navigate("/settings/garmin"));
    expect(await screen.findByLabelText(garminCopy.code)).toBeInTheDocument();

    await act(() => router.navigate("/settings"));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + LOGIN_WAITS_MS);
    await act(() => router.navigate("/settings/garmin"));

    expect(await screen.findByLabelText(garminCopy.password)).toHaveValue("");
    expect(screen.queryByLabelText(garminCopy.code)).not.toBeInTheDocument();
  });

  it("points to the laptop when Garmin turns a sign-in away, and sends it once (Garmin 429)", async () => {
    const { calls } = renderGarmin(notConnected());

    await signIn(RATE_LIMITED_EMAIL);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /^Garmin turned this sign-in away, as it often does for sign-ins from a server\. Connect from your laptop instead, with pnpm garmin:connect\.$/,
    );
    expect(screen.getByRole("button", { name: "Connect Garmin" })).toBeEnabled();
    expect(screen.queryByLabelText(garminCopy.code)).not.toBeInTheDocument();
    expect(requests(calls).filter((request) => request === "POST /api/garmin/login")).toHaveLength(
      1,
    );
  });

  it("says Garmin turned the email and password down and keeps both on step 1 (credentials rejected)", async () => {
    renderGarmin(notConnected());

    await signIn(FIXTURE_EMAIL, "wrong-password");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      errorMessages.garmin_credentials_rejected,
    );
    expect(screen.getByLabelText(garminCopy.email)).toHaveValue(FIXTURE_EMAIL);
    expect(screen.getByLabelText(garminCopy.password)).toHaveValue("wrong-password");
    expect(within(connection()).getByText("Not connected")).toBeInTheDocument();
  });

  it("shows the app's own limit and Garmin being down with their messages", async () => {
    let answer = problem(429, ErrorCode.rateLimited);
    renderGarmin(notConnected(), { login: () => answer });

    await signIn();
    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.rate_limited);

    answer = problem(502, ErrorCode.garminUnavailable);
    await userEvent.click(screen.getByRole("button", { name: "Connect Garmin" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(errorMessages.garmin_unavailable),
    );
  });

  it("connects without a code when Garmin asks for none, sends Sync now's request and clears the password (no-code login)", async () => {
    const { calls, queryClient, router } = renderGarmin(notConnected());

    await signIn(NO_CODE_EMAIL);

    const line = await within(connection()).findByText("Garmin connected.");
    await vi.waitFor(() => expect(line).toHaveFocus());
    expect(within(connection()).getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByLabelText(garminCopy.password)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(FIXTURE_PASSWORD)).not.toBeInTheDocument();
    await vi.waitFor(() => expect(requests(calls)).toContain("POST /api/sync"));
    await vi.waitFor(() => expect(meReads(calls)).toBeGreaterThan(1));
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(keptByTheApp(queryClient, router.state.location)).not.toContain(FIXTURE_PASSWORD);
  });

  it("says the login expired and reconnects with the same form, the code step and the line after keeping its verb (token expiry)", async () => {
    const { calls } = renderGarmin(expired());

    const card = await findConnection();
    expect(within(card).getByText("Login expired")).toHaveClass("text-bad");
    // 05:00 UTC is 06:00 in London in September (BST).
    expect(within(card).getByText("Sun 20 Sep 2026, 06:00")).toBeInTheDocument();
    expect(within(signInCard()).getByText(garminCopy.reconnectIntro)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Garmin" })).not.toBeInTheDocument();

    await signIn(FIXTURE_EMAIL, FIXTURE_PASSWORD, "Reconnect Garmin");
    await sendCode(FIXTURE_CODE, "Reconnect Garmin");

    // The flow's verb to its end: a reconnect says reconnected.
    const line = await within(connection()).findByRole("status");
    expect(line).toHaveTextContent(/^Garmin reconnected\.$/);
    await vi.waitFor(() => expect(line).toHaveFocus());
    expect(within(connection()).getByText("Connected")).toBeInTheDocument();
    await vi.waitFor(() => expect(requests(calls)).toContain("POST /api/sync"));
  });

  it("offers only keep when the login expired, and disconnects without removing workouts", async () => {
    const { calls } = renderGarmin(expired());

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect Garmin" }));

    const step = screen.getByRole("group", { name: garminCopy.disconnectQuestion });
    expect(within(step).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(step).getByText(garminCopy.keepOnly)).toHaveClass("text-ink-2");
    await userEvent.click(within(step).getByRole("button", { name: "Disconnect Garmin" }));

    expect(
      await within(connection()).findByText(
        "Garmin disconnected. Workouts this app sent stay on Garmin.",
      ),
    ).toBeInTheDocument();
    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.query.get("workouts"))).toEqual(["keep"]);
  });

  it("confirms Disconnect in place with removal on by default, says the removal runs, then shows not connected and how many workouts came off (disconnect)", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const removal = held();
    const { calls, serverSays } = renderGarmin(meFixture(), { disconnect: () => removal.answer });

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect Garmin" }));

    const step = screen.getByRole("group", { name: garminCopy.disconnectQuestion });
    await vi.waitFor(() =>
      expect(within(step).getByText(garminCopy.disconnectQuestion)).toHaveFocus(),
    );
    // Upcoming: the API takes off only the sessions still to run, from today on.
    const remove = within(step).getByRole("checkbox", {
      name: "Also remove this app's upcoming workouts from Garmin",
    });
    expect(remove).toBeChecked();
    await userEvent.click(within(step).getByRole("button", { name: "Disconnect Garmin" }));

    expect(within(step).getByRole("status")).toHaveTextContent(garminCopy.removing);
    expect(within(step).getByRole("button", { name: "Disconnecting Garmin…" })).toBeDisabled();
    expect(within(step).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(remove).toBeDisabled();

    serverSays(notConnected());
    removal.give(json(disconnectedFixture(REMOVED)));

    const line = await within(connection()).findByText(
      "Garmin disconnected. Removed 3 upcoming workouts this app made from Garmin.",
    );
    await vi.waitFor(() => expect(line).toHaveFocus());
    expect(within(connection()).getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByLabelText(garminCopy.email)).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Disconnect Garmin" })).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.path)).toEqual(["/api/garmin/connection"]);
    expect(deletes.map((call) => call.query.toString())).toEqual(["workouts=remove"]);
  });

  it("says no upcoming workouts were on Garmin when the removal found none", async () => {
    const { serverSays } = renderGarmin(meFixture(), {
      disconnect: () => {
        serverSays(notConnected());
        return json(disconnectedFixture(0));
      },
    });

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect Garmin" }));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect Garmin" }));

    expect(
      await within(connection()).findByText(
        "Garmin disconnected. No upcoming workouts from this app were on Garmin.",
      ),
    ).toBeInTheDocument();
  });

  it("still reads Disconnecting Garmin… and the removal after leaving mid-disconnect and coming back, and sends no second (navigation)", async () => {
    const removal = held();
    const { calls, router, serverSays } = renderGarmin(meFixture(), {
      disconnect: () => removal.answer,
    });

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect Garmin" }));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect Garmin" }));
    await act(() => router.navigate("/settings"));
    await act(() => router.navigate("/settings/garmin"));

    const step = await screen.findByRole("group", { name: garminCopy.disconnectQuestion });
    const pending = within(step).getByRole("button", { name: "Disconnecting Garmin…" });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(within(step).getByRole("status")).toHaveTextContent(garminCopy.removing);
    expect(within(step).getByRole("checkbox")).toBeChecked();
    expect(within(step).getByRole("checkbox")).toBeDisabled();
    expect(within(step).getByRole("button", { name: "Cancel" })).toBeDisabled();

    serverSays(notConnected());
    removal.give(json(disconnectedFixture(REMOVED)));

    expect(await within(connection()).findByText("Not connected")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  it("keeps the app's workouts on Garmin when the box is cleared", async () => {
    const { calls } = renderGarmin();

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect Garmin" }));
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect Garmin" }));

    expect(
      await within(connection()).findByText(
        "Garmin disconnected. Workouts this app sent stay on Garmin.",
      ),
    ).toBeInTheDocument();
    expect(calls.find((call) => call.method === "DELETE")?.query.get("workouts")).toBe("keep");
  });

  it("closes the step on Cancel with focus back on Disconnect Garmin, and opens it again with removal on", async () => {
    const { calls } = renderGarmin();

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect Garmin" }));
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    const disconnect = screen.getByRole("button", { name: "Disconnect Garmin" });
    await vi.waitFor(() => expect(disconnect).toHaveFocus());
    await userEvent.click(disconnect);
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("keeps the login and the step and explains a failed disconnect (Garmin outage)", async () => {
    renderGarmin(meFixture(), { disconnect: () => problem(502, ErrorCode.garminUnavailable) });

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect Garmin" }));
    const step = screen.getByRole("group");
    await userEvent.click(within(step).getByRole("button", { name: "Disconnect Garmin" }));

    expect(await within(step).findByRole("alert")).toHaveTextContent(
      errorMessages.garmin_unavailable,
    );
    expect(within(connection()).getByText("Connected")).toBeInTheDocument();
    expect(within(step).getByRole("checkbox")).toBeChecked();
    expect(within(step).getByRole("button", { name: "Disconnect Garmin" })).toBeEnabled();
    expect(screen.queryByLabelText(garminCopy.email)).not.toBeInTheDocument();
  });

  it("says removal needs a working login when Garmin turns it down, and then disconnects with keep (token expiry during disconnect)", async () => {
    const { calls, serverSays } = renderGarmin(meFixture(), {
      disconnect: (workouts) => {
        if (workouts !== "remove") return undefined;
        // The API marks the login expired when Garmin turns the removal down.
        serverSays(expired());
        return problem(409, ErrorCode.garminAuthExpired);
      },
    });

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect Garmin" }));
    const step = screen.getByRole("group");
    await userEvent.click(within(step).getByRole("button", { name: "Disconnect Garmin" }));

    expect(await within(step).findByRole("alert")).toHaveTextContent(removalNeedsLogin);
    // /api/me read again says expired: the step stays open with keep only, under the reconnect form.
    expect(await within(connection()).findByText("Login expired")).toBeInTheDocument();
    expect(within(step).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(step).getByText(garminCopy.keepOnly)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect Garmin" })).toBeInTheDocument();

    await userEvent.click(within(step).getByRole("button", { name: "Disconnect Garmin" }));

    expect(
      await within(connection()).findByText(
        "Garmin disconnected. Workouts this app sent stay on Garmin.",
      ),
    ).toBeInTheDocument();
    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.query.get("workouts"))).toEqual(["remove", "keep"]);
  });

  it("brings removal back on and drops the refusal after the reconnect it asked for, so the next disconnect removes (token expiry during disconnect, then reconnect)", async () => {
    let refused = false;
    const { calls, serverSays } = renderGarmin(meFixture(), {
      disconnect: (workouts) => {
        if (workouts !== "remove" || refused) return undefined;
        refused = true;
        serverSays(expired());
        return problem(409, ErrorCode.garminAuthExpired);
      },
    });

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect Garmin" }));
    const step = screen.getByRole("group", { name: garminCopy.disconnectQuestion });
    await userEvent.click(within(step).getByRole("button", { name: "Disconnect Garmin" }));
    expect(await within(step).findByRole("alert")).toHaveTextContent(removalNeedsLogin);
    expect(await within(connection()).findByText("Login expired")).toBeInTheDocument();

    await signIn(NO_CODE_EMAIL, FIXTURE_PASSWORD, "Reconnect Garmin");

    expect(await within(connection()).findByText("Garmin reconnected.")).toBeInTheDocument();
    expect(within(connection()).getByText("Connected")).toBeInTheDocument();
    expect(within(step).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(step).getByRole("checkbox")).toBeChecked();
    await userEvent.click(within(step).getByRole("button", { name: "Disconnect Garmin" }));

    expect(
      await within(connection()).findByText(
        "Garmin disconnected. Removed 3 upcoming workouts this app made from Garmin.",
      ),
    ).toBeInTheDocument();
    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.query.get("workouts"))).toEqual(["remove", "remove"]);
  });

  it("goes back to Settings", async () => {
    const { router } = renderGarmin();

    await userEvent.click(await screen.findByRole("link", { name: "Back" }));

    expect(router.state.location.pathname).toBe("/settings");
  });
});

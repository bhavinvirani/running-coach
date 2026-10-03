import type {
  ClaudeKeyRequest,
  CoachCredential,
  CoachCredentialChoice,
  MeResponse,
  Settings,
  UpdateSettingsRequest,
} from "@running-coach/shared";
import { ErrorCode } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { insightKey } from "@/api/insights";
import { detailKey } from "@/api/query-keys";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch, type FakeRequest } from "@/test/fake-api";
import { activityFixture, meFixture } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { SettingsScreen } from "./settings-screen";

/** What PUT /api/me/claude-key answers: "stored" stores the key like the real API, or any response. */
type KeyAnswer = "stored" | Response | Promise<Response>;

/**
 * A tiny in-memory /api/me that applies PATCHes and stores or removes the Claude key, like the real API.
 * `saveKey` decides each PUT's answer from the key sent. Like the API it keeps the runner's choice of
 * credential and answers what the coach uses now: none for the key without a saved key.
 */
function fakeMeApi(
  initial: MeResponse,
  { saveKey = () => "stored" }: { saveKey?: (key: string) => KeyAnswer } = {},
) {
  let me = initial;
  let choice: CoachCredentialChoice = initial.settings.coachCredential === "plan" ? "plan" : "key";
  const answer = (changes: Partial<Settings>) => {
    const settings = { ...me.settings, ...changes };
    const coachCredential = choice === "plan" ? "plan" : settings.hasClaudeKey ? "key" : "none";
    me = { ...me, settings: { ...settings, coachCredential } };
    return json(me);
  };
  return stubFetch(({ method, path, body }: FakeRequest) => {
    if (method === "GET" && path === "/api/me") return json(me);
    if (method === "PATCH" && path === "/api/me/settings") {
      const { coachCredential, ...changes } = body as UpdateSettingsRequest;
      if (coachCredential === "plan" && !me.settings.claudePlanAvailable) {
        return problem(409, ErrorCode.claudePlanUnavailable);
      }
      if (coachCredential !== undefined) choice = coachCredential;
      return answer(changes);
    }
    if (method === "PUT" && path === "/api/me/claude-key") {
      const stored = saveKey((body as ClaudeKeyRequest).key);
      return stored === "stored" ? answer({ hasClaudeKey: true }) : stored;
    }
    if (method === "DELETE" && path === "/api/me/claude-key")
      return answer({ hasClaudeKey: false });
    if (method === "POST" && path === "/api/auth/sign-out") return json({ success: true });
    return notFound();
  });
}

const withSavedKey = () =>
  meFixture({ settings: { ...meFixture().settings, hasClaudeKey: true, coachCredential: "key" } });
/** The owner, offered the Claude plan, with the coach on `coachCredential`. */
const owner = (coachCredential: CoachCredential, hasClaudeKey = false) =>
  meFixture({
    settings: { ...meFixture().settings, hasClaudeKey, coachCredential, claudePlanAvailable: true },
  });
const PLAN_LINE =
  "The coach runs on your Claude plan, through the coach service. Each review counts toward your plan's usage limits.";
/** A fake key in the shape Anthropic issues; never a real one (tests rule). */
const FAKE_KEY = "sk-ant-api03-fake-key-for-tests-only";
const RUN_ID = activityFixture().id;
const claudeKey = () => screen.getByRole("region", { name: "Claude key" });
const findClaudeKey = () => screen.findByRole("region", { name: "Claude key" });
const claude = () => screen.getByRole("region", { name: "Claude" });
const findClaude = () => screen.findByRole("region", { name: "Claude" });
const keyCalls = (calls: FakeRequest[]) =>
  calls.filter((call) => call.path === "/api/me/claude-key").map((call) => call.method);

function renderSettings() {
  return renderScreen(<SettingsScreen />, { path: "/settings" });
}

describe("SettingsScreen", () => {
  it("shows a skeleton in the final layout while loading", () => {
    stubFetch(never);
    renderSettings();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading settings" })).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("draws the Claude key card's skeleton like the card without a key, so the cards below do not jump", () => {
    stubFetch(never);
    renderSettings();

    const cards = screen.getByRole("status", { name: "Loading settings" }).children;
    expect(cards).toHaveLength(4);
    const claudeKey = cards[1];
    // The form's bottom padding, under Save key.
    expect(claudeKey).toHaveClass("rounded-md", "border", "bg-surface-1", "px-4", "pb-4");
    const [title, field, button, ...rest] = Array.from(claudeKey?.children ?? []);
    expect(rest).toEqual([]);
    // Section's title: its top padding and one body line.
    expect(title).toHaveClass("mt-4", "h-5.5");
    // TextField: its padding and gaps, the label's body line, the field, the helper's two caption lines.
    expect(field).toHaveClass("flex", "flex-col", "gap-2", "py-4");
    const [label, input, helper] = Array.from(field?.children ?? []);
    expect(label).toHaveClass("h-5.5");
    expect(input).toHaveClass("h-11", "rounded-sm", "border", "border-line", "bg-surface-0");
    const helperLines = Array.from(helper?.children ?? []);
    expect(helperLines).toHaveLength(2);
    for (const line of helperLines) expect(line).toHaveClass("h-4");
    // Save key, a 44 px button.
    expect(button).toHaveClass("h-11");
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return attempts === 1 ? problem(500, ErrorCode.internal) : json(meFixture());
    });
    renderSettings();

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("radio", { name: "km" })).toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the loaded settings and offers Retry when a background reload fails", async () => {
    let failing = false;
    stubFetch(() => (failing ? problem(503, ErrorCode.internal) : json(meFixture())));
    const { queryClient } = renderSettings();
    expect(await screen.findByRole("radio", { name: "km" })).toBeChecked();

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: detailKey("me") }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByRole("radio", { name: "km" })).toBeChecked();
    expect(screen.getByRole("region", { name: "Account" })).toBeInTheDocument();

    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("radio", { name: "km" })).toBeChecked();
  });

  it("shows units, coach detail, Garmin and the account", async () => {
    fakeMeApi(meFixture());
    renderSettings();

    expect(await screen.findByRole("radio", { name: "km" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "mi" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Standard" })).toBeChecked();

    const garmin = screen.getByRole("region", { name: "Garmin" });
    expect(within(garmin).getByText("Connected")).toBeInTheDocument();
    // 06:12 UTC is 07:12 in London in September (BST).
    expect(within(garmin).getByText("Sun 27 Sep 2026, 07:12")).toBeInTheDocument();

    const account = screen.getByRole("region", { name: "Account" });
    expect(within(account).getByText("runner@example.com")).toBeInTheDocument();
    expect(within(account).getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("shows no laptop connect instructions while Garmin is connected", async () => {
    fakeMeApi(meFixture());
    renderSettings();

    const garmin = await screen.findByRole("region", { name: "Garmin" });
    expect(within(garmin).getByText("Connected")).toBeInTheDocument();
    expect(garmin).not.toHaveTextContent("garmin:connect");
  });

  it("says Garmin is not connected and how to connect it from the laptop, without offering a fake action", async () => {
    fakeMeApi(meFixture({ garmin: { status: "not_connected", lastSyncAt: null } }));
    renderSettings();

    const garmin = await screen.findByRole("region", { name: "Garmin" });
    expect(within(garmin).getByText("Not connected.")).toBeInTheDocument();
    const help = within(garmin).getByText("pnpm garmin:connect").closest("p");
    expect(help).toHaveTextContent(
      /^To connect, run pnpm garmin:connect with this app's address on your laptop\.$/,
    );
    expect(help).toHaveClass("text-caption", "text-ink-2");
    expect(within(garmin).queryByRole("button")).not.toBeInTheDocument();
  });

  it("says the Garmin login expired and how to reconnect it from the laptop", async () => {
    fakeMeApi(meFixture({ garmin: { status: "expired", lastSyncAt: "2026-09-20T05:00:00Z" } }));
    renderSettings();

    const garmin = await screen.findByRole("region", { name: "Garmin" });
    expect(within(garmin).getByText("Login expired")).toBeInTheDocument();
    const help = within(garmin).getByText("pnpm garmin:connect").closest("p");
    expect(help).toHaveTextContent(
      /^To reconnect, run pnpm garmin:connect with this app's address on your laptop\.$/,
    );
    expect(help).toHaveClass("text-caption", "text-ink-2");
    expect(within(garmin).queryByRole("button")).not.toBeInTheDocument();
  });

  it("saves a new unit with one PATCH, shows it and does not load /api/me again", async () => {
    const calls = fakeMeApi(meFixture());
    const { queryClient } = renderSettings();

    await userEvent.click(await screen.findByRole("radio", { name: "mi" }));

    expect(await screen.findByRole("radio", { name: "mi" })).toBeChecked();
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/me",
      "PATCH /api/me/settings",
    ]);
    expect(calls[1]?.body).toEqual({ units: "mi" });
    expect(screen.getByRole("radio", { name: "km" })).not.toBeChecked();
  });

  it("explains a failed save and keeps the saved value", async () => {
    stubFetch(({ method }) =>
      method === "PATCH" ? problem(400, ErrorCode.validation) : json(meFixture()),
    );
    renderSettings();

    await userEvent.click(await screen.findByRole("radio", { name: "Detailed" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.validation);
    expect(screen.getByRole("radio", { name: "Standard" })).toBeChecked();
  });

  it("logs out and goes to the login screen", async () => {
    const calls = fakeMeApi(meFixture());
    const { router } = renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Log out" }));

    expect(await screen.findByText("Route not under test")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(calls.some((call) => call.path === "/api/auth/sign-out")).toBe(true);
  });
  it("asks for a Claude key with what it costs and how it is kept, keeps password managers out, and saves nothing while the field is blank", async () => {
    fakeMeApi(meFixture());
    renderSettings();

    const section = await findClaudeKey();
    const field = within(section).getByLabelText("Claude API key");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
    // Password managers would offer the app password here, or save the API key as one.
    expect(field).toHaveAttribute("data-1p-ignore");
    expect(field).toHaveAttribute("data-lpignore", "true");
    expect(field).toHaveAttribute("spellcheck", "false");
    expect(field).toHaveAttribute("autocapitalize", "off");
    expect(field).toHaveAccessibleDescription(
      "The coach uses your own Claude API key, about $1 a month, paid to Anthropic. It is stored encrypted.",
    );
    expect(within(section).getByText(/^The coach uses your own Claude API key/)).toHaveClass(
      "text-ink-2",
    );
    const save = within(section).getByRole("button", { name: "Save key" });
    expect(save).toBeDisabled();
    await userEvent.type(field, "   ");
    expect(save).toBeDisabled();
    expect(within(section).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("checks and saves a key (Saving key…), then shows it as saved without the key itself, focus on Replace key", async () => {
    let answer!: () => void;
    const calls = fakeMeApi(meFixture(), {
      saveKey: () =>
        new Promise<Response>((resolve) => (answer = () => resolve(json(withSavedKey())))),
    });
    const { queryClient } = renderSettings();
    // A run screen opened before cached its coach state.
    queryClient.setQueryData(insightKey(RUN_ID), { state: "no_key" });

    const section = await findClaudeKey();
    await userEvent.type(within(section).getByLabelText("Claude API key"), ` ${FAKE_KEY} `);
    await userEvent.click(within(section).getByRole("button", { name: "Save key" }));

    expect(await within(section).findByRole("button", { name: "Saving key…" })).toBeDisabled();
    act(() => answer());

    expect(await within(claudeKey()).findByText("Saved")).toBeInTheDocument();
    expect(within(claudeKey()).queryByLabelText("Claude API key")).not.toBeInTheDocument();
    expect(claudeKey()).not.toHaveTextContent(FAKE_KEY);
    // The field and its button are gone; focus lands on the control that took their place.
    await vi.waitFor(() =>
      expect(within(claudeKey()).getByRole("button", { name: "Replace key" })).toHaveFocus(),
    );
    expect(within(claudeKey()).getByRole("button", { name: "Remove key" })).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([
      { key: FAKE_KEY },
    ]);
    // The answer is the whole MeResponse: no second GET, and every run's coach state is read again.
    expect(calls.filter((call) => call.path === "/api/me")).toHaveLength(1);
    expect(queryClient.getQueryState(insightKey(RUN_ID))?.isInvalidated).toBe(true);
  });

  it("says Claude rejected the key and keeps what was typed (invalid or expired key message on Settings)", async () => {
    const calls = fakeMeApi(meFixture(), {
      saveKey: () => problem(422, ErrorCode.claudeKeyInvalid),
    });
    renderSettings();

    const section = await findClaudeKey();
    const field = within(section).getByLabelText("Claude API key");
    await userEvent.type(field, FAKE_KEY);
    await userEvent.click(within(section).getByRole("button", { name: "Save key" }));

    const alert = await within(section).findByRole("alert");
    expect(alert).toHaveTextContent(
      /^Claude rejected this key\. Copy it again from the Claude Console and save it\.$/,
    );
    expect(alert).toHaveClass("text-body", "text-ink");
    expect(field).toHaveValue(FAKE_KEY);
    expect(within(section).getByRole("button", { name: "Save key" })).toBeEnabled();
    expect(within(section).queryByText("Saved")).not.toBeInTheDocument();
    expect(keyCalls(calls)).toEqual(["PUT"]);
  });

  it("says Claude did not answer and stores nothing when Claude is down", async () => {
    fakeMeApi(meFixture(), { saveKey: () => problem(502, ErrorCode.claudeUnavailable) });
    renderSettings();

    const section = await findClaudeKey();
    await userEvent.type(within(section).getByLabelText("Claude API key"), FAKE_KEY);
    await userEvent.click(within(section).getByRole("button", { name: "Save key" }));

    expect(await within(section).findByRole("alert")).toHaveTextContent(
      errorMessages.claude_unavailable,
    );
    expect(within(section).getByLabelText("Claude API key")).toHaveValue(FAKE_KEY);
    expect(within(section).queryByText("Saved")).not.toBeInTheDocument();
  });

  it("opens the field with Cancel on Replace key, closes it on Cancel and saves a new key, moving focus with each swap", async () => {
    const calls = fakeMeApi(withSavedKey(), {
      saveKey: (key) => (key === FAKE_KEY ? "stored" : problem(422, ErrorCode.claudeKeyInvalid)),
    });
    renderSettings();

    const section = await findClaudeKey();
    expect(within(section).getByText("Saved")).toBeInTheDocument();
    expect(within(section).queryByLabelText("Claude API key")).not.toBeInTheDocument();

    await userEvent.click(within(section).getByRole("button", { name: "Replace key" }));
    // Replace key is gone: focus goes to the field that replaced it.
    expect(within(section).getByLabelText("Claude API key")).toHaveFocus();
    await userEvent.type(within(section).getByLabelText("Claude API key"), "sk-ant-wrong");
    await userEvent.click(within(section).getByRole("button", { name: "Save key" }));
    expect(await within(section).findByRole("alert")).toHaveTextContent(
      errorMessages.claude_key_invalid,
    );

    await userEvent.click(within(section).getByRole("button", { name: "Cancel" }));
    expect(within(section).getByText("Saved")).toBeInTheDocument();
    expect(within(section).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Replace key" })).toHaveFocus();

    // Opened again: empty, with no error from the last try.
    await userEvent.click(within(section).getByRole("button", { name: "Replace key" }));
    const field = within(section).getByLabelText("Claude API key");
    expect(field).toHaveValue("");
    expect(within(section).queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.type(field, FAKE_KEY);
    await userEvent.click(within(section).getByRole("button", { name: "Save key" }));

    expect(await within(section).findByText("Saved")).toBeInTheDocument();
    expect(within(section).queryByLabelText("Claude API key")).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(within(section).getByRole("button", { name: "Replace key" })).toHaveFocus(),
    );
    expect(keyCalls(calls)).toEqual(["PUT", "PUT"]);
  });

  it("removes the key without a confirm dialog, reads every run's coach state again and asks for a key with focus in the field", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const calls = fakeMeApi(withSavedKey());
    const { queryClient } = renderSettings();
    // A run screen opened before cached its coach card.
    queryClient.setQueryData(insightKey(RUN_ID), { state: "none" });

    await userEvent.click(
      within(await findClaudeKey()).getByRole("button", { name: "Remove key" }),
    );

    const field = await within(claudeKey()).findByLabelText("Claude API key");
    await vi.waitFor(() => expect(field).toHaveFocus());
    expect(within(claudeKey()).queryByText("Saved")).not.toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
    expect(keyCalls(calls)).toEqual(["DELETE"]);
    expect(queryClient.getQueryData<MeResponse>(detailKey("me"))?.settings.hasClaudeKey).toBe(
      false,
    );
    expect(queryClient.getQueryState(insightKey(RUN_ID))?.isInvalidated).toBe(true);
  });

  it("explains a failed removal and keeps the key", async () => {
    stubFetch(({ method }) =>
      method === "DELETE" ? problem(500, ErrorCode.internal) : json(withSavedKey()),
    );
    renderSettings();

    await userEvent.click(
      within(await findClaudeKey()).getByRole("button", { name: "Remove key" }),
    );

    expect(await within(claudeKey()).findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(within(claudeKey()).getByText("Saved")).toBeInTheDocument();
    // Nothing swapped, so nothing to move focus to.
    expect(within(claudeKey()).queryByLabelText("Claude API key")).not.toBeInTheDocument();
  });

  it("places the Claude key between units and coach detail and Garmin", async () => {
    fakeMeApi(meFixture());
    renderSettings();
    await findClaudeKey();

    const named = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label"))
      .filter((name) => name !== null);
    expect(named).toEqual(["Claude key", "Garmin", "Account"]);
    expect(claudeKey().previousElementSibling).toContainElement(
      screen.getByRole("radio", { name: "Standard" }),
    );
  });

  describe("Coach uses (Claude plan)", () => {
    it("shows no Coach uses choice and the Claude key card as before when the plan is not offered (claudePlanAvailable false)", async () => {
      fakeMeApi(meFixture());
      renderSettings();

      const section = await findClaudeKey();
      expect(screen.queryByRole("group", { name: "Coach uses" })).not.toBeInTheDocument();
      expect(screen.queryByRole("radio", { name: "Claude plan" })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Claude" })).not.toBeInTheDocument();
      expect(within(section).getByLabelText("Claude API key")).toBeInTheDocument();
    });

    it("offers Coach uses: Claude plan or API key, API key chosen while the coach has no key, only when the plan is offered (claudePlanAvailable)", async () => {
      fakeMeApi(owner("none"));
      renderSettings();

      const section = await findClaude();
      const choice = within(section).getByRole("group", { name: "Coach uses" });
      const radios = within(choice).getAllByRole("radio");
      expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual([
        "Claude plan",
        "API key",
      ]);
      expect(within(choice).getByRole("radio", { name: "API key" })).toBeChecked();
      // API key chosen: the key form exactly as for every other runner.
      expect(within(section).getByLabelText("Claude API key")).toHaveAccessibleDescription(
        /^The coach uses your own Claude API key/,
      );
      expect(within(section).queryByText(PLAN_LINE)).not.toBeInTheDocument();
      const named = screen
        .getAllByRole("region")
        .map((region) => region.getAttribute("aria-label"))
        .filter((name) => name !== null);
      expect(named).toEqual(["Claude", "Garmin", "Account"]);
    });

    it("shows one line instead of the key form while the coach uses the Claude plan", async () => {
      fakeMeApi(owner("plan", true));
      renderSettings();

      const section = await findClaude();
      expect(within(section).getByRole("radio", { name: "Claude plan" })).toBeChecked();
      const line = within(section).getByText(PLAN_LINE);
      expect(line).toHaveClass("text-body", "text-ink-2");
      expect(within(section).queryByLabelText("Claude API key")).not.toBeInTheDocument();
      expect(within(section).queryByText("Saved")).not.toBeInTheDocument();
      expect(within(section).queryByRole("button")).not.toBeInTheDocument();
    });

    it("chooses Claude plan with one PATCH coachCredential plan, hides the key form, keeps focus on the choice and reads every run's coach state again", async () => {
      const calls = fakeMeApi(owner("none"));
      const { queryClient } = renderSettings();
      // A run screen opened before cached its coach state.
      queryClient.setQueryData(insightKey(RUN_ID), { state: "no_key" });

      const plan = within(await findClaude()).getByRole("radio", { name: "Claude plan" });
      await userEvent.click(plan);

      expect(plan).toBeChecked();
      expect(within(claude()).getByText(PLAN_LINE)).toBeInTheDocument();
      expect(within(claude()).queryByLabelText("Claude API key")).not.toBeInTheDocument();
      await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
      expect(plan).toBeChecked();
      expect(plan).toHaveFocus();
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        "GET /api/me",
        "PATCH /api/me/settings",
      ]);
      expect(calls[1]?.body).toEqual({ coachCredential: "plan" });
      expect(queryClient.getQueryData<MeResponse>(detailKey("me"))?.settings.coachCredential).toBe(
        "plan",
      );
      expect(queryClient.getQueryState(insightKey(RUN_ID))?.isInvalidated).toBe(true);
    });

    it("chooses API key with one PATCH coachCredential key and shows the key form again", async () => {
      const calls = fakeMeApi(owner("plan"));
      renderSettings();

      const section = await findClaude();
      expect(within(section).queryByLabelText("Claude API key")).not.toBeInTheDocument();
      await userEvent.click(within(section).getByRole("radio", { name: "API key" }));

      const field = await within(claude()).findByLabelText("Claude API key");
      expect(field).toHaveValue("");
      expect(within(claude()).getByRole("button", { name: "Save key" })).toBeDisabled();
      expect(within(claude()).queryByText(PLAN_LINE)).not.toBeInTheDocument();
      expect(within(claude()).getByRole("radio", { name: "API key" })).toBeChecked();
      await vi.waitFor(() =>
        expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([
          { coachCredential: "key" },
        ]),
      );
    });

    it("keeps a saved key while the Claude plan is chosen and shows it as saved on API key", async () => {
      const calls = fakeMeApi(owner("plan", true));
      renderSettings();

      await userEvent.click(within(await findClaude()).getByRole("radio", { name: "API key" }));

      expect(await within(claude()).findByText("Saved")).toBeInTheDocument();
      expect(within(claude()).getByRole("button", { name: "Replace key" })).toBeInTheDocument();
      expect(keyCalls(calls)).toEqual([]);
    });

    it("says the plan is not set up and stays on API key when the API answers 409 claude_plan_unavailable", async () => {
      stubFetch(({ method }) =>
        method === "PATCH" ? problem(409, ErrorCode.claudePlanUnavailable) : json(owner("none")),
      );
      renderSettings();

      await userEvent.click(within(await findClaude()).getByRole("radio", { name: "Claude plan" }));

      const alert = await within(claude()).findByRole("alert");
      expect(alert).toHaveTextContent(
        /^The Claude plan is not set up for this account\. Use an API key instead\.$/,
      );
      expect(alert).toHaveClass("text-body", "text-ink");
      // Said in the Claude card, not under units and coach detail.
      expect(screen.getAllByRole("alert")).toEqual([alert]);
      expect(within(claude()).getByRole("radio", { name: "API key" })).toBeChecked();
      expect(within(claude()).getByLabelText("Claude API key")).toBeInTheDocument();
      expect(within(claude()).queryByText(PLAN_LINE)).not.toBeInTheDocument();
    });

    it("drops the key form's last error when the choice changes", async () => {
      fakeMeApi(owner("none"), { saveKey: () => problem(422, ErrorCode.claudeKeyInvalid) });
      renderSettings();

      const section = await findClaude();
      await userEvent.type(within(section).getByLabelText("Claude API key"), FAKE_KEY);
      await userEvent.click(within(section).getByRole("button", { name: "Save key" }));
      expect(await within(section).findByRole("alert")).toHaveTextContent(
        errorMessages.claude_key_invalid,
      );

      await userEvent.click(within(section).getByRole("radio", { name: "Claude plan" }));
      await userEvent.click(within(section).getByRole("radio", { name: "API key" }));

      expect(await within(claude()).findByLabelText("Claude API key")).toHaveValue("");
      expect(within(claude()).queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});

import { ErrorCode } from "@running-coach/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { errorMessages, networkErrorMessage } from "@/lib/errors";
import { garminPushStatusFixture } from "@/test/fixtures";
import { GarminPushLine } from "./garmin-push-line";

function renderLine(line: ReactElement) {
  return render(<MemoryRouter>{line}</MemoryRouter>);
}

const idle = { sending: false, error: null, onSend: () => {} };

describe("GarminPushLine", () => {
  it("offers Send to Garmin when the login works and nothing is sending", async () => {
    const onSend = vi.fn();
    renderLine(<GarminPushLine garmin={garminPushStatusFixture()} send={{ ...idle, onSend }} />);

    await userEvent.click(screen.getByRole("button", { name: "Send to Garmin" }));

    expect(onSend).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says workouts are sending while a push runs or the request is in flight, with no button", () => {
    const { unmount } = renderLine(
      <GarminPushLine garmin={garminPushStatusFixture({ pushing: true })} send={idle} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Sending workouts to Garmin.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    unmount();

    renderLine(
      <GarminPushLine garmin={garminPushStatusFixture()} send={{ ...idle, sending: true }} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Sending workouts to Garmin.");
  });

  it("says why the last push stopped and offers Send to Garmin as the retry (Garmin 429)", () => {
    renderLine(
      <GarminPushLine
        garmin={garminPushStatusFixture({ error: ErrorCode.garminRateLimited })}
        send={idle}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(errorMessages.garmin_rate_limited);
    expect(screen.getByRole("button", { name: "Send to Garmin" })).toBeInTheDocument();
  });

  it("says why its own request failed, before the last push's reason", () => {
    renderLine(
      <GarminPushLine
        garmin={garminPushStatusFixture({ error: ErrorCode.garminUnavailable })}
        send={{
          ...idle,
          error: new ApiError({ status: 0, code: ErrorCode.internal, network: true }),
        }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(networkErrorMessage);
  });

  it("points to Settings with one sentence when Garmin is not connected", () => {
    renderLine(
      <GarminPushLine
        garmin={garminPushStatusFixture({ connection: "not_connected" })}
        send={idle}
      />,
    );

    expect(screen.getByText(/to send these workouts to your watch\.$/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("adds nothing for an expired login unless asked to explain it (token expiry)", () => {
    const expired = garminPushStatusFixture({ connection: "expired" });
    const { container, unmount } = renderLine(<GarminPushLine garmin={expired} send={idle} />);
    expect(container).toBeEmptyDOMElement();
    unmount();

    renderLine(<GarminPushLine garmin={expired} send={idle} explainExpired />);
    expect(screen.getByText(errorMessages.garmin_auth_expired)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

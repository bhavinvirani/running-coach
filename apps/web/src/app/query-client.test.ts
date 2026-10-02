import { ErrorCode } from "@running-coach/shared";
import { MutationObserver, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { createQueryClient } from "./query-client";

const unauthorized = () => new ApiError({ status: 401, code: ErrorCode.unauthorized });
const invalid = () => new ApiError({ status: 400, code: ErrorCode.validation });

async function failMutation(onUnauthorized: () => void, error: ApiError) {
  const client = createQueryClient({ onUnauthorized });
  const mutation = new MutationObserver(client, { mutationFn: () => Promise.reject(error) });
  await mutation.mutate().catch(() => undefined);
}

async function failQuery(onUnauthorized: () => void, error: ApiError) {
  const client = createQueryClient({ onUnauthorized });
  const query = new QueryObserver(client, {
    queryKey: ["me", "detail"],
    queryFn: () => Promise.reject(error),
  });
  await query.refetch();
}

describe("createQueryClient", () => {
  it("sends the user to log in when a mutation gets a 401", async () => {
    const onUnauthorized = vi.fn();
    await failMutation(onUnauthorized, unauthorized());
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("sends the user to log in when a query gets a 401", async () => {
    const onUnauthorized = vi.fn();
    await failQuery(onUnauthorized, unauthorized());
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("leaves the user where they are when a mutation fails for another reason", async () => {
    const onUnauthorized = vi.fn();
    await failMutation(onUnauthorized, invalid());
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

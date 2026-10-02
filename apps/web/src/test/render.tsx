import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";

export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
}

/**
 * Renders one screen at `path` inside a memory router and a fresh QueryClient. Other paths render
 * their own name, so a test can assert where the screen navigated.
 */
export function renderScreen(screen: ReactElement, { path = "/" }: { path?: string } = {}) {
  const queryClient = testQueryClient();
  const router = createMemoryRouter(
    [
      { path, element: screen },
      { path: "*", element: <p>Route not under test</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

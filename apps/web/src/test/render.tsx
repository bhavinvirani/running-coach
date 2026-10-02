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

type RenderScreenOptions = {
  /** The address the screen opens at. */
  path?: string;
  /** The route pattern that renders the screen, when it has params: "/runs/:id". Defaults to `path`. */
  route?: string;
  /** Addresses visited before `path`, so the screen can go back to them. Empty: opened from a link. */
  history?: string[];
};

/**
 * Renders one screen at `path` inside a memory router and a fresh QueryClient. Other paths render
 * their own name, so a test can assert where the screen navigated.
 */
export function renderScreen(
  screen: ReactElement,
  { path = "/", route = path, history = [] }: RenderScreenOptions = {},
) {
  const queryClient = testQueryClient();
  const router = createMemoryRouter(
    [
      { path: route, element: screen },
      { path: "*", element: <p>Route not under test</p> },
    ],
    { initialEntries: [...history, path], initialIndex: history.length },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

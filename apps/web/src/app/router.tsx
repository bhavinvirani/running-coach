import type { QueryClient } from "@tanstack/react-query";
import { createBrowserRouter, redirect, type RouteObject } from "react-router";
import { isApiError } from "@/api/client";
import { meQueryOptions } from "@/api/me";
import { AppPending } from "./app-pending";
import { ScreenErrorBoundary } from "./screen-error-boundary";
import { TabShell } from "./tab-shell";

/** Every screen behind login needs the user and settings; load them once, send 401s to /login. */
export function authenticatedLoader(queryClient: QueryClient) {
  return async () => {
    try {
      await queryClient.ensureQueryData(meQueryOptions());
      return null;
    } catch (error) {
      if (isApiError(error) && error.status === 401) return redirect("/login");
      throw error;
    }
  };
}

export function appRoutes(queryClient: QueryClient): RouteObject[] {
  return [
    {
      id: "root",
      HydrateFallback: AppPending,
      ErrorBoundary: ScreenErrorBoundary,
      children: [
        {
          path: "/login",
          ErrorBoundary: ScreenErrorBoundary,
          lazy: {
            Component: async () => (await import("@/screens/login/login-screen")).LoginScreen,
          },
        },
        {
          id: "authenticated",
          loader: authenticatedLoader(queryClient),
          Component: TabShell,
          ErrorBoundary: ScreenErrorBoundary,
          children: [
            // Today replaces this redirect in slice 1.
            { index: true, loader: () => redirect("/settings") },
            {
              path: "settings",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: async () =>
                  (await import("@/screens/settings/settings-screen")).SettingsScreen,
              },
            },
          ],
        },
        { path: "*", loader: () => redirect("/") },
      ],
    },
  ];
}

export function createAppRouter(queryClient: QueryClient) {
  return createBrowserRouter(appRoutes(queryClient));
}

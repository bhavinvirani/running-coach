import type { QueryClient } from "@tanstack/react-query";
import { createBrowserRouter, redirect, type RouteObject } from "react-router";
import { isApiError } from "@/api/client";
import { meQueryOptions } from "@/api/me";
import { AppPending } from "./app-pending";
import { lazyScreen } from "./lazy-screen";
import { bootRetry } from "./query-client";
import { ScreenErrorBoundary } from "./screen-error-boundary";
import { TabShell } from "./tab-shell";

/**
 * Every screen behind login needs the user and settings; load them once, send 401s to /login. This is the
 * first request after the server slept, so it rides out the wake while AppPending explains the wait.
 */
export function authenticatedLoader(queryClient: QueryClient) {
  return async () => {
    try {
      await queryClient.ensureQueryData({ ...meQueryOptions(), ...bootRetry() });
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
            Component: lazyScreen(
              async () => (await import("@/screens/login/login-screen")).LoginScreen,
            ),
          },
        },
        {
          id: "authenticated",
          loader: authenticatedLoader(queryClient),
          Component: TabShell,
          ErrorBoundary: ScreenErrorBoundary,
          children: [
            {
              index: true,
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/today/today-screen")).TodayScreen,
                ),
              },
            },
            {
              path: "plan",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/plan/plan-screen")).PlanScreen,
                ),
              },
            },
            {
              // Detail screens of the plan inside the shell, like a run, so the tabs stay one tap away.
              path: "plan/goal",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/goal/goal-screen")).GoalScreen,
                ),
              },
            },
            {
              path: "plan/weeks/:number",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/plan-week/plan-week-screen")).PlanWeekScreen,
                ),
              },
            },
            {
              path: "plan/reviews",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/reviews/reviews-screen")).ReviewsScreen,
                ),
              },
            },
            {
              path: "plan/reviews/:id",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/review/review-screen")).ReviewScreen,
                ),
              },
            },
            {
              // A workout of the runner's own; "new" outranks ":id" in React Router's matching.
              path: "plan/sessions/new",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () =>
                    (await import("@/screens/workout-builder/workout-builder-screen"))
                      .WorkoutBuilderScreen,
                ),
              },
            },
            {
              path: "plan/sessions/:id",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/session/session-screen")).SessionScreen,
                ),
              },
            },
            {
              path: "plan/sessions/:id/edit",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () =>
                    (await import("@/screens/workout-builder/workout-builder-screen"))
                      .WorkoutBuilderScreen,
                ),
              },
            },
            {
              path: "progress",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/progress/progress-screen")).ProgressScreen,
                ),
              },
            },
            {
              // A detail screen inside the shell, so the tabs stay one tap away.
              path: "runs/:id",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/run/run-screen")).RunScreen,
                ),
              },
            },
            {
              path: "settings",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/settings/settings-screen")).SettingsScreen,
                ),
              },
            },
            {
              // Each Settings row opens one of these, inside the shell with Settings still selected.
              path: "settings/garmin",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/garmin/garmin-screen")).GarminScreen,
                ),
              },
            },
            {
              path: "settings/claude",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/claude/claude-screen")).ClaudeScreen,
                ),
              },
            },
            {
              path: "settings/units",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/units/units-screen")).UnitsScreen,
                ),
              },
            },
            {
              path: "settings/coach-detail",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () =>
                    (await import("@/screens/coach-detail/coach-detail-screen")).CoachDetailScreen,
                ),
              },
            },
            {
              path: "settings/hr-zones",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/hr-zones/hr-zones-screen")).HrZonesScreen,
                ),
              },
            },
            {
              path: "settings/shoes",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/shoes/shoes-screen")).ShoesScreen,
                ),
              },
            },
            {
              // One screen adds a pair and edits one; "new" outranks ":id" in React Router's matching.
              path: "settings/shoes/new",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/shoe/shoe-screen")).ShoeScreen,
                ),
              },
            },
            {
              path: "settings/shoes/:id",
              ErrorBoundary: ScreenErrorBoundary,
              lazy: {
                Component: lazyScreen(
                  async () => (await import("@/screens/shoe/shoe-screen")).ShoeScreen,
                ),
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

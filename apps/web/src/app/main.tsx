import "@/styles/globals.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { AppUpdatesContext, startAppUpdates } from "./app-update";
import { createQueryClient } from "./query-client";
import { createAppRouter } from "./router";

const queryClient = createQueryClient({
  onUnauthorized: () => {
    if (router.state.location.pathname !== "/login") void router.navigate("/login");
  },
  onContractMismatch: () => appUpdates.versionMismatch(false),
});
const router = createAppRouter(queryClient);
const appUpdates = startAppUpdates({
  router,
  queryClient,
  // `vite dev` serves no sw.js. MODE, not PROD: the e2e build runs with NODE_ENV=test, which turns PROD off.
  serviceWorker:
    import.meta.env.MODE !== "development" && "serviceWorker" in navigator
      ? navigator.serviceWorker
      : undefined,
});

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing the #root element");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppUpdatesContext value={appUpdates}>
        <RouterProvider router={router} />
      </AppUpdatesContext>
    </QueryClientProvider>
  </StrictMode>,
);

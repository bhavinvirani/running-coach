import "@/styles/globals.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { createQueryClient } from "./query-client";
import { createAppRouter } from "./router";

const queryClient = createQueryClient({
  onUnauthorized: () => {
    if (router.state.location.pathname !== "/login") void router.navigate("/login");
  },
});
const router = createAppRouter(queryClient);

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing the #root element");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

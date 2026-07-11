import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, TooltipProvider } from "raft-ui";
import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* raft-ui "elegant" theme family (light mode) — sets data-theme so raft-ui
        components render in the elegant style. Rollout starts here (task #129). */}
    <ThemeProvider theme="elegant" defaultMode="light">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
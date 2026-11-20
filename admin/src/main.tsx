import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, TooltipProvider } from "@botiverse/raft-ui";
import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import { LocaleProvider } from "./lib/locale";
import "@botiverse/raft-ui/fonts.css";
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
    {/* Raft has one look in light and dark mode. The mode persists per
        browser and is switchable from the account menu; index.html restores
        the same key before first paint. */}
    <ThemeProvider defaultMode="light" storageKey="hands-admin-mode">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <LocaleProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </LocaleProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
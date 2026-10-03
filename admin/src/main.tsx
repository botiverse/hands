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
    {/* raft-ui theme control plane: Elegant is the default family (light mode);
        the choice persists per browser and is switchable from Settings →
        Appearance. The same storage keys are restored before first paint by
        the inline script in index.html. */}
    <ThemeProvider
      defaultTheme="elegant"
      defaultMode="light"
      storageKey="hands-admin-theme"
    >
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
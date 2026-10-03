// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ThemeProvider } from "raft-ui";
import { AppearanceSettings } from "./AppearanceSettings";

beforeAll(() => {
  // jsdom ships without matchMedia, while raft-ui's ThemeProvider reads the
  // system mode through it. A light-mode stub keeps the provider renderable;
  // these tests never rely on the system preference.
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    });
  }
});

function renderAppearance(storageKey: string) {
  return render(
    <ThemeProvider
      defaultTheme="elegant"
      defaultMode="light"
      storageKey={storageKey}
    >
      <AppearanceSettings />
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  const root = document.documentElement;
  delete root.dataset.theme;
  root.classList.remove("light", "dark");
  root.style.colorScheme = "";
});

describe("AppearanceSettings", () => {
  it("switches the theme family and persists it", () => {
    renderAppearance("appearance-family-test");
    const root = document.documentElement;
    expect(root.dataset.theme).toBe("elegant");

    fireEvent.click(screen.getByTestId("appearance-theme-brutal"));
    expect(root.dataset.theme).toBe("brutal");
    expect(window.localStorage.getItem("appearance-family-test")).toBe("brutal");

    fireEvent.click(screen.getByTestId("appearance-theme-elegant"));
    expect(root.dataset.theme).toBe("elegant");
    expect(window.localStorage.getItem("appearance-family-test")).toBe(
      "elegant",
    );
  });

  it("switches dark mode and persists it", () => {
    renderAppearance("appearance-mode-test");
    const root = document.documentElement;
    expect(root.classList.contains("light")).toBe(true);

    fireEvent.click(screen.getByTestId("appearance-mode-dark"));
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.classList.contains("light")).toBe(false);
    expect(window.localStorage.getItem("appearance-mode-test-mode")).toBe(
      "dark",
    );

    fireEvent.click(screen.getByTestId("appearance-mode-light"));
    expect(root.classList.contains("light")).toBe(true);
    expect(window.localStorage.getItem("appearance-mode-test-mode")).toBe(
      "light",
    );
  });

  it("keeps the mode control inert while Brutal is active", () => {
    renderAppearance("appearance-disabled-test");
    const root = document.documentElement;

    fireEvent.click(screen.getByTestId("appearance-theme-brutal"));
    expect(root.dataset.theme).toBe("brutal");

    // Brutal is light-only: interacting with the mode control must not leave
    // dark mode active or write a dark mode to storage.
    fireEvent.click(screen.getByTestId("appearance-mode-dark"));
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.dataset.theme).toBe("brutal");
    expect(window.localStorage.getItem("appearance-disabled-test-mode")).toBe(
      "light",
    );
  });
});

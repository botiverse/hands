// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "raft-ui";
import { PublicLanding } from "./App";
import { LocaleProvider, LOCALE_COOKIE, LOCALE_STORAGE } from "./lib/locale";

describe("public landing language", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) });
    localStorage.setItem(LOCALE_STORAGE, "en");
    document.cookie = `${LOCALE_COOKIE}=; Path=/; Max-Age=0`;
  });
  afterEach(cleanup);

  it("changes page copy and routes to the matching documentation and legal pages", () => {
    render(<ThemeProvider><LocaleProvider><PublicLanding /></LocaleProvider></ThemeProvider>);
    expect(screen.getByRole("heading", { name: "Ship it, roll it out, hear it break, fix it." })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "zh-CN" } });
    expect(screen.getByRole("heading", { name: "发布应用、逐步推广、收集问题、持续修复。" })).toBeTruthy();
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: "文档" }).getAttribute("href")).toBe("/docs/zh/");
    expect(within(footer).getByRole("link", { name: "隐私政策" }).getAttribute("href")).toBe("/zh/privacy/");
    expect(within(footer).getByRole("link", { name: "服务条款" }).getAttribute("href")).toBe("/zh/terms/");
    fireEvent.change(screen.getByRole("combobox", { name: "语言" }), { target: { value: "en" } });
    expect(within(footer).getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("/docs/");
    expect(within(footer).getByRole("link", { name: "Privacy Policy" }).getAttribute("href")).toBe("/privacy/");
  });
});

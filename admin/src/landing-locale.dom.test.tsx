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
    const header = screen.getByRole("banner");
    const footer = screen.getByRole("contentinfo");
    expect(within(header).queryByRole("combobox", { name: "Language" })).toBeNull();
    expect(within(header).queryByRole("group", { name: "Language" })).toBeNull();
    const languages = within(footer).getByRole("group", { name: "Language" });
    expect(within(languages).getByRole("button", { name: "English" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(languages).getByRole("button", { name: "简体中文" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(within(languages).getByRole("button", { name: "简体中文" }));
    expect(screen.getByRole("heading", { name: "发布应用、逐步推广、收集问题、持续修复。" })).toBeTruthy();
    expect(within(footer).getByRole("group", { name: "语言" })).toBe(languages);
    expect(within(languages).getByRole("button", { name: "简体中文" }).getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(LOCALE_STORAGE)).toBe("zh-CN");
    expect(within(footer).getByRole("link", { name: "文档" }).getAttribute("href")).toBe("/docs/zh/");
    expect(within(footer).getByRole("link", { name: "隐私政策" }).getAttribute("href")).toBe("/zh/privacy/");
    expect(within(footer).getByRole("link", { name: "服务条款" }).getAttribute("href")).toBe("/zh/terms/");
    fireEvent.click(within(languages).getByRole("button", { name: "English" }));
    expect(within(footer).getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("/docs/");
    expect(within(footer).getByRole("link", { name: "Privacy Policy" }).getAttribute("href")).toBe("/privacy/");
  });
});

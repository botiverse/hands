// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LanguagePicker, LocaleProvider, LOCALE_COOKIE, LOCALE_STORAGE, preferredLocale, useText } from "./locale";

function Example() {
  const t = useText();
  return <><LanguagePicker /><label>{t("Name", "名称")}<input /></label></>;
}

describe("language preference", () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = `${LOCALE_COOKIE}=; Path=/; Max-Age=0`;
  });
  afterEach(cleanup);

  it("honors browser language priority and has an English fallback", () => {
    expect(preferredLocale(["en-US", "zh-CN"])).toBe("en");
    expect(preferredLocale(["fr", "zh-Hans-CN", "en-US"])).toBe("zh-CN");
    expect(preferredLocale(["fr"])).toBe("en");
  });

  it("switches immediately, preserves form input and restores the explicit choice", () => {
    localStorage.setItem(LOCALE_STORAGE, "en");
    const first = render(<LocaleProvider><Example /></LocaleProvider>);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "demo" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "zh-CN" } });
    expect((screen.getByRole("textbox", { name: "名称" }) as HTMLInputElement).value).toBe("demo");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=zh-CN`);
    first.unmount();
    render(<LocaleProvider><Example /></LocaleProvider>);
    expect(screen.getByRole("textbox", { name: "名称" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "语言" }) as HTMLSelectElement).value).toBe("zh-CN");
  });

  it("picks up a shared-cookie change when the user returns from another Hands page", () => {
    localStorage.setItem(LOCALE_STORAGE, "en");
    render(<LocaleProvider><Example /></LocaleProvider>);
    document.cookie = `${LOCALE_COOKIE}=zh-CN; Path=/`;
    fireEvent.focus(window);
    expect(screen.getByRole("textbox", { name: "名称" })).toBeTruthy();
  });
});

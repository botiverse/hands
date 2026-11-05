// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "raft-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider, LOCALE_STORAGE } from "../lib/locale";
import { OrgSwitcher } from "./OrgSwitcher";

describe("organization switcher", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE, "en");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ orgs: [
      { id: "org-1", name: "Raft", external_provider: "raft" },
    ] }));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("offers the Raft authorization flow alongside existing organizations", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><LocaleProvider>
      <DropdownMenu defaultOpen><DropdownMenuTrigger>Organizations</DropdownMenuTrigger>
        <DropdownMenuContent><OrgSwitcher currentOrgId="org-1" buttonLabel="Switch organization" /></DropdownMenuContent>
      </DropdownMenu>
    </LocaleProvider></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText("Raft")).toBeTruthy();
    const add = screen.getByText("Add Raft server").closest("a");
    expect(add?.getAttribute("href")).toBe("/api/auth/login?return=%2Fapps%3Fhands_connect_server%3D1");
    expect(screen.getByText("Organization settings")).toBeTruthy();
  });
});

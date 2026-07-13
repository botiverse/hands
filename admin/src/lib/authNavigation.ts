import { loginUrl, type AuthAccount } from "./api";

export function dashboardHref(account?: AuthAccount): string {
  return account ? "/apps" : loginUrl("/apps");
}

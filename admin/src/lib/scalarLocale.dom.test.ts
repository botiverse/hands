// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { scalarChineseLabels } from "../../../worker/src/lib/scalar_locale";

afterEach(() => { document.body.innerHTML = ""; });

it("localizes Scalar controls added later without altering API example content", async () => {
  document.body.innerHTML = '<div id="app"><button class="scalar-code-copy" aria-label="Copy JSON code"><span>Copy</span></button><pre><code>Copy</code></pre></div>';
  window.eval(scalarChineseLabels);
  await waitFor(() => expect(document.querySelector(".scalar-code-copy")?.getAttribute("aria-label")).toBe("复制 JSON 代码"));
  expect(document.querySelector(".scalar-code-copy span")?.textContent).toBe("复制");
  expect(document.querySelector("code")?.textContent).toBe("Copy");
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.innerHTML = '<button><span class="sr-only">Open Group</span></button><div role="group" aria-label="Code sample"></div>';
  document.body.append(dialog);
  await waitFor(() => expect(dialog.querySelector(".sr-only")?.textContent).toBe("打开分组"));
  expect(dialog.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("代码示例");
});

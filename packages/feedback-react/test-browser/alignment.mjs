/** Real-browser layout regression. Run after `pnpm exec playwright install chromium`. */
import { mkdtemp, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const uiPackage = process.env.RAFT_UI_TEST_PACKAGE ?? "@botiverse/raft-ui";
const uiDir = join(require.resolve(`${uiPackage}/package.json`), "..");
const temp = await mkdtemp(join(tmpdir(), "hands-feedback-layout-"));
function nearScroll(actual, expected, mode) {
  assert.ok(Math.abs(actual - expected) <= 1, `${mode}: scroll position ${actual} != ${expected}`);
}
let server;
let browser;
try {
  await copyFile(join(pkg, "test-browser/index.html"), join(temp, "index.html"));
  await build({
    entryPoints: [join(pkg, "test-browser/fixture.tsx")],
    bundle: true,
    format: "esm",
    outfile: join(temp, "bundle.js"),
    alias: { "@botiverse/raft-ui": join(uiDir, "dist/index.mjs") },
    jsx: "automatic",
    logLevel: "silent",
  });
  const cssEntry = join(temp, "entry.css");
  const source = `@import "${pkg}/node_modules/tailwindcss/index.css";\n`
    + `@source "${pkg}/src";\n@import "${uiDir}/dist/styles.css";\n`
    + `@source "${uiDir}/dist";\n@import "${pkg}/src/styles.css";\n`;
  await writeFile(cssEntry, source);
  execFileSync(resolve(pkg, "node_modules/.bin/tailwindcss"), [
    "-i", cssEntry, "-o", join(temp, "bundle.css"),
  ], { cwd: pkg, stdio: "pipe" });
  console.log(`Using ${uiPackage} ${require(`${uiPackage}/package.json`).version}`);
  server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const names = { "/": "index.html", "/bundle.js": "bundle.js", "/bundle.css": "bundle.css" };
    const name = names[path];
    if (!name) { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
    res.end(await readFile(join(temp, name)));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });

  for (const mode of [
    { name: "desktop mouse", width: 1200, hasTouch: false, inset: 16 },
    { name: "narrow mouse", width: 390, hasTouch: false, inset: 16 },
    { name: "narrow touch", width: 390, hasTouch: true, inset: 20 },
    { name: "wide touch", width: 1200, hasTouch: true, inset: 20 },
  ]) {
    const context = await browser.newContext({
      viewport: { width: mode.width, height: 650 },
      hasTouch: mode.hasTouch,
      isMobile: mode.hasTouch,
    });
    const page = await context.newPage();
    // The host HTML sets conflicting page-inset and native-scrollbar tokens;
    // the overlay inbox must still keep its input-specific edge on both sides.
    const failures = [];
    page.on("pageerror", (error) => failures.push(error.message));
    const dimensions = async () => page.evaluate(() => {
      const rect = (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Missing ${selector}`);
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      };
      const scroll = document.querySelector("[data-feedback-list-scroll]");
      const root = document.querySelector(".hands-feedback-inbox");
      const toolbar = document.querySelector(".hands-feedback-toolbar");
      return {
        root: rect(".hands-feedback-inbox"),
        toolbar: rect(".hands-feedback-toolbar"),
        toolbarPaddingLeft: parseFloat(getComputedStyle(toolbar).paddingLeft),
        toolbarPaddingRight: parseFloat(getComputedStyle(toolbar).paddingRight),
        banner: rect("[data-slot='banner']"),
        row: rect("[data-ticket-row]"),
        title: rect("[data-slot='inbox-item-title']"),
        timestamp: rect("[data-slot='inbox-item-timestamp']"),
        scrollClientWidth: scroll.clientWidth,
        scrollOffsetWidth: scroll.offsetWidth,
        scrollHeight: scroll.scrollHeight,
        clientHeight: scroll.clientHeight,
        scrollTop: scroll.scrollTop,
        scrollbar: Boolean(scroll.parentElement.querySelector("[data-feedback-list-scrollbar]")),
        scrollbarWidth: getComputedStyle(scroll).scrollbarWidth,
        cellInsets: getComputedStyle(scroll).getPropertyValue("--scrollbar-size").trim(),
        pointerFine: matchMedia("(pointer: fine)").matches,
        pointerCoarse: matchMedia("(pointer: coarse)").matches,
        listLabel: document.querySelector("ul.hands-feedback-ticket-list")?.getAttribute("aria-label"),
        heading: root.querySelector("h2")?.textContent,
      };
    });
    await page.goto(`${base}/?many=1&rtl=1`);
    await page.waitForSelector("[data-feedback-list-scrollbar]", { state: "attached" });
    const rtl = await dimensions();
    const rtlNear = (a, b, label) => assert.ok(Math.abs(a - b) <= 0.6, `${mode.name} RTL ${label}: ${a} != ${b}`);
    rtlNear(rtl.banner.left, rtl.root.left + mode.inset, "banner left");
    rtlNear(rtl.banner.right, rtl.root.right - mode.inset, "banner right");
    rtlNear(rtl.title.right, rtl.banner.right, "row start");
    rtlNear(rtl.timestamp.left, rtl.banner.left, "row end");
    rtlNear(rtl.scrollClientWidth, rtl.scrollOffsetWidth, "overlay width");
    await page.goto(`${base}/?long=1`);
    await page.waitForSelector("[data-ticket-row]");
    const longLayout = await page.locator("[data-feedback-list-scroll]").evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    assert.ok(longLayout.scrollWidth <= longLayout.clientWidth + 1, `${mode.name} unbroken title stays within the viewport`);
    await page.goto(`${base}/?empty=1`);
    const empty = page.locator(".hands-feedback-empty");
    await empty.waitFor();
    const emptyLayout = await empty.evaluate((el) => {
      const viewport = el.closest("[data-feedback-list-scroll]");
      return { height: el.getBoundingClientRect().height, available: viewport.clientHeight, overflow: viewport.scrollHeight > viewport.clientHeight };
    });
    assert.ok(emptyLayout.height > 0 && emptyLayout.height >= emptyLayout.available / 2, `${mode.name} empty state fills the list`);
    assert.equal(emptyLayout.overflow, false, `${mode.name} empty state fits`);
    let withoutScroll;
    for (const many of [false, true]) {
      await page.goto(`${base}/?many=${many ? 1 : 0}`);
      await page.waitForSelector("[data-ticket-row]");
      if (many) await page.waitForSelector("[data-feedback-list-scrollbar]", { state: "attached" });
      const d = await dimensions();
      const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 0.6, `${mode.name} ${many ? "overflow" : "short"}: ${label}: ${a} != ${b}`);
      near(d.toolbarPaddingLeft, mode.inset, "toolbar left inset");
      near(d.toolbarPaddingRight, mode.inset, "toolbar right inset");
      near(d.banner.left, d.root.left + mode.inset, "banner left");
      near(d.banner.right, d.root.right - mode.inset, "banner right");
      near(d.title.left, d.banner.left, "row left");
      near(d.timestamp.right, d.banner.right, "row right");
      near(d.scrollClientWidth, d.scrollOffsetWidth, "scrollbar occupies no width");
      assert.equal(d.scrollbarWidth, "none");
      assert.equal(d.cellInsets, "0px");
      assert.equal(d.pointerFine, !mode.hasTouch, `${mode.name} primary pointer is fine`);
      assert.equal(d.pointerCoarse, mode.hasTouch, `${mode.name} primary pointer is coarse`);
      assert.equal(d.listLabel, "My feedback");
      assert.equal(d.heading, "My feedback");
      if (many) {
        assert.ok(d.scrollHeight > d.clientHeight, `${mode.name} must really overflow`);
        assert.equal(d.scrollbar, true, `${mode.name} overlay scrollbar exists`);
        near(d.banner.right, withoutScroll.banner.right, "overflow preserves right edge");
        await page.locator("[data-feedback-list-scroll]").hover();
        await page.mouse.wheel(0, 240);
        await page.waitForFunction(() => document.querySelector("[data-feedback-list-scroll]").scrollTop > 0);
        const scrolled = await dimensions();
        assert.ok(scrolled.scrollTop > 0, `${mode.name} scrolls`);
        if (!mode.hasTouch) {
          // The overlay track is functional, not just a hidden native scrollbar.
          const track = page.locator("[data-feedback-list-scrollbar]");
          await track.hover();
          await page.waitForFunction(() => {
            const thumb = document.querySelector(".hands-feedback-scrollbar-thumb");
            return thumb && thumb.getBoundingClientRect().height > 0;
          });
          const thumb = await page.locator(".hands-feedback-scrollbar-thumb").boundingBox();
          await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
          await page.mouse.down();
          await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2 + 45, { steps: 6 });
          await page.mouse.up();
          const afterDrag = await page.locator("[data-feedback-list-scroll]").evaluate((el) => el.scrollTop);
          assert.ok(afterDrag > scrolled.scrollTop + 20, `${mode.name} overlay thumb drags`);
        }
      } else {
        withoutScroll = d;
        assert.ok(d.scrollHeight <= d.clientHeight, `${mode.name} short list does not overflow`);
      }
      assert.deepEqual(failures, []);
    }
    if (mode.hasTouch) {
      // Dispatch a real DOM touch gesture on the actual viewport: a pull from
      // the top refreshes, while an identical pull after scrolling does not.
      const pull = async () => page.locator("[data-feedback-list-scroll]").evaluate((el) => {
        const point = (y) => new Touch({ identifier: 1, target: el, clientX: 100, clientY: y });
        el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [point(20)] }));
        el.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [point(180)] }));
        el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [] }));
      });
      const viewport = page.locator("[data-feedback-list-scroll]");
      await viewport.evaluate((el) => { el.scrollTop = 0; });
      const initialCalls = await page.evaluate(() => window.feedbackFixture.count);
      await pull();
      await page.waitForFunction((n) => window.feedbackFixture.count === n + 1, initialCalls);
      await page.waitForFunction(() => document.querySelector("[data-feedback-pull-state]").dataset.feedbackPullState === "idle");
      await viewport.evaluate((el) => { el.scrollTop = 120; });
      await pull();
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.feedbackFixture.count), initialCalls + 1, `${mode.name} only refreshes at top`);
    }
    // The existing workspace keeps its inbox mounted and restores both scroll
    // and ticket focus after a detail view returns.
    const row = page.getByRole("button", { name: "Alignment test ticket 3" });
    await row.focus();
    await page.locator("[data-feedback-list-scroll]").evaluate((el) => {
      const row = el.querySelector('[data-ticket-id="ticket-3"]');
      el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - 30;
    });
    const position = await page.locator("[data-feedback-list-scroll]").evaluate((el) => el.scrollTop);
    assert.ok(position > 0, `${mode.name}: scrolled before opening detail`);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Back" }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-ticket-id") === "ticket-3");
    const restored = await page.locator("[data-feedback-list-scroll]").evaluate((el) => el.scrollTop);
    nearScroll(restored, position, mode.name);
    console.log(`PASS ${mode.name}: toolbar, banner and row match both edges with and without overflow`);
    await context.close();
  }
} finally {
  await browser?.close();
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  await rm(temp, { recursive: true, force: true });
}

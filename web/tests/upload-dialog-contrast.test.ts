import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function luminance(hex: string) {
  const channels = hex.match(/[0-9a-f]{2}/gi)!.map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test("upload dialog explicitly resets readable foregrounds on its paper surface", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.upload-dialog \{[\s\S]*?background: var\(--paper\);\s*color: #11120f;/);
  assert.match(css, /\.upload-dialog \.form-grid input::placeholder,[\s\S]*?color: #5b5d55;\s*opacity: 1;/);
  assert.match(css, /\.upload-dialog \.file-drop,[\s\S]*?\.upload-dialog \.rights-check,[\s\S]*?color: #242620;/);
  assert.match(css, /\.upload-dialog \.file-drop \{\s*border-color: #66675f;/);
  assert.match(css, /\.upload-dialog \.form-grid input,[\s\S]*?border-bottom-color: #66675f;/);
  assert.match(css, /\.upload-dialog \.form-grid input:focus,[\s\S]*?border-color: #9f2818;/);
  assert.match(css, /\.upload-dialog \.form-error \{[\s\S]*?color: #9f2818;/);
  assert.match(css, /\.upload-dialog \.file-drop:disabled,[\s\S]*?color: #4f514a;\s*opacity: 1;/);
  for (const foreground of ["11120f", "242620", "55574f", "5b5d55", "9f2818", "4f514a", "66675f"]) {
    assert(contrast(foreground, "f4f1e9") >= 4.5, `${foreground} must remain readable on the upload paper`);
  }
});

test("upload dialog contrast applies to desktop and the existing 390px single-column form", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /@media[^\{]*max-width:[^\{]*\{[\s\S]*?\.upload-dialog \{[\s\S]*?min-height: 100vh;/);
  assert.match(css, /@media[^\{]*max-width:[^\{]*\{[\s\S]*?\.form-grid \{\s*grid-template-columns: 1fr;/);
});

test("the user menu is repainted for the dark surface instead of staying a white pill", async () => {
  const surface = await readFile(new URL("../components/v04/V04Surface.module.css", import.meta.url), "utf8");
  // 案例库和工作台用的是 .siteHeader；只覆盖 .productHeader 时，这里就是白底浅字。
  assert.match(surface, /\.productHeader :global\(\.user-menu-trigger\), \.siteHeader :global\(\.user-menu-trigger\)/);
  assert.match(surface, /\.siteHeader :global\(\.user-menu-popover\)/);
  assert.match(surface, /\.siteHeader :global\(\.user-menu-trigger > span\)/);
  // 顶栏底色 #171815 与正文色 #e6e7df、头像盘 #2e302a 与酸绿 #dfff4f 都要读得出来。
  assert(contrast("e6e7df", "171815") >= 4.5, "user name must stay readable on the dark header");
  assert(contrast("dfff4f", "2e302a") >= 4.5, "avatar initial must stay readable on its disc");
  assert(contrast("92958b", "171815") >= 4.5, "the popover's secondary line must stay readable");
});

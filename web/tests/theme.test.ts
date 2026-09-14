import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_THEME_PREFERENCE,
  parseThemePreference,
  themeCookie,
  themePreferenceFromCookieHeader,
} from "../lib/theme";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function tokenBlock(css: string, selector: RegExp): Map<string, string> {
  const match = css.match(selector);
  assert(match, `token block ${selector} is missing`);
  return new Map([...match[1].matchAll(/(--v04-[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

async function themeBlocks() {
  const css = await read("app/globals.css");
  return {
    dark: tokenBlock(css, /:root,\s*\[data-v04-scheme="dark"\] \{([^}]*)\}/),
    light: tokenBlock(css, /:root\[data-theme="light"\] \{([^}]*)\}/),
    system: tokenBlock(css, /@media \(prefers-color-scheme: light\) \{\s*:root\[data-theme="system"\] \{([^}]*)\}/),
  };
}

function luminance(hex: string) {
  const channels = hex.replace("#", "").match(/[0-9a-f]{2}/gi)!.map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test("theme preference: only dark / light / system survive parsing, anything else falls back to dark", () => {
  assert.equal(DEFAULT_THEME_PREFERENCE, "dark");
  assert.equal(parseThemePreference("light"), "light");
  assert.equal(parseThemePreference("system"), "system");
  assert.equal(parseThemePreference("dark"), "dark");
  for (const junk of [undefined, null, "", "LIGHT", "sepia", "light; Path=/"]) {
    assert.equal(parseThemePreference(junk), "dark");
  }
});

test("theme cookie: one year, whole site, Lax, Secure only on https", () => {
  assert.equal(themeCookie("light", { secure: false }), "hm-theme=light; Path=/; Max-Age=31536000; SameSite=Lax");
  assert.equal(themeCookie("system", { secure: true }), "hm-theme=system; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
  assert.equal(themePreferenceFromCookieHeader("a=1; hm-theme=light; b=2"), "light");
  assert.equal(themePreferenceFromCookieHeader("a=1"), "dark");
  assert.equal(themePreferenceFromCookieHeader("hm-theme=bogus"), "dark");
});

test("root layout renders the saved preference onto <html data-theme> so the first paint is already right", async () => {
  const layout = await read("app/layout.tsx");
  assert.match(layout, /\(await cookies\(\)\)\.get\(THEME_COOKIE\)/);
  assert.match(layout, /<html lang="zh-CN" data-theme=\{theme\}>/);
  assert.match(layout, /<ThemeProvider initialPreference=\{theme\}>/);
});

test("the light palette is written twice (manual light, system-light) and both copies are identical", async () => {
  const { light, system } = await themeBlocks();
  assert.deepEqual([...system.entries()], [...light.entries()]);
});

test("every token has a value in both themes, so nothing silently falls back to the other palette", async () => {
  const { dark, light } = await themeBlocks();
  assert.deepEqual([...light.keys()].sort(), [...dark.keys()].sort());
  assert.equal(dark.get("--v04-scheme"), "dark");
  assert.equal(light.get("--v04-scheme"), "light");
  // 深色那组就是上线以来的原值，改它等于改了所有没切换过的人的界面。
  assert.equal(dark.get("--v04-bg"), "#10110f");
  assert.equal(dark.get("--v04-ink"), "#e6e7df");
  assert.equal(dark.get("--v04-accent"), "#dfff4f");
});

test("light palette text colors stay readable on the light page and panel backgrounds", async () => {
  const { light } = await themeBlocks();
  const backgrounds = ["--v04-bg", "--v04-panel"].map((name) => light.get(name)!);
  for (const name of ["--v04-ink", "--v04-ink-soft", "--v04-ink-dim", "--v04-muted", "--v04-subject", "--v04-accent", "--v04-warn", "--v04-warn-soft", "--v04-warn-ink", "--v04-gold", "--v04-danger", "--v04-danger-2", "--v04-info"]) {
    for (const background of backgrounds) {
      assert(contrast(light.get(name)!, background) >= 4.5, `${name} on ${background} must be at least 4.5:1`);
    }
  }
  // 实心酸绿按钮上的字，两种主题下都是深字压酸绿。
  assert(contrast(light.get("--v04-on-accent")!, light.get("--v04-accent-fill")!) >= 7);
});

test("the V0.4 shell no longer declares its own colours — a local declaration would pin it to dark", async () => {
  for (const path of [
    "components/v04/V04Surface.module.css",
    "components/report/library/ReportLibrary.module.css",
    "components/report/studio/ReportStudio.module.css",
    "components/report/studio/deck/ReportDeck.module.css",
    "components/shared/DeleteConfirmDialog.module.css",
    "components/shared/LibraryToast.module.css",
    "components/shared/ThemeSwitcher.module.css",
  ]) {
    const css = (await read(path)).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(css, /--v04-[a-z0-9-]+\s*:/, `${path} must not declare --v04-* tokens`);
  }
});

// 媒体区（封面、播放器、报告大图舞台、页码条）两种主题都是深色，允许写死颜色；
// 其余规则里再出现写死的颜色，浅色主题下就会冒出一块深色补丁。
const ALLOWED_LITERAL_SELECTORS: Record<string, RegExp> = {
  "components/v04/V04Surface.module.css":
    /^\.(existing(CardProjection|WorkStatus|ExpertGrade|CardActions)|poster|posterFallback|posterBrand|videoShell|videoPlaceholder)\b|^\.videoFloating\.videoMinimized \.videoMinButton/,
  "components/report/library/ReportLibrary.module.css": /^\.cover/,
  "components/report/studio/ReportStudio.module.css": /^$/,
  "components/report/studio/deck/ReportDeck.module.css": /^\.(ovstage|ovbOn|stripCell\w*|readerBody)\b/,
  "components/shared/DeleteConfirmDialog.module.css": /^$/,
  "components/shared/LibraryToast.module.css": /^$/,
  "components/shared/ThemeSwitcher.module.css": /^$/,
};

test("themed stylesheets only use colour tokens outside the always-dark media areas", async () => {
  for (const [path, allowed] of Object.entries(ALLOWED_LITERAL_SELECTORS)) {
    const css = (await read(path)).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1].trim();
      const literals = rule[2].match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g);
      if (!literals) continue;
      assert.match(selector, allowed, `${path}: "${selector}" hardcodes ${literals.join(", ")} — use a --v04-* token`);
    }
  }
});

test("media areas are marked as dark islands so their tokens resolve to the dark palette", async () => {
  const [card, player, library, pageModal, reader, deckCss] = await Promise.all([
    read("components/report/library/ReportCard.tsx"),
    read("components/v04/V04VideoPlayer.tsx"),
    read("components/v04/V04LibraryClient.tsx"),
    read("components/report/studio/deck/ReportPageModal.tsx"),
    read("components/report/studio/deck/ReportReader.tsx"),
    read("components/report/studio/deck/ReportDeck.module.css"),
  ]);
  assert.equal(card.match(/data-v04-scheme="dark"/g)?.length, 2, "both the ready link and the busy button covers");
  assert.match(player, /data-v04-scheme="dark"/);
  assert.match(library, /className=\{styles\.poster\} data-v04-scheme="dark"/);
  assert.match(pageModal, /className=\{styles\.ovstage\} data-v04-scheme="dark"/);
  assert.match(pageModal, /className=\{styles\.ovfootStrip\} data-v04-scheme="dark"/);
  assert.match(reader, /className=\{styles\.readerBody\} data-v04-scheme="dark"/);
  // --rd-* 是 --v04-* 的别名，岛里要重新声明，否则拿到的是外层按浅色算好的值。
  assert.match(deckCss, /\.root,\s*\.root \[data-v04-scheme\] \{\s*--rd-bg: var\(--v04-bg\);/);
});

test("every V0.4 page header carries the appearance switcher", async () => {
  for (const path of [
    "components/v04/V04LibraryClient.tsx",
    "components/v04/V04StudioClient.tsx",
    "components/v04/V04DetailClient.tsx",
    "components/v04/V04WorkspaceClient.tsx",
    "components/report/studio/ReportStudioClient.tsx",
    "components/report/studio/ReportStatusPage.tsx",
  ]) {
    const source = await read(path);
    assert.match(source, /import ThemeSwitcher from "@\/components\/shared\/ThemeSwitcher";/, path);
    assert.match(source, /<ThemeSwitcher \/>/, path);
  }
});

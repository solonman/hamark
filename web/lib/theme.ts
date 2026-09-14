/**
 * 深色／浅色外观偏好。
 *
 * 偏好只存在浏览器的 cookie 里（不进数据库）：根布局读它，直接把
 * `<html data-theme>` 渲染成对的值，首屏就是对的颜色，不会先闪一下深色再变浅。
 * 「跟随系统」不在服务端解析——服务端看不到访问者电脑的设置——而是交给
 * globals.css 里 `prefers-color-scheme` 媒体查询，系统一变页面跟着变，不需要脚本。
 */

export const THEME_COOKIE = "hm-theme";

/** 同一浏览器里其它已打开的标签页靠这个频道同步，不用各自刷新。 */
export const THEME_CHANNEL = "hm-theme";

export const THEME_PREFERENCES = ["dark", "light", "system"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** 没选过的人看到的样子：维持上线以来的深色，不因为多了开关就替谁换掉。 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "dark";

export const THEME_LABELS: Record<ThemePreference, string> = {
  dark: "深色",
  light: "浅色",
  system: "跟随系统",
};

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference)
    ? (value as ThemePreference)
    : DEFAULT_THEME_PREFERENCE;
}

export function themeCookie(preference: ThemePreference, options: { secure: boolean }): string {
  return [
    `${THEME_COOKIE}=${preference}`,
    "Path=/",
    `Max-Age=${ONE_YEAR_SECONDS}`,
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

/** 从 `document.cookie` 这种 `a=1; b=2` 串里取出偏好。 */
export function themePreferenceFromCookieHeader(header: string): ThemePreference {
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === THEME_COOKIE) return parseThemePreference(rest.join("="));
  }
  return DEFAULT_THEME_PREFERENCE;
}

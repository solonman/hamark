import { V04_UNSAFE_EDITING_MESSAGE, V04_UNSUPPORTED_BROWSER_MESSAGE } from "@/lib/v04-browser-compat";

export default function V04BrowserCompatibilityMessage({
  mode,
  checking = false,
}: {
  mode: "READ" | "EDIT";
  checking?: boolean;
}) {
  const title = checking ? "正在确认浏览器兼容性…" : "请升级或更换浏览器";
  const message = checking
    ? "系统正在确认当前浏览器能够安全显示页面并保护草稿。"
    : mode === "EDIT" ? V04_UNSAFE_EDITING_MESSAGE : V04_UNSUPPORTED_BROWSER_MESSAGE;
  return (
    <main
      data-v04-browser-compatibility={checking ? "checking" : "blocked"}
      data-v04-editing-blocked={mode === "EDIT" && !checking ? "true" : undefined}
      style={{ minHeight: "100vh", padding: "48px 20px", background: "#f4f1e9", color: "#11120f" }}
    >
      <section style={{ maxWidth: 720, margin: "12vh auto 0", padding: 32, border: "2px solid #11120f", background: "#fffefa" }}>
        <p style={{ margin: "0 0 12px", fontWeight: 800, letterSpacing: "0.08em" }}>RE:VERSE 反写</p>
        <h1 style={{ margin: "0 0 16px", fontSize: 32, lineHeight: 1.2 }}>{title}</h1>
        <p style={{ margin: 0, fontSize: 17, lineHeight: 1.7 }}>{message}</p>
      </section>
    </main>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import UserMenu, { type UserMenuUser } from "@/app/components/UserMenu";
import DeleteConfirmDialog from "@/components/shared/DeleteConfirmDialog";
import { LibraryToastStack, useLibraryToast } from "@/components/shared/LibraryToast";
import ThemeSwitcher from "@/components/shared/ThemeSwitcher";
import v04 from "@/components/v04/V04Surface.module.css";
import { formatShortDateTime } from "@/lib/date-format";
import styles from "./AgentTokens.module.css";

type TokenView = {
  id: string;
  name: string;
  hint: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

const API_BASE = "/api/agent/v1";

async function readJson(response: Response) {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

const when = (value: string | null) => (value ? formatShortDateTime(value) : "—");

export default function AgentTokensClient({ user }: { user: UserMenuUser }) {
  const { toasts, notify } = useLibraryToast();
  const [tokens, setTokens] = useState<TokenView[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<{ id: string; name: string; token: string } | null>(null);
  const [revoking, setRevoking] = useState<TokenView | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeError, setRevokeError] = useState("");
  const [origin, setOrigin] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/agent-tokens", { cache: "no-store" });
    const data = await readJson(response);
    if (!response.ok) {
      setLoadError(String(data.error ?? "令牌列表读取失败，请刷新重试。"));
      return;
    }
    setLoadError("");
    setTokens((data.tokens as TokenView[]) ?? []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载后才知道当前站点地址，示例命令要用它
    setOrigin(window.location.origin);
    void load();
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    const response = await fetch("/api/agent-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await readJson(response);
    setCreating(false);
    if (!response.ok) {
      notify(String(data.error ?? "生成失败，请稍后重试。"), "warn");
      return;
    }
    const info = data.tokenInfo as TokenView;
    setFresh({ id: info.id, name: info.name, token: String(data.token) });
    setName("");
    await load();
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify("已复制");
    } catch {
      notify("复制失败，请手动选中复制", "warn");
    }
  }

  async function confirmRevoke() {
    if (!revoking) return;
    setRevokePending(true);
    setRevokeError("");
    const response = await fetch(`/api/agent-tokens/${encodeURIComponent(revoking.id)}`, { method: "DELETE" });
    const data = await readJson(response);
    setRevokePending(false);
    if (!response.ok) {
      setRevokeError(String(data.error ?? "停用失败，请稍后重试。"));
      return;
    }
    if (fresh?.id === revoking.id) setFresh(null);
    setRevoking(null);
    notify("已停用");
    await load();
  }

  const example = `curl -H "Authorization: Bearer ${fresh?.token ?? "<令牌>"}" \\\n  "${origin}${API_BASE}/videos?hasAnalysis=true"`;

  return (
    <main className={v04.surface}>
      <header className={v04.siteHeader}>
        <Link href="/" className={v04.brandWordmark}><b>R:</b><span>RE:VERSE</span><small>反写</small></Link>
        <nav className={v04.siteNav} aria-label="站点导航"><span className={v04.activeNav}>外部 Agent 令牌</span></nav>
        <div className={v04.siteUtilities}><Link href="/">回到案例库</Link><ThemeSwitcher /><UserMenu user={user} /></div>
      </header>

      <div className={styles.page}>
        <section className={styles.intro}>
          <p>AGENT ACCESS</p>
          <h1>外部 Agent 令牌</h1>
          <span>
            给站外 Agent 发一枚令牌，它就能只读地拉取视频库与报告库里的案例和拆解作业（默认读集成版）。
            令牌只在生成时显示一次；不用了随时停用，立即失效。每人最多同时有效 10 枚，只看得到自己生成的。
          </span>
        </section>

        <form className={styles.panel} onSubmit={create}>
          <h2>生成新令牌</h2>
          <div className={styles.createRow}>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="给哪个 Agent 用，例如：研究助手"
              maxLength={40}
              aria-label="令牌名称"
            />
            <button type="submit" disabled={creating || !name.trim()}>{creating ? "正在生成…" : "生成令牌"}</button>
          </div>
          {fresh ? (
            <div className={styles.fresh} role="status">
              <b>「{fresh.name}」的令牌——只显示这一次，关掉页面就看不到了</b>
              <div className={styles.tokenLine}>
                <code>{fresh.token}</code>
                <button type="button" onClick={() => copy(fresh.token)}>复制</button>
              </div>
            </div>
          ) : null}
        </form>

        <section className={styles.panel}>
          <h2>我的令牌</h2>
          {loadError ? <p className={styles.error} role="alert">{loadError}</p> : null}
          {!loadError && tokens === null ? <p className={styles.muted}>正在读取…</p> : null}
          {tokens && tokens.length === 0 ? <p className={styles.muted}>还没有生成过令牌。</p> : null}
          {tokens && tokens.length > 0 ? (
            <ul className={styles.list}>
              {tokens.map((token) => (
                <li key={token.id} data-revoked={token.revokedAt ? "true" : undefined}>
                  <div>
                    <b>{token.name}</b>
                    <code>{token.hint}</code>
                  </div>
                  <span>生成 {when(token.createdAt)}</span>
                  <span>最近使用 {when(token.lastUsedAt)}</span>
                  {token.revokedAt ? (
                    <em>已停用 {when(token.revokedAt)}</em>
                  ) : (
                    <button type="button" onClick={() => { setRevokeError(""); setRevoking(token); }}>停用</button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className={styles.panel}>
          <h2>怎么用</h2>
          <p className={styles.muted}>
            请求头带上 <code>Authorization: Bearer 令牌</code>。入口 <code>{API_BASE}</code> 会列出全部端点和参数；
            视频：<code>/videos</code>、<code>/videos/&#123;id&#125;</code>、<code>/videos/&#123;id&#125;/analysis</code>；
            报告：<code>/reports</code>、<code>/reports/&#123;id&#125;</code>、<code>/reports/&#123;id&#125;/analysis</code>。
          </p>
          <div className={styles.tokenLine}>
            <code className={styles.example}>{example}</code>
            <button type="button" onClick={() => copy(example)}>复制</button>
          </div>
        </section>
      </div>

      <DeleteConfirmDialog
        open={revoking !== null}
        eyebrow="REVOKE"
        heading="停用令牌"
        title={revoking?.name ?? ""}
        question={`停用「${revoking?.name ?? ""}」这枚令牌？`}
        lines={["停用后立即失效，用它的 Agent 会收到 401。", "不能恢复；还要用就重新生成一枚。"]}
        confirmLabel="确认停用"
        pendingLabel="正在停用…"
        error={revokeError}
        pending={revokePending}
        onConfirm={confirmRevoke}
        onCancel={() => { if (!revokePending) setRevoking(null); }}
      />
      <LibraryToastStack toasts={toasts} />
    </main>
  );
}

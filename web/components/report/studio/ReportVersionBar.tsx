"use client";

import { useEffect, useRef, useState } from "react";
import type { ReportVersionChain } from "@/lib/report-version-chain";
import { resolveReportVersionAction } from "@/lib/report-studio-state";
import v04styles from "@/components/v04/V04Surface.module.css";

/**
 * 顶栏的版本切换器，样式与交互对齐二合一工作台的版本条（`V04StudioClient.tsx`
 * 里的 `versionSplit`/`versionSegment`/`versionPanel`），去掉报告用不上的
 * 「比较基版」逐处差异那一段——规格没有要求报告版本间的字段级 diff。
 *
 * 按钮该显示什么由 `resolveReportVersionAction`（`lib/report-studio-state.ts`）
 * 纯函数决定：正在看自己的版本不出现按钮；已有自己的版本但正看别人的，
 * 是「切到我的版本」；还没有自己的版本，是「基于此版创建我的版本」。
 */

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toTimeString().slice(0, 8);
}

export type ReportVersionBarProps = {
  chain: ReportVersionChain;
  busy: boolean;
  onSelect: (versionId: string) => void;
  onCreateFromCurrent: () => void;
  onSwitchToMine: (versionId: string) => void;
};

export default function ReportVersionBar({
  chain,
  busy,
  onSelect,
  onCreateFromCurrent,
  onSwitchToMine,
}: ReportVersionBarProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const action = resolveReportVersionAction(chain);
  const versions = [...chain.versions].sort((a, b) => a.number - b.number);
  const final = chain.final;
  const isFinalView = chain.current.isFinal;

  return (
    <div ref={anchorRef} className={v04styles.versionSplitAnchor}>
      <button
        type="button"
        className={v04styles.versionSegment}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={
          isFinalView
            ? `当前版本 集成版（${final?.status === "DONE" ? "已定稿" : "未定稿"}），点击切换版本`
            : `当前版本 v${chain.current.number}（${chain.current.ownerName}），点击切换版本`
        }
        onClick={() => setOpen((current) => !current)}
      >
        {isFinalView ? (
          <>
            <span className={`${v04styles.versionNum} ${v04styles.finalVersionNum}`}>集成版</span>
            {final ? (
              <span className={`${v04styles.finalStatusPill} ${final.status === "DONE" ? v04styles.finalStatusDone : v04styles.finalStatusOpen}`}>
                <span className={v04styles.finalStatusDot} aria-hidden="true" />
                {final.status === "DONE" ? "已定稿" : "未定稿"}
              </span>
            ) : null}
          </>
        ) : (
          // 姓名紧跟版本号，因为它归属的是这个版本；派生关系排在最后并弱化。
          <>
            <span className={v04styles.versionNum}>v{chain.current.number}</span>
            <span className={v04styles.versionOwner}>{chain.current.ownerName}</span>
            {chain.current.baseNumber !== null || chain.current.baseIsFinal ? (
              <span className={v04styles.versionBase}>
                {chain.current.baseIsFinal ? "基于集成版" : `基于 v${chain.current.baseNumber}`}
              </span>
            ) : null}
          </>
        )}
        <span className={v04styles.versionCaret} aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className={v04styles.versionPanel} role="dialog" aria-label="版本链">
          <h4>
            {final
              ? "版本链：集成版置顶；其余每位编辑者一个版本，创建即固定基于当时快照，互不覆盖"
              : "版本链（每位编辑者一个版本，创建即固定基于当时快照）"}
          </h4>
          {final ? (
            <div
              className={`${v04styles.versionRow} ${v04styles.versionRowFinal} ${isFinalView ? v04styles.versionRowCurrent : ""}`.trim()}
              role="button"
              tabIndex={0}
              onClick={() => {
                onSelect("final");
                setOpen(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onSelect("final");
                  setOpen(false);
                }
              }}
            >
              <span className={v04styles.versionNumber}>集成版</span>
              {/* "默认展示"现在跟着浏览者走：自己已有版本时默认展示自己的版本，
                  这个标注就挂到下面普通版本行里 `chain.mineId` 那一条；只有没有
                  自己的版本时，集成版才是默认展示的那一个，标注留在这一行。
                  报告还没有任何真实版本时 `final` 为 null，这一行整体不渲染，
                  默认展示标注保留在下面 `chain.latestId` 对应的虚拟版本行（原规则）。 */}
              {!chain.mineId ? <span className={v04styles.versionLatest}>默认展示</span> : null}
              <span className={`${v04styles.finalStatusPill} ${final.status === "DONE" ? v04styles.finalStatusDone : v04styles.finalStatusOpen}`}>
                <span className={v04styles.finalStatusDot} aria-hidden="true" />
                {final.status === "DONE" ? "已定稿" : "未定稿"}
              </span>
              {final.pendingCount > 0 ? (
                <span className={v04styles.finalPendingBadge}>{final.pendingCount} 处未纳入</span>
              ) : null}
              <span className={v04styles.versionTime}>{formatClock(final.updatedAt)}</span>
              <span className={v04styles.versionDesc}>
                集成版：每一处内容都取各版本里最新的那次修改；进行态自动汇入，定稿后停止；只有老孙能直接编辑。
              </span>
            </div>
          ) : null}
          {versions.map((version) => (
            <div
              key={version.id ?? "virtual"}
              className={`${v04styles.versionRow} ${!isFinalView && chain.current.id === version.id ? v04styles.versionRowCurrent : ""}`.trim()}
              role="button"
              tabIndex={0}
              onClick={() => {
                if (!version.id) return;
                onSelect(version.id);
                setOpen(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && version.id) {
                  onSelect(version.id);
                  setOpen(false);
                }
              }}
            >
              <span className={v04styles.versionNumber}>v{version.number}</span>
              <span className={v04styles.versionMeta}>
                {version.baseIsFinal ? "基于集成版" : version.baseNumber === null ? "初始版本" : `基于 v${version.baseNumber}`}，{version.ownerName}
              </span>
              {version.isMine ? <span className={v04styles.versionMine}>我的</span> : null}
              {/* 自己已有版本时，默认展示的就是这一行（不管它是不是最近更新的
                  那一版）；"最新"只是"最近更新"的信息标注，跟默认展示是两件事，
                  两个标注可能同时出现在同一行。没有集成版（`final` 为 null，
                  报告还没有任何真实版本）时沿用原规则的合并写法。 */}
              {chain.mineId === version.id ? (
                <span className={v04styles.versionLatest}>
                  {chain.latestId === version.id ? "最新·默认展示" : "默认展示"}
                </span>
              ) : chain.latestId === version.id ? (
                <span className={v04styles.versionLatest}>{final ? "最新" : "最新·默认展示"}</span>
              ) : null}
              <span className={v04styles.versionTime}>{formatClock(version.updatedAt)}</span>
            </div>
          ))}
          {action.action === "CREATE_FROM_CURRENT" ? (
            <div className={v04styles.versionCreate}>
              <span>你还没有自己的版本，可基于当前正在看的这版创建</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onCreateFromCurrent();
                  setOpen(false);
                }}
              >
                基于此版创建我的版本
              </button>
            </div>
          ) : null}
          {action.action === "SWITCH_TO_MINE" ? (
            <div className={v04styles.versionMineNote}>
              <span>你已经有自己的版本</span>
              <button
                type="button"
                onClick={() => {
                  onSwitchToMine(action.versionId);
                  setOpen(false);
                }}
              >
                切到我的版本
              </button>
            </div>
          ) : null}
          <p className={v04styles.versionNote}>
            {final
              ? "进入页面默认展示你自己的版本，还没有自己的版本时展示集成版；可在此切换查看任意版本；直接编辑也会自动创建或切回你自己的版本。"
              : "进入页面默认展示最近更新的版本，可在此切换查看任意版本；直接编辑也会自动创建或切回你自己的版本。"}
          </p>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import Link from "next/link";
import type { JSX } from "react";
import {
  RETRO_LIMITS,
  RETRO_LINK_KIND_LABELS,
  type RetroAssetView,
  type RetroRoundView,
} from "@/lib/retro-model";
import V19EditableValue from "../v04/V19EditableValue";
import RetroAssetBlock from "./RetroAssetBlock";
import type { RetroAudioSeekRequest } from "./RetroAudioPanel";
import styles from "./Retro.module.css";

export type RetroAssetHost = {
  caseId: string;
  notify: (message: string, tone?: "plain" | "warn") => void;
  refresh: () => Promise<void>;
  onOpenMedia: (asset: RetroAssetView) => void;
  audioOpenId: string | null;
  audioSeek: RetroAudioSeekRequest | null;
  onToggleAudio: (asset: RetroAssetView) => void;
  onRetryTranscript: (asset: RetroAssetView) => void;
};

type TextField = "title" | "occurredOn" | "deliveryText" | "feedbackText" | "responseText";

const SEGMENTS: Array<{ label: string; field: "deliveryText" | "feedbackText" | "responseText"; cls: string; placeholder: string }> = [
  { label: "我们交了什么", field: "deliveryText", cls: "", placeholder: "点击填写我们交了什么：这一版的核心想法、和上一版相比改了什么" },
  { label: "客户怎么反馈", field: "feedbackText", cls: "feedback", placeholder: "点击填写客户怎么反馈：尽量用客户原话" },
  { label: "我们怎么应对", field: "responseText", cls: "", placeholder: "点击填写我们怎么应对" },
];

/**
 * 过程时间线上的一张回合卡（规格 10.3）：卡头「第 2 版 · 9 月中」（原位编辑）、三段文字、附件格、关联作品小卡；
 * 右上角 ↑ ↓ 删除常驻但克制（小号、muted 色，悬停才高亮）。三段文字空着时：有编辑权的人看到灰色占位，其他人不渲染。
 */
export default function RetroRoundCard({
  round,
  index,
  total,
  editable,
  savedField,
  assetHost,
  onCommit,
  onMove,
  onDelete,
  onOpenLinks,
  onRemoveLink,
}: {
  round: RetroRoundView;
  index: number;
  total: number;
  editable: boolean;
  /** 刚保存成功的字段（显示几秒「已保存」）。 */
  savedField: string | null;
  assetHost: RetroAssetHost;
  onCommit: (round: RetroRoundView, field: TextField, value: string) => void;
  onMove: (round: RetroRoundView, step: -1 | 1) => void;
  onDelete: (round: RetroRoundView) => void;
  onOpenLinks: (round: RetroRoundView) => void;
  onRemoveLink: (round: RetroRoundView, linkIndex: number) => void;
}): JSX.Element {
  const hasFeedback = round.feedbackText.trim() !== "";
  const saved = (field: TextField) => (savedField === `${round.id}:${field}` ? <span className={styles.savedFlash} aria-live="polite">已保存</span> : null);
  const editor = (field: TextField, kind: "text" | "textarea", placeholder: string, ariaLabel: string, block: boolean) => (
    <span className={`${styles.editField} ${block ? styles.block : ""}`.trim()}>
      <V19EditableValue
        id={`retro-round-${round.id}-${field}`}
        kind={kind}
        block={block}
        value={round[field]}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        onCommit={(value) => onCommit(round, field, value)}
      />
      {saved(field)}
    </span>
  );

  const shown = SEGMENTS.filter((segment) => editable || round[segment.field].trim() !== "");
  const links = round.links;
  const hasExtras = round.assets.length > 0 || links.length > 0 || editable;

  return (
    <li className={styles.roundCard} id={`round-${round.id}`} data-fb={hasFeedback ? 1 : 0}>
      <div className={styles.roundHead}>
        <span className={styles.roundNo}>R{index + 1}</span>
        <h3>
          {editable ? editor("title", "text", "点击填写回合标题", "回合标题", false) : round.title}
          {editable
            ? <small>{editor("occurredOn", "text", "点击填写时间", "时间", false)}</small>
            : round.occurredOn ? <small>{round.occurredOn}</small> : null}
        </h3>
        {editable ? (
          <span className={styles.roundTools}>
            <button type="button" aria-label="上移" title="上移" disabled={index === 0} onClick={() => onMove(round, -1)}>↑</button>
            <button type="button" aria-label="下移" title="下移" disabled={index === total - 1} onClick={() => onMove(round, 1)}>↓</button>
            <button type="button" className={styles.danger} onClick={() => onDelete(round)}>删除</button>
          </span>
        ) : null}
      </div>
      {shown.length ? (
        <div className={styles.roundBody}>
          {shown.map((segment) => (
            <div key={segment.field} className={segment.cls ? styles[segment.cls] : undefined}>
              <small>{segment.label}</small>
              <div className={styles.segText}>{editable ? editor(segment.field, "textarea", segment.placeholder, segment.label, true) : round[segment.field]}</div>
            </div>
          ))}
        </div>
      ) : null}
      {hasExtras ? (
        <div className={styles.roundExtras}>
          <RetroAssetBlock
            caseId={assetHost.caseId}
            roundId={round.id}
            assets={round.assets}
            editable={editable}
            variant="round"
            notify={assetHost.notify}
            refresh={assetHost.refresh}
            onOpenMedia={assetHost.onOpenMedia}
            audioOpenId={assetHost.audioOpenId}
            audioSeek={assetHost.audioSeek}
            onToggleAudio={assetHost.onToggleAudio}
            onRetryTranscript={assetHost.onRetryTranscript}
          />
          {links.length || editable ? (
            <>
              <small>关联作品</small>
              {links.length ? (
                <div className={styles.linkCards}>
                  {links.map((link, linkIndex) => {
                    const body = (
                      <>
                        <span className={styles.linkThumb} data-v04-scheme="dark">
                          {/* eslint-disable-next-line @next/next/no-img-element -- 缩略图来自各库已签名的地址 */}
                          {!link.deleted && link.thumbnailUrl ? <img src={link.thumbnailUrl} alt="" loading="lazy" /> : null}
                        </span>
                        <span className={styles.linkMeta}>
                          <small>{RETRO_LINK_KIND_LABELS[link.kind]}</small>
                          <b>{link.title || "（未知作品）"}</b>
                          {link.deleted ? <em>原作品已删除</em> : null}
                        </span>
                      </>
                    );
                    return (
                      <div className={styles.linkWrap} key={`${link.kind}:${link.targetId}`}>
                        {link.deleted || !link.href
                          ? <span className={`${styles.linkCard} ${styles.gone}`} title="原作品已删除，关联本身保留">{body}</span>
                          : <Link className={styles.linkCard} href={link.href}>{body}</Link>}
                        {editable ? <button type="button" className={styles.linkX} aria-label="取消关联" onClick={() => onRemoveLink(round, linkIndex)}>×</button> : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {editable ? (
                <button type="button" className={styles.linkAdd} onClick={() => onOpenLinks(round)}>
                  关联作品{links.length ? `（${links.length} / ${RETRO_LIMITS.linksPerRoundMax}）` : ""}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {!editable && !shown.length && !hasExtras ? <p className={styles.roundEmpty}>这一回合还没有填内容。</p> : null}
    </li>
  );
}

export type { TextField as RetroRoundTextField };

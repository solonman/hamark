"use client";

import { useEffect, useRef, useState } from "react";
import {
  BLOCK_ROLES,
  CONTENT_TYPES,
  REPORT_RELATIONS,
  WRITING_STYLES,
  moduleNumbers,
  type ReportAnnotation,
  type ReportBlock,
} from "@/lib/report-structure";
import type { ReportPageView } from "@/lib/report-model";
import { navStripCell } from "./deck-view";
import { ReportCombobox, ReportSelect } from "@/components/report/studio/ReportSelect";
import { DeckChipToggle, DeckChipsMulti, DeckCommentEntry, DeckEditableValue, DeckItem, DeckStaticValue } from "./DeckField";
import styles from "./ReportDeck.module.css";
import type { ReportDeckProps } from "./deck-types";

/**
 * 页面与组块标注 modal：大图（纯预览，不可交互）＋组块列表增删、首/尾/翻页、
 * 按模块／单元着色并标注进度的导航条。移植自 demo 的 `modal()`（约 998 行），
 * 但**不**移植 demo 里配套的 `wireDraw()`——页面坐标／在页图上框选组块区域
 * 这件事，任务交底里被用户明确取消了（"页面坐标/框选组块区域不做（用户已
 * 取消）"），组块靠列表右上角「＋ 添加组块」增删，不靠在图上拖框；坐标字段
 * （`x/y/w/h`）继续留在 `ReportBlock` 类型里但从不在表单出现数字，新建时给
 * 一组不展示的占位值即可（校验层要求 w/h > 0，见
 * `lib/report-structure.ts` 的 `validateReportAnnotation`）。键盘左右翻页
 * 是本组件在 demo 文案（引导第 3 步："用 ←→ 翻页"）基础上补的——demo 自己的
 * keydown 监听只处理了 Escape，从没真的接上方向键，这里按引导文案把它做实。
 */

export type ReportPageModalProps = {
  annotation: ReportAnnotation;
  pages: ReportPageView[];
  pageNo: number;
  readOnly: boolean;
  onChange: (next: ReportAnnotation) => void;
  onNavigate: (pageNo: number) => void;
  onClose: () => void;
  review: ReportDeckProps["review"];
};

function newBlockId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `b${crypto.randomUUID().slice(0, 8)}`;
  }
  return `b${Math.random().toString(36).slice(2, 10)}`;
}

/** 坐标字段还在类型里、还过校验，但不再有任何 UI 让人去设它——固定给一个安全占位。 */
function placeholderBlock(): ReportBlock {
  return {
    id: newBlockId(), name: "新内容组块",
    x: 5, y: 5, w: 90, h: 10,
    type: CONTENT_TYPES[0], roles: [], style: "中性", rel: "展开", narr: "", mark: "",
  };
}

function updatePage(a: ReportAnnotation, pageNo: number, fn: (p: ReportAnnotation["pages"][number]) => ReportAnnotation["pages"][number]): ReportAnnotation {
  return { ...a, pages: a.pages.map((p) => (p.n === pageNo ? fn(p) : p)) };
}
function updateBlock(a: ReportAnnotation, pageNo: number, blockId: string, fn: (b: ReportBlock) => ReportBlock): ReportAnnotation {
  return updatePage(a, pageNo, (p) => ({ ...p, blocks: p.blocks.map((b) => (b.id === blockId ? fn(b) : b)) }));
}

export default function ReportPageModal({
  annotation, pages, pageNo, readOnly, onChange, onNavigate, onClose, review,
}: ReportPageModalProps) {
  const [selBlock, setSelBlock] = useState<string | null>(null);
  const blockRefs = useRef(new Map<string, HTMLDivElement>());

  const sortedPages = [...annotation.pages].sort((a, b) => a.n - b.n);
  const idx = sortedPages.findIndex((p) => p.n === pageNo);
  const page = idx >= 0 ? sortedPages[idx] : null;
  const pageView = pages.find((pv) => pv.pageNo === pageNo) ?? null;
  const renderFailed = !pageView || pageView.renderStatus !== "OK" || !pageView.largeUrl;
  const nums = moduleNumbers(annotation);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onClose(); return; }
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (event.key === "ArrowLeft" && idx > 0) onNavigate(sortedPages[idx - 1].n);
      else if (event.key === "ArrowRight" && idx >= 0 && idx < sortedPages.length - 1) onNavigate(sortedPages[idx + 1].n);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, sortedPages.length]);

  useEffect(() => {
    if (!selBlock) return;
    blockRefs.current.get(selBlock)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selBlock]);

  if (!page) return null;

  const mod = page.mid ? annotation.modules.find((m) => m.id === page.mid) : null;
  const unit = page.uid ? annotation.units.find((u) => u.id === page.uid) : null;
  const pathLabel = mod
    ? `模块 ${nums[mod.id] ?? ""}${unit ? ` › 单元 ${nums[unit.id] ?? ""}` : " › 未进单元"}`
    : "未归入模块";

  const saveComment = async (input: { targetKey: string; targetLabel: string; body: string }) => {
    await review.onComment(input.targetKey, input.targetLabel, input.body);
  };

  const setPageField = (fn: (p: ReportAnnotation["pages"][number]) => ReportAnnotation["pages"][number]) => {
    if (readOnly) return;
    onChange(updatePage(annotation, pageNo, fn));
  };
  const setBlockField = (blockId: string, fn: (b: ReportBlock) => ReportBlock) => {
    if (readOnly) return;
    onChange(updateBlock(annotation, pageNo, blockId, fn));
  };

  const addBlock = () => {
    if (readOnly) return;
    const block = placeholderBlock();
    setPageField((p) => ({ ...p, blocks: [...p.blocks, block] }));
    setSelBlock(block.id);
  };

  const goTo = (target: number | null) => { if (target != null) onNavigate(target); };

  return (
    <div className={styles.ov} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={styles.ovbox} role="dialog" aria-label={`第 ${pageNo} 页标注`}>
        <div className={styles.ovhead}>
          <b>p{String(pageNo).padStart(2, "0")}</b>
          <span className={styles.ovheadPath}>{pathLabel}</span>
          <span className={styles.ovheadT}>{pageView?.textExcerpt ?? ""}</span>
          <button type="button" className={styles.smBtn} onClick={onClose}>关闭 esc</button>
        </div>
        <div className={styles.ovmain}>
          <div className={styles.ovstage}>
            <div className={styles.ovpage}>
              {renderFailed ? (
                <div className={styles.pcFail} style={{ aspectRatio: "4 / 3", width: "100%" }}>该页渲染失败</div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- 报告页图来自本地对象存储签名 URL，不走 next/image 的远程域名白名单
                <img src={pageView!.largeUrl ?? undefined} alt="" draggable={false} />
              )}
            </div>
          </div>
          <div className={styles.ovside}>
            <div className={styles.ovsec}>
              <h4>这一页</h4>
              <div className={styles.ovgrid}>
                <DeckItem label="结构页性质">
                  <DeckChipToggle
                    active={page.transition} label="过渡页" disabled={readOnly}
                    onToggle={() => setPageField((p) => ({ ...p, transition: !p.transition }))}
                  />
                </DeckItem>
                <DeckItem label="归属（由所在收纳框决定）">
                  <DeckStaticValue text={pathLabel} title="要改归属，把这页拖到别的收纳框里" />
                </DeckItem>
                <DeckItem
                  label="页面作用" wide
                  commentSlot={(
                    <DeckCommentEntry
                      targetKey={`page:${pageNo}:func`} targetLabel={`第 ${pageNo} 页·页面作用`}
                      comment={review.comments[`page:${pageNo}:func`]} canReview={review.canReview}
                      onSave={saveComment}
                    />
                  )}
                >
                  <DeckEditableValue
                    value={page.func} multiline disabled={readOnly}
                    onCommit={(next) => setPageField((p) => ({ ...p, func: next }))}
                  />
                </DeckItem>
                <DeckItem
                  label="本页组织关系" wide
                  commentSlot={(
                    <DeckCommentEntry
                      targetKey={`page:${pageNo}:org`} targetLabel={`第 ${pageNo} 页·本页组织关系`}
                      comment={review.comments[`page:${pageNo}:org`]} canReview={review.canReview}
                      onSave={saveComment}
                    />
                  )}
                >
                  <DeckEditableValue
                    value={page.org} multiline disabled={readOnly}
                    placeholder="描述本页所有内容组块怎样共同组织"
                    onCommit={(next) => setPageField((p) => ({ ...p, org: next }))}
                  />
                </DeckItem>
              </div>
            </div>
            <div className={styles.ovsec}>
              <h4>
                内容组块
                {!readOnly ? (
                  <button type="button" className={styles.ovsecAdd} onClick={addBlock}>
                    ＋ 添加组块
                  </button>
                ) : null}
              </h4>
              {page.blocks.length === 0 ? (
                <p className={styles.bkEmpty}>还没有组块。{readOnly ? "" : "点上面「＋ 添加组块」新建一个。"}</p>
              ) : page.blocks.map((block, index) => {
                const nameKey = `block:${block.id}:name`;
                const narrKey = `block:${block.id}:narr`;
                const markKey = `block:${block.id}:mark`;
                const label = `第 ${pageNo} 页·组块 ${index + 1}`;
                return (
                  <div
                    key={block.id}
                    ref={(el) => { if (el) blockRefs.current.set(block.id, el); else blockRefs.current.delete(block.id); }}
                    className={block.id === selBlock ? `${styles.bk} ${styles.bkOn}` : styles.bk}
                    onClick={() => setSelBlock(block.id)}
                  >
                    <div className={styles.bkL}>
                      <b>{index + 1}</b>
                      <DeckEditableValue
                        value={block.name} disabled={readOnly}
                        onCommit={(next) => setBlockField(block.id, (b) => ({ ...b, name: next }))}
                      />
                      <DeckCommentEntry
                        targetKey={nameKey} targetLabel={label}
                        comment={review.comments[nameKey]} canReview={review.canReview}
                        onSave={saveComment}
                      />
                      {!readOnly ? (
                        <button
                          type="button" className={styles.bkDel}
                          onClick={(event) => {
                            event.stopPropagation();
                            onChange(updatePage(annotation, pageNo, (p) => ({ ...p, blocks: p.blocks.filter((b) => b.id !== block.id) })));
                            if (selBlock === block.id) setSelBlock(null);
                          }}
                        >
                          删除
                        </button>
                      ) : null}
                    </div>
                    <div className={styles.bkG}>
                      <DeckItem label="内容类型">
                        <ReportCombobox
                          value={block.type} options={CONTENT_TYPES} disabled={readOnly}
                          onChange={(next) => setBlockField(block.id, (b) => ({ ...b, type: next }))}
                        />
                      </DeckItem>
                      <DeckItem label="文风类型">
                        <ReportSelect
                          value={block.style} options={WRITING_STYLES} disabled={readOnly}
                          onChange={(next) => setBlockField(block.id, (b) => ({ ...b, style: next }))}
                        />
                      </DeckItem>
                      <DeckItem label="组块间组织关系">
                        <ReportSelect
                          value={block.rel} options={REPORT_RELATIONS} disabled={readOnly}
                          onChange={(next) => setBlockField(block.id, (b) => ({ ...b, rel: next }))}
                        />
                      </DeckItem>
                      <DeckItem label="组块作用（可多选）" wide>
                        <DeckChipsMulti
                          values={block.roles} options={BLOCK_ROLES} disabled={readOnly}
                          onToggle={(value) => setBlockField(block.id, (b) => ({
                            ...b, roles: b.roles.includes(value) ? b.roles.filter((r) => r !== value) : [...b.roles, value],
                          }))}
                        />
                      </DeckItem>
                      <DeckItem
                        label="叙述作用" wide
                        commentSlot={(
                          <DeckCommentEntry
                            targetKey={narrKey} targetLabel={`${label}·叙述作用`}
                            comment={review.comments[narrKey]} canReview={review.canReview}
                            onSave={saveComment}
                          />
                        )}
                      >
                        <DeckEditableValue
                          value={block.narr} multiline disabled={readOnly}
                          onCommit={(next) => setBlockField(block.id, (b) => ({ ...b, narr: next }))}
                        />
                      </DeckItem>
                      <DeckItem
                        label="关键标记" wide
                        commentSlot={(
                          <DeckCommentEntry
                            targetKey={markKey} targetLabel={`${label}·关键标记`}
                            comment={review.comments[markKey]} canReview={review.canReview}
                            onSave={saveComment}
                          />
                        )}
                      >
                        <DeckEditableValue
                          value={block.mark} disabled={readOnly}
                          placeholder="这一块里最关键的那句话／那个词"
                          onCommit={(next) => setBlockField(block.id, (b) => ({ ...b, mark: next }))}
                        />
                      </DeckItem>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className={styles.ovfoot}>
          <span className={styles.ovfootNav}>
            <button type="button" disabled={idx <= 0} title="回到第 1 页" onClick={() => goTo(sortedPages[0]?.n ?? null)}>首页</button>
            <button type="button" disabled={idx <= 0} onClick={() => goTo(idx > 0 ? sortedPages[idx - 1].n : null)}>← 上一页</button>
            <span className={styles.ovfootCnt}>p{String(pageNo).padStart(2, "0")} / {sortedPages.length}</span>
            <button type="button" disabled={idx < 0 || idx >= sortedPages.length - 1} onClick={() => goTo(idx < sortedPages.length - 1 ? sortedPages[idx + 1].n : null)}>下一页 →</button>
            <button type="button" disabled={idx < 0 || idx >= sortedPages.length - 1} title="跳到最后一页" onClick={() => goTo(sortedPages[sortedPages.length - 1]?.n ?? null)}>尾页</button>
          </span>
          <span className={styles.ovfootStrip}>
            {sortedPages.map((p) => {
              const cell = navStripCell(annotation, p, pageNo);
              const cls = [styles.stripCell, cell.mark === "partial" ? styles.stripCellHalf : "", cell.isModuleStart ? styles.stripCellMs : "", cell.isCurrent ? styles.stripCellCur : ""]
                .filter(Boolean).join(" ");
              const style = cell.color
                ? { background: cell.color, filter: `brightness(${cell.brightness})` }
                : { background: "#2a2c26" };
              return (
                <span key={p.n} className={cls} style={style} title={cell.tooltip} onClick={() => goTo(p.n)}>
                  {cell.mark === "done" ? "✓" : cell.mark === "partial" ? "·" : ""}
                </span>
              );
            })}
          </span>
        </div>
      </div>
    </div>
  );
}

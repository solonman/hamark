"use client";

import { useLayoutEffect, useRef, useState } from "react";
import {
  MODULE_NAME_CANDIDATES,
  REPORT_RELATIONS,
  modulePages,
  moduleNumbers,
  pageRangeLabel,
  unitPages,
  type ReportAnnotation,
  type ReportDeckKey,
} from "@/lib/report-structure";
import { placeAnchoredPanel } from "./deck-view";
import { ReportCombobox, ReportSelect } from "@/components/report/studio/ReportSelect";
import { DeckCommentEntry, DeckEditableValue, DeckItem, DeckStaticValue } from "./DeckField";
import styles from "./ReportDeck.module.css";
import type { ReportDeckProps } from "./deck-types";

/**
 * 模块／单元标注浮层：可拖、只有 × 能关（不接外部点击/Esc 关闭监听——这是
 * 有意不做，见规格 §2.3「只有 × 能关」）；打开期间 ReportDeck 冻结其余交互；
 * hover 预览由 ReportDeck 用一个全局 pointerover 监听驱动（demo 同款做法），
 * 这个组件本身不用管。移植自 demo 的 `popover()`（约 936 行）。
 */

export type ReportSectionPopoverProps = {
  annotation: ReportAnnotation;
  targetKey: ReportDeckKey; // "mod:<id>" | "unit:<id>"
  /** The "标注" button (or a synthetic stand-in for a freshly-created box) this popover opened from. */
  anchorRect: { top: number; bottom: number; left: number };
  readOnly: boolean;
  onChange: (next: ReportAnnotation) => void;
  onClose: () => void;
  review: ReportDeckProps["review"];
};

const UNIT_DEPTH_TITLES = ["讲述单元", "子单元", "孙单元", "曾孙单元"];

function unitDepth(a: ReportAnnotation, uid: string): number {
  let depth = 0;
  let cursor = a.units.find((u) => u.id === uid);
  while (cursor && cursor.pid) {
    depth += 1;
    cursor = a.units.find((u) => u.id === cursor!.pid);
  }
  return depth;
}

export default function ReportSectionPopover({
  annotation, targetKey, anchorRect, readOnly, onChange, onClose, review,
}: ReportSectionPopoverProps) {
  // 先按锚点下方给个粗略位置渲染一次（这时还量不到真实高度），useLayoutEffect
  // 拿到真实尺寸后在绘制前改成准确位置（贴近锚点，视口装不下就翻到锚点上方）
  // ——两遍都在 paint 之前完成，用户看不到中间那次粗略位置的闪烁。
  const [pos, setPos] = useState({ x: anchorRect.left, y: anchorRect.bottom + 8 });
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const placed = placeAnchoredPanel({
      anchor: anchorRect, width: rect.width, height: rect.height,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    });
    setPos((current) => (placed.x === current.x && placed.y === current.y ? current : placed));
    // 只在挂载与目标切换时摆一次，避免拖动过程里被这段又拽回去。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  const onHeaderPointerDown = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    dragRef.current = { startX: event.clientX, startY: event.clientY, left: pos.x, top: pos.y };
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  };
  const onHeaderPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const el = rootRef.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    const x = Math.max(6, Math.min(window.innerWidth - w - 6, drag.left + event.clientX - drag.startX));
    const y = Math.max(6, Math.min(window.innerHeight - h - 6, drag.top + event.clientY - drag.startY));
    setPos({ x, y });
  };
  const onHeaderPointerUp = () => { dragRef.current = null; };

  const nums = moduleNumbers(annotation);
  const [kind, id] = [targetKey.slice(0, targetKey.indexOf(":")), targetKey.slice(targetKey.indexOf(":") + 1)];

  const setField = (patch: (a: ReportAnnotation) => ReportAnnotation) => {
    if (readOnly) return;
    onChange(patch(annotation));
  };

  const saveComment = async (input: { targetKey: string; targetLabel: string; body: string }) => {
    await review.onComment(input.targetKey, input.targetLabel, input.body);
  };

  let title = "";
  let body: React.ReactNode = null;

  if (kind === "mod") {
    const mod = annotation.modules.find((m) => m.id === id);
    if (!mod) return null;
    title = `模块 ${nums[id] ?? ""}`;
    const range = modulePages(annotation, id);
    const nameKey = `module:${id}:name`;
    const roleKey = `module:${id}:role`;
    body = (
      <>
        <DeckItem
          label="策略模块名称" wide
          commentSlot={(
            <DeckCommentEntry
              targetKey={nameKey} targetLabel={`${title}·名称`}
              comment={review.comments[nameKey]} canReview={review.canReview}
              onSave={saveComment}
            />
          )}
        >
          <ReportCombobox
            value={mod.name}
            options={MODULE_NAME_CANDIDATES}
            disabled={readOnly}
            onChange={(next) => setField((a) => ({
              ...a, modules: a.modules.map((m) => (m.id === id ? { ...m, name: next } : m)),
            }))}
          />
        </DeckItem>
        <DeckItem label="模块间组织关系">
          <ReportSelect
            value={mod.rel}
            options={REPORT_RELATIONS}
            disabled={readOnly}
            onChange={(next) => setField((a) => ({
              ...a, modules: a.modules.map((m) => (m.id === id ? { ...m, rel: next } : m)),
            }))}
          />
        </DeckItem>
        <DeckItem
          label="策略作用" wide
          commentSlot={(
            <DeckCommentEntry
              targetKey={roleKey} targetLabel={`${title}·策略作用`}
              comment={review.comments[roleKey]} canReview={review.canReview}
              onSave={saveComment}
            />
          )}
        >
          <DeckEditableValue
            value={mod.role} multiline disabled={readOnly}
            placeholder="这个模块在全篇策略里承担什么作用"
            onCommit={(next) => setField((a) => ({
              ...a, modules: a.modules.map((m) => (m.id === id ? { ...m, role: next } : m)),
            }))}
          />
        </DeckItem>
        <DeckItem label="页码范围" wide>
          <DeckStaticValue text={`${pageRangeLabel(range)} · ${range.length} 页`} title="由收进这个框的页自动推导" />
        </DeckItem>
      </>
    );
  } else {
    const unit = annotation.units.find((u) => u.id === id);
    if (!unit) return null;
    const depth = unitDepth(annotation, id);
    title = `${UNIT_DEPTH_TITLES[Math.min(depth, UNIT_DEPTH_TITLES.length - 1)]} ${nums[id] ?? ""}`;
    const range = unitPages(annotation, id);
    const fields: { key: "name" | "task" | "role" | "psy" | "concl"; label: string; multi: boolean; placeholder?: string }[] = [
      { key: "name", label: "单元名称", multi: false, placeholder: "未起名" },
      { key: "task", label: "传播／讲述任务", multi: true },
      { key: "role", label: "讲述作用", multi: true },
      { key: "psy", label: "预期心理", multi: false },
      { key: "concl", label: "候选结论", multi: true },
    ];
    body = (
      <>
        {fields.map((field) => {
          const key = `unit:${id}:${field.key}`;
          return (
            <DeckItem
              key={field.key}
              label={field.label}
              wide={field.multi}
              commentSlot={(
                <DeckCommentEntry
                  targetKey={key} targetLabel={`${title}·${field.label}`}
                  comment={review.comments[key]} canReview={review.canReview}
                  onSave={saveComment}
                />
              )}
            >
              <DeckEditableValue
                value={unit[field.key]} multiline={field.multi} disabled={readOnly}
                placeholder={field.placeholder}
                onCommit={(next) => setField((a) => ({
                  ...a, units: a.units.map((u) => (u.id === id ? { ...u, [field.key]: next } : u)),
                }))}
              />
            </DeckItem>
          );
        })}
        <DeckItem label="单元间组织关系">
          <ReportSelect
            value={unit.rel}
            options={REPORT_RELATIONS}
            disabled={readOnly}
            onChange={(next) => setField((a) => ({
              ...a, units: a.units.map((u) => (u.id === id ? { ...u, rel: next } : u)),
            }))}
          />
        </DeckItem>
        <DeckItem label="页码范围">
          <DeckStaticValue text={`${pageRangeLabel(range)} · ${range.length} 页`} />
        </DeckItem>
      </>
    );
  }

  return (
    <div ref={rootRef} className={styles.pop} style={{ left: pos.x, top: pos.y }} role="dialog" aria-label={title}>
      <div
        ref={headerRef}
        className={styles.popHead}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <div><small>SECTION</small><b>{title}</b></div>
        <button type="button" className={styles.popX} onClick={onClose} title="关闭">×</button>
      </div>
      <div className={styles.popBody}>
        {readOnly ? <p className={styles.popReadOnlyNote}>正在只读查看这一版，改不了。</p> : null}
        {body}
      </div>
    </div>
  );
}

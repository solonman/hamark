"use client";

import type { V04ShotFieldKey } from "@/lib/v04-contract";
import { V04_UI_SHOT_FIELDS, type V04UiShot } from "@/lib/v04-ui-model";
import { V04_REPEATABLE_SHOT_FIELDS, v04ShotFieldTargetId } from "@/lib/v04-ui-client-state";
import styles from "./V04Surface.module.css";

export default function V04ShotEditor({ shot, number, groupNumber, groupId, groupTargets, previousShot, readOnly, onChange, onComment, onMoveUp, onMoveDown, onMoveTo, onDragStart, onDragEnd }: {
  shot: V04UiShot;
  number: number;
  groupNumber: number;
  groupId: string;
  groupTargets: Array<{ id: string; label: string }>;
  previousShot: V04UiShot | null;
  readOnly: boolean;
  onChange: (key: V04ShotFieldKey, value: string) => void;
  onComment?: (target: { targetKey: string; targetLabel: string; moduleLabel: string; originalExcerpt: string }) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveTo: (groupId: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  return (
    <article className={styles.shotCard} id={`shot-${shot.id}`} data-shot-stable-id={shot.id}>
      <header className={styles.shotHeader}>
        <div><span className={styles.dragHandle} draggable={!readOnly} data-shot-drag-handle aria-label="仅此手柄可排序" onDragStart={(event) => { if (readOnly) { event.preventDefault(); return; } event.dataTransfer.effectAllowed = "move"; onDragStart(); }} onDragEnd={onDragEnd}>⠿</span><strong>桥段{String(groupNumber).padStart(2, "0")}－镜头{String(number).padStart(2, "0")}</strong><small>稳定 ID · {shot.id}</small></div>
        <div><button type="button" disabled={readOnly} onClick={onMoveUp}>上移</button><button type="button" disabled={readOnly} onClick={onMoveDown}>下移</button><label className={styles.moveTarget}>跨桥段移动<select aria-label={`将镜头 ${String(number).padStart(2, "0")} 移动到桥段`} value={groupId} disabled={readOnly} onChange={(event) => onMoveTo(event.target.value)}>{groupTargets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}</select></label></div>
      </header>
      <div className={styles.shotFields}>
        {V04_UI_SHOT_FIELDS.map(({ key, label }) => {
          const repeatable = V04_REPEATABLE_SHOT_FIELDS.includes(key as (typeof V04_REPEATABLE_SHOT_FIELDS)[number]);
          const canRepeat = repeatable && Boolean(previousShot?.[key]);
          return (
            <label key={key} id={v04ShotFieldTargetId(shot.id, key)} className={`${styles.shotField} ${key === "visualContent" ? styles.shotFieldWide : ""}`}>
              <span><b>{label}</b><i>{onComment && <button type="button" onClick={(event) => { event.preventDefault(); onComment({ targetKey: `shot:${shot.id}.${key}`, targetLabel: label, moduleLabel: "第一模块｜脚本反写", originalExcerpt: shot[key] }); }}>批注</button>}{repeatable && number > 1 && <button type="button" disabled={readOnly || !canRepeat} onClick={() => previousShot && onChange(key, previousShot[key])}>同上</button>}</i></span>
              {key === "visualContent" || key === "screenCopy" || key === "subtitleEffect" || key === "dialogue" || key === "voiceOver" ? (
                <textarea data-v04-primary-focus value={shot[key]} readOnly={readOnly} onChange={(event) => onChange(key, event.target.value)} />
              ) : (
                <input data-v04-primary-focus value={shot[key]} readOnly={readOnly} onChange={(event) => onChange(key, event.target.value)} />
              )}
            </label>
          );
        })}
      </div>
    </article>
  );
}

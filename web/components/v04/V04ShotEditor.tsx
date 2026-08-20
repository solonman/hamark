"use client";

import type { V04ShotFieldKey } from "@/lib/v04-contract";
import { V04_UI_SHOT_FIELDS, type V04UiShot } from "@/lib/v04-ui-model";
import { V04_REPEATABLE_SHOT_FIELDS } from "@/lib/v04-ui-client-state";
import styles from "./V04Surface.module.css";

export default function V04ShotEditor({ shot, number, groupId, groupTargets, previousShot, disabled, onChange, onMoveUp, onMoveDown, onMoveTo, onDragStart, onDragEnd }: {
  shot: V04UiShot;
  number: number;
  groupId: string;
  groupTargets: Array<{ id: string; label: string }>;
  previousShot: V04UiShot | null;
  disabled: boolean;
  onChange: (key: V04ShotFieldKey, value: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveTo: (groupId: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  return (
    <article className={styles.shotCard} id={`shot-${shot.id}`} data-shot-stable-id={shot.id}>
      <header className={styles.shotHeader}>
        <div><span className={styles.dragHandle} draggable={!disabled} data-shot-drag-handle aria-label="仅此手柄可排序" onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; onDragStart(); }} onDragEnd={onDragEnd}>⠿</span><strong>镜头 {String(number).padStart(2, "0")}</strong><small>稳定 ID · {shot.id}</small></div>
        <div><button type="button" disabled={disabled} onClick={onMoveUp}>上移</button><button type="button" disabled={disabled} onClick={onMoveDown}>下移</button><label className={styles.moveTarget}>跨桥段移动<select aria-label={`将镜头 ${String(number).padStart(2, "0")} 移动到桥段`} value={groupId} disabled={disabled} onChange={(event) => onMoveTo(event.target.value)}>{groupTargets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}</select></label></div>
      </header>
      <div className={styles.shotFields}>
        {V04_UI_SHOT_FIELDS.map(({ key, label }) => {
          const repeatable = V04_REPEATABLE_SHOT_FIELDS.includes(key as (typeof V04_REPEATABLE_SHOT_FIELDS)[number]);
          const canRepeat = repeatable && Boolean(previousShot?.[key]);
          return (
            <label key={key} className={`${styles.shotField} ${key === "visualContent" ? styles.shotFieldWide : ""}`}>
              <span>{label}{repeatable && number > 1 && <button type="button" disabled={disabled || !canRepeat} onClick={() => previousShot && onChange(key, previousShot[key])}>同上</button>}</span>
              {key === "visualContent" || key === "screenCopy" || key === "subtitleEffect" || key === "dialogue" || key === "voiceOver" ? (
                <textarea value={shot[key]} disabled={disabled} onChange={(event) => onChange(key, event.target.value)} />
              ) : (
                <input value={shot[key]} disabled={disabled} onChange={(event) => onChange(key, event.target.value)} />
              )}
            </label>
          );
        })}
      </div>
    </article>
  );
}

"use client";

import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const STORAGE_KEY = "reverse:shot-table-column-widths:v1";
const CHANGE_EVENT = "reverse:shot-table-column-widths-change";

export const shotTableColumns = [
  { id: "group", label: "镜头组序号／名称", defaultWidth: 150, minWidth: 76 },
  { id: "number", label: "镜头序号", defaultWidth: 90, minWidth: 64 },
  { id: "time", label: "时间段", defaultWidth: 110, minWidth: 82 },
  { id: "size", label: "景别", defaultWidth: 100, minWidth: 58 },
  { id: "angle", label: "机位／角度", defaultWidth: 130, minWidth: 72 },
  { id: "movement", label: "镜头运动", defaultWidth: 120, minWidth: 72 },
  { id: "visual", label: "画面内容（镜头故事）", defaultWidth: 320, minWidth: 140 },
  { id: "dialogue", label: "对白", defaultWidth: 200, minWidth: 86 },
  { id: "voiceover", label: "旁白", defaultWidth: 200, minWidth: 86 },
  { id: "screenText", label: "字幕／屏幕文案", defaultWidth: 190, minWidth: 96 },
  { id: "sound", label: "声效", defaultWidth: 160, minWidth: 76 },
  { id: "music", label: "音乐", defaultWidth: 180, minWidth: 76 },
  { id: "comment", label: "创意点评／标注依据", defaultWidth: 330, minWidth: 140 },
] as const;

const defaultWidths = shotTableColumns.map((column) => column.defaultWidth);

function normalizedWidths(value: unknown) {
  if (!Array.isArray(value) || value.length !== shotTableColumns.length) {
    return null;
  }
  const widths = value.map((item, index) => {
    const number = Number(item);
    if (!Number.isFinite(number)) return null;
    return Math.max(shotTableColumns[index].minWidth, Math.round(number));
  });
  return widths.some((item) => item === null) ? null : (widths as number[]);
}

function persistWidths(widths: number[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // 列宽偏好不可用时退回当前会话，不影响作业编辑。
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: widths }));
}

export function useShotTableColumns() {
  const [widths, setWidths] = useState<number[]>(defaultWidths);

  useEffect(() => {
    let active = true;
    const applyWidths = (value: unknown) => {
      const normalized = normalizedWidths(value);
      if (normalized) setWidths(normalized);
    };
    const handleChange = (event: Event) => {
      applyWidths((event as CustomEvent).detail);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        applyWidths(JSON.parse(event.newValue));
      } catch {
        // 忽略其他页面写入的无效偏好。
      }
    };
    window.addEventListener(CHANGE_EVENT, handleChange);
    window.addEventListener("storage", handleStorage);
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const normalized = normalizedWidths(JSON.parse(stored));
        if (normalized) {
          window.queueMicrotask(() => {
            if (active) setWidths(normalized);
          });
        }
      }
    } catch {
      // 无效或不可读取的本地偏好直接忽略。
    }
    return () => {
      active = false;
      window.removeEventListener(CHANGE_EVENT, handleChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  function setColumnWidth(index: number, width: number) {
    const next = [...widths];
    next[index] = Math.max(
      shotTableColumns[index].minWidth,
      Math.round(width),
    );
    setWidths(next);
    persistWidths(next);
  }

  function beginResize(
    index: number,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widths[index];
    let latest = widths;
    document.body.classList.add("is-resizing-shot-column");

    const handleMove = (moveEvent: PointerEvent) => {
      const next = [...widths];
      next[index] = Math.max(
        shotTableColumns[index].minWidth,
        Math.round(startWidth + moveEvent.clientX - startX),
      );
      latest = next;
      setWidths(next);
    };
    const handleEnd = () => {
      document.body.classList.remove("is-resizing-shot-column");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
      persistWidths(latest);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd, { once: true });
    window.addEventListener("pointercancel", handleEnd, { once: true });
  }

  function resetColumn(index: number) {
    setColumnWidth(index, shotTableColumns[index].defaultWidth);
  }

  function resetAll() {
    const next = [...defaultWidths];
    setWidths(next);
    persistWidths(next);
  }

  return {
    widths,
    tableWidth: widths.reduce((total, width) => total + width, 0),
    beginResize,
    setColumnWidth,
    resetColumn,
    resetAll,
  };
}

type ColumnSizing = ReturnType<typeof useShotTableColumns>;

export function ShotTableColGroup({ widths }: { widths: number[] }) {
  return (
    <colgroup>
      {shotTableColumns.map((column, index) => (
        <col key={column.id} style={{ width: `${widths[index]}px` }} />
      ))}
    </colgroup>
  );
}

export function ResizableShotTableHeader({
  sizing,
}: {
  sizing: ColumnSizing;
}) {
  return (
    <thead>
      <tr>
        {shotTableColumns.map((column, index) => (
          <th key={column.id}>
            <span>{column.label}</span>
            <button
              type="button"
              className="shot-column-resize-handle"
              aria-label={`调整“${column.label}”列宽`}
              title="拖动调整列宽；双击恢复本列"
              onPointerDown={(event) => sizing.beginResize(index, event)}
              onDoubleClick={(event) => {
                event.preventDefault();
                sizing.resetColumn(index);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                  return;
                }
                event.preventDefault();
                sizing.setColumnWidth(
                  index,
                  sizing.widths[index] + (event.key === "ArrowRight" ? 16 : -16),
                );
              }}
            />
          </th>
        ))}
      </tr>
    </thead>
  );
}

export function ShotTableWidthToolbar({
  onReset,
  dark = false,
}: {
  onReset: () => void;
  dark?: boolean;
}) {
  return (
    <div className={`shot-column-toolbar ${dark ? "is-dark" : ""}`}>
      <span>拖动表头边界调整列宽 · 双击边界恢复单列</span>
      <button type="button" onClick={onReset}>
        恢复默认列宽
      </button>
    </div>
  );
}

import type { DbClient } from "@/db";
import {
  analysisTargetValue,
  parseAnalysisTarget,
  resolveAnchoredReplacement,
  type ParsedAnalysisTarget,
} from "./analysis-targets";
import type {
  AnnotationDraft,
  RevisionEditType,
  RevisionValueType,
} from "./types";

export async function ensureReviewRoundForSnapshot(
  db: DbClient,
  input: {
    annotationId: string;
    videoId: string;
    snapshotId: string;
  },
) {
  const existing = await db
    .prepare(`SELECT id, round_number FROM analysis_review_rounds WHERE submitted_snapshot_id = ?`)
    .bind(input.snapshotId)
    .first<{ id: string; round_number: number }>();
  if (existing) return { id: existing.id, roundNumber: Number(existing.round_number) };

  const latest = await db
    .prepare(`SELECT COALESCE(MAX(round_number), 0) AS round_number FROM analysis_review_rounds WHERE annotation_id = ?`)
    .bind(input.annotationId)
    .first<{ round_number: number }>();
  const roundNumber = Number(latest?.round_number ?? 0) + 1;
  const id = `review_round_${crypto.randomUUID()}`;
  await db.batch([
    db.prepare(
      `INSERT INTO analysis_review_rounds (
        id, annotation_id, video_id, submitted_snapshot_id, round_number
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(id, input.annotationId, input.videoId, input.snapshotId, roundNumber),
    db.prepare(
      `UPDATE annotations
      SET review_status = ?, active_base_snapshot_id = ?, status = 'SUBMITTED',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    ).bind(
      roundNumber > 1 ? "PENDING_REREVIEW" : "PENDING_REVIEW",
      input.snapshotId,
      input.annotationId,
    ),
    db.prepare(
      `UPDATE analysis_comments
      SET handled_in_snapshot_id = COALESCE(handled_in_snapshot_id, ?),
        updated_at = CURRENT_TIMESTAMP
      WHERE workflow_status = 'AUTHOR_MARKED_HANDLED'
        AND handled_in_snapshot_id IS NULL
        AND review_round_id IN (
          SELECT id FROM analysis_review_rounds WHERE annotation_id = ?
        )`,
    ).bind(input.snapshotId, input.annotationId),
  ]);
  return { id, roundNumber };
}

export type RevisionEventRecord = {
  id: string;
  target_key: string;
  edit_type: RevisionEditType;
  anchor_start: number;
  anchor_end: number;
  original_text: string;
  original_text_hash: string;
  replacement_text: string;
  value_type?: RevisionValueType;
  original_value_json?: string | null;
  replacement_value_json?: string | null;
};

export function canonicalRevisionValue(value: string | string[]) {
  return JSON.stringify(Array.isArray(value) ? [...new Set(value)] : value);
}

function parseRevisionValue(value: string | null | undefined, fallback: string | string[]) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return [...new Set(parsed)];
    }
  } catch {
    // V0.3.1 text events have no structured JSON payload.
  }
  return fallback;
}

export async function sha256Text(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function inferRevisionEditType(input: {
  targetValue: string;
  selectedText: string;
  anchorStart: number;
  anchorEnd: number;
  replacementText: string;
}): RevisionEditType {
  if (!input.selectedText && input.anchorStart === input.anchorEnd) return "INSERT";
  if (!input.replacementText) return "DELETE";
  if (
    input.anchorStart === 0 &&
    input.anchorEnd === input.targetValue.length &&
    input.selectedText === input.targetValue
  ) {
    return "UNIT_REPLACE";
  }
  return "RANGE_REPLACE";
}

export async function applyRevisionEventToPayload(
  payload: AnnotationDraft,
  event: RevisionEventRecord,
) {
  const target = parseAnalysisTarget(event.target_key);
  const currentValue = analysisTargetValue(payload, event.target_key);
  if (!target || currentValue == null) throw new Error("TARGET_MISSING");
  if ((event.value_type ?? "TEXT") !== "TEXT") {
    const originalValue = parseRevisionValue(
      event.original_value_json,
      event.value_type === "MULTI_SELECT" ? [] : "",
    );
    const replacementValue = parseRevisionValue(
      event.replacement_value_json,
      event.value_type === "MULTI_SELECT" ? [] : "",
    );
    if (
      (await sha256Text(canonicalRevisionValue(originalValue))) !==
      event.original_text_hash
    ) {
      throw new Error("ORIGINAL_HASH_MISMATCH");
    }
    if (canonicalRevisionValue(currentValue) !== canonicalRevisionValue(originalValue)) {
      throw new Error("CONTENT_CHANGED");
    }
    writePayloadTarget(payload, target, replacementValue);
    return;
  }
  if (typeof currentValue !== "string") throw new Error("TARGET_TYPE_MISMATCH");
  if ((await sha256Text(event.original_text)) !== event.original_text_hash) {
    throw new Error("ORIGINAL_HASH_MISMATCH");
  }
  const nextValue = resolveAnchoredReplacement({
    currentValue,
    selectedText: event.original_text,
    anchorStart: Number(event.anchor_start),
    anchorEnd: Number(event.anchor_end),
    replacementText: event.replacement_text,
  });
  if (nextValue == null) throw new Error("CONTENT_CHANGED");
  writePayloadTarget(payload, target, nextValue);
}

export async function materializeRevisionEvents(
  source: AnnotationDraft,
  events: RevisionEventRecord[],
) {
  const payload = structuredClone(source);
  for (const event of events) await applyRevisionEventToPayload(payload, event);
  return payload;
}

function writePayloadTarget(
  payload: AnnotationDraft,
  target: ParsedAnalysisTarget,
  value: string | string[],
) {
  if (target.scope === "annotation") {
    if (typeof value !== "string") throw new Error("TARGET_TYPE_MISMATCH");
    payload[target.property] = value;
    return;
  }
  if (target.scope === "shot") {
    if (typeof value !== "string") throw new Error("TARGET_TYPE_MISMATCH");
    const shot = payload.shots.find((item) => item.id === target.shotId);
    if (!shot) throw new Error("TARGET_MISSING");
    if (target.property === "groupName") {
      const previous = shot.groupName;
      payload.shots.forEach((item) => {
        if (item.groupName === previous) item.groupName = value;
      });
    } else {
      shot[target.property] = value;
    }
    return;
  }
  if (target.scope === "shot-group") {
    if (typeof value !== "string") throw new Error("TARGET_TYPE_MISMATCH");
    const group = payload.shotGroups?.find((item) => item.id === target.groupId);
    if (!group) throw new Error("TARGET_MISSING");
    group[target.property] = value;
    if (target.property === "title") {
      payload.shots.forEach((shot) => {
        if (shot.shotGroupId === group.id) shot.groupName = value;
      });
    }
    return;
  }
  if (target.scope === "shot-group-structured") {
    const group = payload.shotGroups?.find((item) => item.id === target.groupId);
    if (!group) throw new Error("TARGET_MISSING");
    if (target.valueType === "MULTI_SELECT") {
      if (!Array.isArray(value)) throw new Error("TARGET_TYPE_MISMATCH");
      group[target.property] = value as never;
    } else {
      if (typeof value !== "string") throw new Error("TARGET_TYPE_MISMATCH");
      group[target.property] = value as never;
    }
    return;
  }
  if (target.scope === "creative-structure") {
    if (typeof value !== "string") throw new Error("TARGET_TYPE_MISMATCH");
    if (!payload.creativeStructure) throw new Error("TARGET_MISSING");
    payload.creativeStructure[target.property] = value;
    if (target.property === "creativeRealizationPath") {
      payload.creativeStructure.realizationSkeleton = value;
    } else if (target.property === "realizationSkeleton") {
      payload.creativeStructure.creativeRealizationPath = value;
    }
    return;
  }
  if (target.scope === "creative-structure-structured") {
    if (!payload.creativeStructure) throw new Error("TARGET_MISSING");
    if (target.valueType === "MULTI_SELECT") {
      if (!Array.isArray(value)) throw new Error("TARGET_TYPE_MISMATCH");
      payload.creativeStructure[target.property] = value as never;
    } else {
      if (typeof value !== "string") throw new Error("TARGET_TYPE_MISMATCH");
      payload.creativeStructure[target.property] = value as never;
    }
    return;
  }
  if (target.scope === "creative-structure-json") {
    if (typeof value !== "string") throw new Error("TARGET_TYPE_MISMATCH");
    if (!payload.creativeStructure) throw new Error("TARGET_MISSING");
    const values = payload.creativeStructure[target.property] as Record<string, string>;
    values[target.itemKey] = value;
    return;
  }
  if (typeof value !== "string") throw new Error("TARGET_TYPE_MISMATCH");
  const field = payload.fields.find((item) => item.code === target.fieldCode);
  if (!field) throw new Error("TARGET_MISSING");
  field[target.property] = value;
}

async function readAnnotationTarget(
  db: DbClient,
  annotationId: string,
  target: ParsedAnalysisTarget,
) {
  if (target.scope === "annotation") {
    const row = await db.prepare(`SELECT ${target.column} AS value FROM annotations WHERE id = ? FOR UPDATE`)
      .bind(annotationId).first<{ value: string }>();
    return row?.value ?? null;
  }
  if (target.scope === "shot") {
    const row = await db.prepare(`SELECT ${target.column} AS value FROM shots WHERE id = ? AND annotation_id = ? FOR UPDATE`)
      .bind(target.shotId, annotationId).first<{ value: string }>();
    return row?.value ?? null;
  }
  if (target.scope === "shot-group") {
    const row = await db.prepare(`SELECT ${target.column} AS value FROM shot_groups WHERE id = ? AND annotation_id = ? FOR UPDATE`)
      .bind(target.groupId, annotationId).first<{ value: string }>();
    return row?.value ?? null;
  }
  if (target.scope === "shot-group-structured") {
    const row = await db.prepare(`SELECT ${target.column} AS value FROM shot_groups WHERE id = ? AND annotation_id = ? FOR UPDATE`)
      .bind(target.groupId, annotationId).first<{ value: string }>();
    if (!row) return null;
    return target.valueType === "MULTI_SELECT"
      ? parseRevisionValue(row.value, [])
      : row.value ?? "";
  }
  if (
    target.scope === "creative-structure" ||
    target.scope === "creative-structure-json" ||
    target.scope === "creative-structure-structured"
  ) {
    const row = await db.prepare(`SELECT ${target.column} AS value FROM annotation_creative_structures WHERE annotation_id = ? FOR UPDATE`)
      .bind(annotationId).first<{ value: string }>();
    if (!row || target.scope === "creative-structure") return row?.value ?? null;
    if (target.scope === "creative-structure-structured") {
      return target.valueType === "MULTI_SELECT"
        ? parseRevisionValue(row.value, [])
        : row.value ?? "";
    }
    try {
      return (JSON.parse(row.value || "{}") as Record<string, string>)[target.itemKey] ?? "";
    } catch {
      return null;
    }
  }
  const row = await db.prepare(`SELECT ${target.column} AS value FROM field_answers WHERE annotation_id = ? AND field_code = ? FOR UPDATE`)
    .bind(annotationId, target.fieldCode).first<{ value: string }>();
  return row?.value ?? null;
}

async function writeAnnotationTarget(
  db: DbClient,
  annotationId: string,
  target: ParsedAnalysisTarget,
  currentValue: string | string[],
  value: string | string[],
) {
  if (target.scope === "annotation") {
    if (typeof value !== "string") throw new Error("TARGET_TYPE_MISMATCH");
    await db.prepare(`UPDATE annotations SET ${target.column} = ? WHERE id = ?`)
      .bind(value, annotationId).run();
    return;
  }
  if (target.scope === "shot") {
    if (typeof value !== "string" || typeof currentValue !== "string") throw new Error("TARGET_TYPE_MISMATCH");
    if (target.property === "groupName") {
      await db.prepare(`UPDATE shots SET group_name = ? WHERE annotation_id = ? AND group_name = ?`)
        .bind(value, annotationId, currentValue).run();
    } else {
      await db.prepare(`UPDATE shots SET ${target.column} = ? WHERE id = ? AND annotation_id = ?`)
        .bind(value, target.shotId, annotationId).run();
    }
    return;
  }
  if (target.scope === "shot-group") {
    if (typeof value !== "string") throw new Error("TARGET_TYPE_MISMATCH");
    await db.prepare(`UPDATE shot_groups SET ${target.column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND annotation_id = ?`)
      .bind(value, target.groupId, annotationId).run();
    if (target.property === "title") {
      await db.prepare(`UPDATE shots SET group_name = ? WHERE shot_group_id = ? AND annotation_id = ?`)
        .bind(value, target.groupId, annotationId).run();
    }
    return;
  }
  if (target.scope === "shot-group-structured") {
    if (target.valueType === "MULTI_SELECT" && !Array.isArray(value)) {
      throw new Error("TARGET_TYPE_MISMATCH");
    }
    if (target.valueType === "SINGLE_SELECT" && typeof value !== "string") {
      throw new Error("TARGET_TYPE_MISMATCH");
    }
    const stored = target.valueType === "MULTI_SELECT"
      ? JSON.stringify(value)
      : String(value);
    await db.prepare(`UPDATE shot_groups SET ${target.column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND annotation_id = ?`)
      .bind(stored, target.groupId, annotationId).run();
    return;
  }
  if (target.scope === "creative-structure") {
    if (typeof value !== "string") throw new Error("TARGET_TYPE_MISMATCH");
    await db.prepare(`UPDATE annotation_creative_structures SET ${target.column} = ?, updated_at = CURRENT_TIMESTAMP WHERE annotation_id = ?`)
      .bind(value, annotationId).run();
    return;
  }
  if (target.scope === "creative-structure-structured") {
    if (target.valueType === "MULTI_SELECT" && !Array.isArray(value)) {
      throw new Error("TARGET_TYPE_MISMATCH");
    }
    if (target.valueType === "SINGLE_SELECT" && typeof value !== "string") {
      throw new Error("TARGET_TYPE_MISMATCH");
    }
    const stored = target.valueType === "MULTI_SELECT"
      ? JSON.stringify(value)
      : String(value);
    await db.prepare(`UPDATE annotation_creative_structures SET ${target.column} = ?, updated_at = CURRENT_TIMESTAMP WHERE annotation_id = ?`)
      .bind(stored, annotationId).run();
    return;
  }
  if (target.scope === "creative-structure-json") {
    if (typeof value !== "string") throw new Error("TARGET_TYPE_MISMATCH");
    const row = await db.prepare(`SELECT ${target.column} AS value FROM annotation_creative_structures WHERE annotation_id = ? FOR UPDATE`)
      .bind(annotationId).first<{ value: string }>();
    const values = (() => {
      try { return JSON.parse(row?.value || "{}") as Record<string, string>; }
      catch { return {} as Record<string, string>; }
    })();
    values[target.itemKey] = value;
    await db.prepare(`UPDATE annotation_creative_structures SET ${target.column} = ?, updated_at = CURRENT_TIMESTAMP WHERE annotation_id = ?`)
      .bind(JSON.stringify(values), annotationId).run();
    return;
  }
  if (typeof value !== "string") throw new Error("TARGET_TYPE_MISMATCH");
  await db.prepare(`UPDATE field_answers SET ${target.column} = ? WHERE annotation_id = ? AND field_code = ?`)
    .bind(value, annotationId, target.fieldCode).run();
}

export async function applyRevisionEventToAnnotation(
  db: DbClient,
  annotationId: string,
  event: RevisionEventRecord,
) {
  const target = parseAnalysisTarget(event.target_key);
  if (!target) throw new Error("TARGET_MISSING");
  const valueType = event.value_type ?? "TEXT";
  if (
    valueType === "TEXT" &&
    (await sha256Text(event.original_text)) !== event.original_text_hash
  ) {
    throw new Error("ORIGINAL_HASH_MISMATCH");
  }
  const currentValue = await readAnnotationTarget(db, annotationId, target);
  if (currentValue == null) throw new Error("TARGET_MISSING");
  if (valueType !== "TEXT") {
    const originalValue = parseRevisionValue(
      event.original_value_json,
      valueType === "MULTI_SELECT" ? [] : "",
    );
    const replacementValue = parseRevisionValue(
      event.replacement_value_json,
      valueType === "MULTI_SELECT" ? [] : "",
    );
    if (
      (await sha256Text(canonicalRevisionValue(originalValue))) !==
      event.original_text_hash
    ) {
      throw new Error("ORIGINAL_HASH_MISMATCH");
    }
    if (canonicalRevisionValue(currentValue) !== canonicalRevisionValue(originalValue)) {
      throw new Error("CONTENT_CHANGED");
    }
    await writeAnnotationTarget(db, annotationId, target, currentValue, replacementValue);
    return replacementValue;
  }
  if (typeof currentValue !== "string") throw new Error("TARGET_TYPE_MISMATCH");
  const nextValue = resolveAnchoredReplacement({
    currentValue,
    selectedText: event.original_text,
    anchorStart: Number(event.anchor_start),
    anchorEnd: Number(event.anchor_end),
    replacementText: event.replacement_text,
  });
  if (nextValue == null) throw new Error("CONTENT_CHANGED");
  await writeAnnotationTarget(db, annotationId, target, currentValue, nextValue);
  return nextValue;
}

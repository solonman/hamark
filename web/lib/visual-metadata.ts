// 公共视觉库子领域专有字段（metadata_json）的校验与归一。纯函数，不碰数据库；
// 落库与展示在 lib/visual-server.ts。规则见
// docs/22_公共视觉_立项与实施规格_V0.2.md 3.3.2、3.4——这一节写代码时不得违反：
//   1. 冻死的键在各子领域内不得改名、不得改语义。
//   2. 新增专有项就是新增键，不改已有键；每新增一个键要同步这份文件与文档表格。
//   3. 不做后台可配置的词表。
//   4. 单选和文本存字符串；多选存字符串数组；空值不写键。
//   5. 未知键：写入时（POST/PATCH）拒绝，报出键名；读取时旧版本遗留的未知键
//      原样保留在库里，但展示时过滤掉（见 parseStoredVisualMetadataForDisplay）。
//   6. 换子领域：前端丢掉旧子领域的整组专有字段；这里第 5 条兜底——一次 PATCH
//      永远整体覆盖 metadata_json，不合并旧值，所以旧子领域的键自然被换掉。

import { VISUAL_SUBDOMAIN_SPECS, type VisualMetadata, type VisualSubdomain } from "./visual-contract";

/** 文本类专有字段的长度上限。规格没有单独给这一类字段设上限，参照通用选填字段的量级定一个安全上限。 */
export const VISUAL_METADATA_TEXT_MAX = 200;

export type VisualMetadataValidation =
  | { ok: true; metadata: VisualMetadata }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 建条目／编辑时校验并归一 metadata：按 subdomain 的字段清单逐项检查，
 * 不认识的键立刻拒绝并点名键名；单选值必须在选项里；多选必须是字符串数组、
 * 值在选项里、去重；文本 trim 后不超过上限；空值（trim 后为空／空数组）不写键。
 */
export function validateVisualMetadata(
  subdomain: VisualSubdomain,
  input: unknown,
): VisualMetadataValidation {
  const spec = VISUAL_SUBDOMAIN_SPECS[subdomain];
  const raw = isPlainObject(input) ? input : {};
  const fieldByKey = new Map(spec.fields.map((field) => [field.key, field] as const));

  const unknownKey = Object.keys(raw).find((key) => !fieldByKey.has(key));
  if (unknownKey) {
    return { ok: false, error: `补充信息里有一个不认识的字段：${unknownKey}。` };
  }

  const metadata: VisualMetadata = {};
  for (const field of spec.fields) {
    const value = raw[field.key];
    if (value === undefined || value === null) continue;

    if (field.type === "one") {
      if (typeof value !== "string") {
        return { ok: false, error: `「${field.label}」的取值不在可选项里。` };
      }
      const text = value.trim();
      if (!text) continue;
      if (!(field.options as readonly string[]).includes(text)) {
        return { ok: false, error: `「${field.label}」的取值不在可选项里。` };
      }
      metadata[field.key] = text;
      continue;
    }

    if (field.type === "many") {
      if (!Array.isArray(value)) {
        return { ok: false, error: `「${field.label}」应该是多选，请重新提交。` };
      }
      const seen = new Set<string>();
      const values: string[] = [];
      for (const item of value) {
        if (typeof item !== "string") {
          return { ok: false, error: `「${field.label}」的取值不在可选项里。` };
        }
        const text = item.trim();
        if (!text) continue;
        if (!(field.options as readonly string[]).includes(text)) {
          return { ok: false, error: `「${field.label}」的取值不在可选项里。` };
        }
        if (seen.has(text)) continue;
        seen.add(text);
        values.push(text);
      }
      if (values.length) metadata[field.key] = values;
      continue;
    }

    // field.type === "text"
    if (typeof value !== "string") {
      return { ok: false, error: `「${field.label}」的格式不对，请重新填写。` };
    }
    const text = value.trim();
    if (!text) continue;
    if (text.length > VISUAL_METADATA_TEXT_MAX) {
      return { ok: false, error: `「${field.label}」最多 ${VISUAL_METADATA_TEXT_MAX} 字。` };
    }
    metadata[field.key] = text;
  }

  return { ok: true, metadata };
}

/**
 * 读库时给展示用：按当前 subdomain 的字段清单过滤 metadata_json——只认识的键才
 * 返回，旧版本遗留的未知键（比如已经删掉的 interactive / brandName）留在库里的
 * 原始 JSON 文本不受影响，只是不出现在这次的返回值里（规格 3.4 第 5 条）。
 * 出错的存量数据（不是对象、字段类型不对）一律跳过，不抛错——这是读路径，
 * 不该因为旧脏数据把详情页打不开。
 */
export function parseStoredVisualMetadataForDisplay(
  subdomain: VisualSubdomain,
  metadataJson: string,
): VisualMetadata {
  const spec = VISUAL_SUBDOMAIN_SPECS[subdomain];
  const fieldByKey = new Map(spec.fields.map((field) => [field.key, field] as const));

  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(metadataJson);
    raw = isPlainObject(parsed) ? parsed : {};
  } catch {
    raw = {};
  }

  const metadata: VisualMetadata = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = fieldByKey.get(key);
    if (!field) continue;
    if (field.type === "many") {
      if (!Array.isArray(value)) continue;
      const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      if (values.length) metadata[key] = values;
    } else if (typeof value === "string" && value.trim()) {
      metadata[key] = value;
    }
  }
  return metadata;
}

// 草稿的审阅修改（docs/26 6.6）：纯函数。各节能做什么照 RETRO_DRAFT_SECTIONS：
// - 案例回顾的「经过」只能改；争议、老孙指出的问题、改进建议能改能删、不能补；
// - 核心认识、改进事项、方法候选、本月观察能改能删能补（补的 origin=MANUAL，可以不带出处）；
// - 改过的 edited=true；方法候选可以改维度、类别、迁移性；SITUATIONAL 必须有情境。
// 乐观锁（draft_revision）在服务层做，这里只负责把一次修改套到草稿上。

import { randomUUID } from "node:crypto";
import {
  RETRO_DRAFT_SECTIONS,
  RETRO_LIMITS,
  type RetroDraftPatchRequest,
  type RetroDraftSection,
  type RetroItem,
  type RetroMethodCandidate,
  type RetroMethods,
  type RetroMinutes,
  type RetroSource,
} from "@/lib/retro-model";
import { isDimension, isKind, isTransfer } from "./extraction";
import { RetroError, retroInvalid } from "./errors";
import { orderRetroCandidates } from "./synthesis";

export type RetroDraft = { minutes: RetroMinutes; methods: RetroMethods };

export type NormalizedDraftPatch = {
  section: RetroDraftSection;
  caseId: string | null;
  itemId: string | null;
  op: "UPDATE" | "DELETE" | "ADD";
  value: NonNullable<RetroDraftPatchRequest["value"]>;
  revision: number;
};

const CASE_SECTIONS = ["case.process", "case.disputes", "case.founderPoints", "case.suggestions"] as const;

export function normalizeDraftPatchRequest(body: unknown): NormalizedDraftPatch {
  const input = (body && typeof body === "object" ? body : {}) as Partial<RetroDraftPatchRequest>;
  if (typeof input.section !== "string" || !(input.section in RETRO_DRAFT_SECTIONS)) throw retroInvalid("不认识要修改的部分。");
  if (input.op !== "UPDATE" && input.op !== "DELETE" && input.op !== "ADD") throw retroInvalid("不支持的修改操作。");
  const revision = Number(input.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw retroInvalid("缺少有效的 revision。");
  const section = input.section as RetroDraftSection;
  const isCase = (CASE_SECTIONS as readonly string[]).includes(section);
  const caseId = typeof input.caseId === "string" && input.caseId.trim() ? input.caseId.trim() : null;
  if (isCase && !caseId) throw retroInvalid("修改案例回顾要带 caseId。");
  const itemId = typeof input.itemId === "string" && input.itemId.trim() ? input.itemId.trim() : null;
  if ((input.op === "UPDATE" || input.op === "DELETE") && section !== "case.process" && !itemId) throw retroInvalid("要指明修改哪一条（itemId）。");
  const value = input.value && typeof input.value === "object" ? input.value : {};
  return { section, caseId: isCase ? caseId : null, itemId, op: input.op, value, revision };
}

const notAllowed = (message: string) => new RetroError(400, "DRAFT_OP_NOT_ALLOWED", message);
const itemMissing = () => new RetroError(404, "DRAFT_ITEM_NOT_FOUND", "这一条已经不在草稿里了，请刷新后再改。");

function checkedText(value: unknown, label: string, max: number, required: boolean): string {
  if (typeof value !== "string") throw retroInvalid(`${label}格式不对。`);
  const text = value.trim();
  if (required && !text) throw retroInvalid(`${label}不能为空；要去掉这一条请用删除。`);
  if ([...text].length > max) throw retroInvalid(`${label}不能超过 ${max} 字。`);
  return text;
}

const hasKey = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function updateCandidate(candidate: RetroMethodCandidate, value: NormalizedDraftPatch["value"]): RetroMethodCandidate {
  const next = { ...candidate };
  if (hasKey(value, "title")) next.title = checkedText(value.title, "标题", RETRO_LIMITS.draftTitleMax, true);
  if (hasKey(value, "description")) next.description = checkedText(value.description, "描述", RETRO_LIMITS.draftTextMax, false);
  if (hasKey(value, "situation")) next.situation = checkedText(value.situation, "情境", RETRO_LIMITS.draftTextMax, false);
  if (hasKey(value, "transferNote")) next.transferNote = checkedText(value.transferNote, "迁移性说明", RETRO_LIMITS.draftTextMax, false);
  if (hasKey(value, "dimension")) {
    if (!isDimension(value.dimension)) throw retroInvalid("维度不合法。");
    next.dimension = value.dimension;
  }
  if (hasKey(value, "kind")) {
    if (!isKind(value.kind)) throw retroInvalid("类别不合法。");
    next.kind = value.kind;
  }
  if (hasKey(value, "transfer")) {
    if (!isTransfer(value.transfer)) throw retroInvalid("迁移性不合法。");
    next.transfer = value.transfer;
  }
  if (!next.title) throw retroInvalid("标题不能为空。");
  if (next.kind === "SITUATIONAL" && !next.situation.trim()) throw retroInvalid("情境判断必须写明是什么情境。");
  return next;
}

function changed(before: object, after: object) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

export type DraftPatchResult = { draft: RetroDraft; itemId: string | null };

/** 把一次修改套到草稿上，返回新草稿（不改入参）。 */
export function applyRetroDraftPatch(
  draft: RetroDraft,
  patch: NormalizedDraftPatch,
  newId: (prefix: string) => string = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`,
): DraftPatchResult {
  const rule = RETRO_DRAFT_SECTIONS[patch.section];
  if (patch.op === "UPDATE" && !rule.update) throw notAllowed("这一部分不能修改。");
  if (patch.op === "DELETE" && !rule.remove) throw notAllowed(patch.section === "case.process" ? "案例回顾的「经过」只能修改，不能删除。" : "这一部分不能删除。");
  if (patch.op === "ADD" && !rule.add) throw notAllowed("这一部分只能修改或删除，不能补充。");

  const minutes: RetroMinutes = structuredClone(draft.minutes);
  const methods: RetroMethods = structuredClone(draft.methods);
  const value = patch.value;

  // 案例回顾
  if (patch.section.startsWith("case.")) {
    const review = minutes.cases.find((item) => item.caseId === patch.caseId);
    if (!review) throw new RetroError(404, "DRAFT_ITEM_NOT_FOUND", "这个案例不在草稿的案例回顾里。");
    if (patch.section === "case.process") {
      const text = checkedText(value.text, "经过", RETRO_LIMITS.draftTextMax, false);
      if (text !== review.process) {
        review.process = text;
        review.processEdited = true;
      }
      return { draft: { minutes, methods }, itemId: null };
    }
    const key = patch.section.slice("case.".length) as "disputes" | "founderPoints" | "suggestions";
    const list = review[key];
    const index = list.findIndex((item) => item.id === patch.itemId);
    if (index < 0) throw itemMissing();
    if (patch.op === "DELETE") list.splice(index, 1);
    else {
      const text = checkedText(value.text, "内容", RETRO_LIMITS.draftTextMax, true);
      if (text !== list[index].text) list[index] = { ...list[index], text, edited: true };
    }
    return { draft: { minutes, methods }, itemId: patch.op === "DELETE" ? null : patch.itemId };
  }

  // 核心认识、改进事项、本月观察
  if (patch.section === "insights" || patch.section === "actions" || patch.section === "observations") {
    const list: RetroItem[] = patch.section === "observations" ? methods.observations : minutes[patch.section];
    if (patch.op === "ADD") {
      const text = checkedText(value.text, "内容", RETRO_LIMITS.draftTextMax, true);
      const id = newId("man");
      list.push({ id, text, sources: [], origin: "MANUAL", edited: false });
      return { draft: { minutes, methods }, itemId: id };
    }
    const index = list.findIndex((item) => item.id === patch.itemId);
    if (index < 0) throw itemMissing();
    if (patch.op === "DELETE") {
      list.splice(index, 1);
      return { draft: { minutes, methods }, itemId: null };
    }
    const text = checkedText(value.text, "内容", RETRO_LIMITS.draftTextMax, true);
    if (text !== list[index].text) list[index] = { ...list[index], text, edited: true };
    return { draft: { minutes, methods }, itemId: patch.itemId };
  }

  // 方法候选
  if (patch.op === "ADD") {
    const id = newId("man");
    const base: RetroMethodCandidate = {
      id,
      number: 0,
      dimension: "ENTRY",
      kind: "METHOD",
      title: "",
      description: "",
      situation: "",
      transfer: "UNSURE",
      transferNote: "",
      sources: [],
      origin: "MANUAL",
      edited: false,
    };
    if (!isDimension(value.dimension)) throw retroInvalid("补充方法候选要选维度。");
    if (!isKind(value.kind)) throw retroInvalid("补充方法候选要选类别。");
    const candidate = updateCandidate(base, { transfer: "UNSURE", ...value });
    methods.candidates = orderRetroCandidates([...methods.candidates, { ...candidate, edited: false }]);
    return { draft: { minutes, methods }, itemId: id };
  }
  const index = methods.candidates.findIndex((item) => item.id === patch.itemId);
  if (index < 0) throw itemMissing();
  if (patch.op === "DELETE") {
    methods.candidates = orderRetroCandidates(methods.candidates.filter((_, position) => position !== index));
    return { draft: { minutes, methods }, itemId: null };
  }
  const before = methods.candidates[index];
  const after = updateCandidate(before, value);
  if (changed(before, after)) methods.candidates[index] = { ...after, edited: true };
  methods.candidates = orderRetroCandidates(methods.candidates);
  return { draft: { minutes, methods }, itemId: patch.itemId };
}

/** 草稿（或发布版）里所有出处，用来取引文快照。 */
export function collectRetroDraftSources(draft: RetroDraft): RetroSource[] {
  const sources: RetroSource[] = [];
  const add = (items: readonly RetroItem[]) => items.forEach((item) => sources.push(...item.sources));
  for (const review of draft.minutes.cases) {
    sources.push(...review.processSources);
    add(review.disputes);
    add(review.founderPoints);
    add(review.suggestions);
  }
  add(draft.minutes.insights);
  add(draft.minutes.actions);
  add(draft.methods.observations);
  for (const candidate of draft.methods.candidates) sources.push(...candidate.sources);
  return sources;
}

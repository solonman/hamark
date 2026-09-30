// 把版本 payload 翻成外部 Agent 直接能读的中文结构：字段名用工作台上的中文
// 标签，选项 id 换成词表里的中文标签，编号与页码范围按工作台同一套规则推导。
// 纯函数；标签全部复用站内已有常量，不另写一份口径。

import type {
  V04ChoiceValue,
  V04DraftPayloadV1,
  V04PerceptionType,
} from "@/lib/v04-contract";
import { V04_UI_PATHS } from "@/lib/v04-ui-fixture";
import { V04_UI_SHOT_FIELDS } from "@/lib/v04-ui-model";
import { V04_VOCABULARY_OPTIONS } from "@/lib/v04-vocabulary";
import {
  moduleNumbers,
  pageRangeLabel,
  sortedChildUnits,
  sortedModules,
  sortedRootUnits,
  unitDirectPages,
  unitPages,
  modulePages,
  freePages,
  type ReportAnnotation,
  type ReportUnit,
} from "@/lib/report-structure";

// ---------------------------------------------------------------------------
// 视频拆解（V1.9 payload AD_VIDEO_PAYLOAD_V1）
// ---------------------------------------------------------------------------

const OPTION_LABELS = new Map<string, string>(
  V04_VOCABULARY_OPTIONS.map((option) => [option.optionId as string, option.labelZhCn as string]),
);

const CARRIER_LABELS: Record<string, string> = { STORY: "故事", COPY: "文案", AUDIOVISUAL_RULE: "视听规则" };

const PRIMARY_DETAIL_KEYS: Record<V04PerceptionType, readonly string[]> = {
  LOVE: ["emotionalBase", "accumulation", "gapPressure", "releaseMethod", "mainCarrier"],
  FUN: ["originalExpectation", "deviation", "reveal", "reinterpretation", "mainCarrier"],
  PERCEPTION: ["perceptionRule", "repetitionVariation", "audiovisualRelation", "payoff", "mainCarrier"],
};

function pathInfo(type: string) {
  return V04_UI_PATHS.find((path) => path.id === type);
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function optionLabels(choice: V04ChoiceValue | undefined): string[] {
  const ids = Array.isArray(choice?.selectedOptionIds) ? choice.selectedOptionIds : [];
  return ids.map((id) => OPTION_LABELS.get(id) ?? id);
}

/** 桥段作用、故事参照类型：词表选项 + 自定义补充。只保留非空项。 */
function readableChoice(choice: V04ChoiceValue | undefined) {
  const out: Record<string, unknown> = {};
  const labels = optionLabels(choice);
  if (labels.length) out.选项 = labels;
  if (text(choice?.customText)) out.自定义 = text(choice?.customText);
  return out;
}

/** 手法及机制：工作台上是「机制」选项 + 「手法」文字 + 待形成新机制时的「进阶机制层」。 */
function readableMechanism(choice: V04ChoiceValue | undefined) {
  const out: Record<string, unknown> = {};
  const labels = optionLabels(choice);
  if (labels.length) out.机制 = labels;
  if (text(choice?.customText)) out.手法 = text(choice?.customText);
  if (text(choice?.advancedText)) out.进阶机制层 = text(choice?.advancedText);
  return out;
}

const byOrder = <T extends { orderIndex: number }>(items: readonly T[]) =>
  [...items].sort((a, b) => a.orderIndex - b.orderIndex);

export function toReadableVideoAnalysis(payload: V04DraftPayloadV1) {
  const facts = payload.factsAndCoreJudgement;
  const path = payload.perceptionPath;
  const primary = pathInfo(path.primaryType);
  const primaryKeys = path.primaryType ? PRIMARY_DETAIL_KEYS[path.primaryType] : [];

  return {
    "第一模块｜全片事实与核心判断": {
      商业意图: text(facts.commercialIntent),
      故事梗概: text(facts.storySynopsis),
      创意母题: text(facts.creativeMotif),
      张力按钮: text(facts.tensionButton),
      创意主导手法及机制: readableMechanism(facts.mainMechanism),
      创意辅助手法及机制: readableMechanism(facts.auxiliaryMechanism),
      创意思维链: text(facts.creativeThinkingChain),
      故事参照类型: readableChoice(facts.storyReference),
      创意承重载体: (facts.creativeCarriers ?? []).map((carrier) => CARRIER_LABELS[carrier] ?? carrier),
      创意承重载体具体说明: text(facts.carrierExplanation),
      创意成立契约: text(facts.acceptanceContract),
    },
    "第二模块｜脚本反写": byOrder(payload.script.shotGroups).map((group, groupIndex) => ({
      桥段序号: groupIndex + 1,
      桥段名称: text(group.bridgeName),
      桥段主创意作用: readableChoice(group.primaryCreativeRole),
      桥段辅助创意作用: readableChoice(group.auxiliaryCreativeRole),
      本桥段关键创意描述: text(group.keyCreativeDescription),
      镜头: byOrder(group.shots).map((shot, shotIndex): Record<string, string> => ({
        镜号: `${groupIndex + 1}-${shotIndex + 1}`,
        ...Object.fromEntries(V04_UI_SHOT_FIELDS.map(({ key, label }) => [label, text(shot[key])])),
      })),
    })),
    "第三模块｜主导感知类型发生路径与整体评价": {
      主导路径: primary?.label ?? "",
      主导路径细项: Object.fromEntries(
        primaryKeys.map((key, index) => [primary?.fields[index] ?? key, text(path.primaryDetails?.[key])]),
      ),
      辅助路径: (path.auxiliaryTypes ?? []).map((aux) => ({
        类型: pathInfo(aux.type)?.label ?? aux.type,
        辅助路径说明: text(aux.description),
        辅助类型的创意作用: text(aux.creativeRole),
      })),
      整体创意评价: facts.overallCreativeRating || "",
      评价理由: text(facts.ratingReason),
    },
  };
}

// ---------------------------------------------------------------------------
// 报告拆解（report-annotation/1）
// ---------------------------------------------------------------------------

const UNIT_DEPTH_TITLES = ["讲述单元", "子单元", "孙单元", "曾孙单元"];

const pageNos = (pages: readonly { n: number }[]) => pages.map((page) => page.n);

export function toReadableReportAnalysis(annotation: ReportAnnotation) {
  const numbers = moduleNumbers(annotation);

  const readableUnit = (unit: ReportUnit, depth: number): Record<string, unknown> => {
    const all = unitPages(annotation, unit.id);
    const children = sortedChildUnits(annotation, unit.id);
    return {
      编号: numbers[unit.id] ?? "",
      层级: UNIT_DEPTH_TITLES[Math.min(depth, UNIT_DEPTH_TITLES.length - 1)],
      单元名称: text(unit.name),
      单元间组织关系: text(unit.rel),
      "传播／讲述任务": text(unit.task),
      讲述作用: text(unit.role),
      预期心理: text(unit.psy),
      候选结论: text(unit.concl),
      页码范围: pageRangeLabel(all),
      直属页码: pageNos(unitDirectPages(annotation, unit.id)),
      ...(children.length ? { 下级单元: children.map((child) => readableUnit(child, depth + 1)) } : {}),
    };
  };

  const locationOf = (page: ReportAnnotation["pages"][number]) => {
    if (page.uid) return numbers[page.uid] ? `单元 ${numbers[page.uid]}` : "";
    if (page.mid) return numbers[page.mid] ? `模块 ${numbers[page.mid]}` : "";
    return "未归属";
  };

  return {
    案例背景: {
      城市: text(annotation.background?.city),
      开发商: text(annotation.background?.developer),
      项目背景: text(annotation.background?.projectBackground),
      业务背景: text(annotation.background?.businessBackground),
    },
    报告策略: {
      竞争与提报策略: text(annotation.strategy?.narrative),
      报告模型: text(annotation.strategy?.model),
    },
    结构: sortedModules(annotation).map((module) => ({
      编号: numbers[module.id] ?? "",
      模块名称: text(module.name),
      模块间组织关系: text(module.rel),
      策略作用: text(module.role),
      页码范围: pageRangeLabel(modulePages(annotation, module.id)),
      讲述单元: sortedRootUnits(annotation, module.id).map((unit) => readableUnit(unit, 0)),
    })),
    未归属页码: pageNos(freePages(annotation)),
    逐页: [...annotation.pages]
      .sort((a, b) => a.n - b.n)
      .map((page) => ({
        页码: page.n,
        所属: locationOf(page),
        过渡页: Boolean(page.transition),
        页面作用: text(page.func),
        本页组织关系: text(page.org),
        组块: page.blocks.map((block, index) => ({
          序号: index + 1,
          组块名称: text(block.name),
          内容类型: text(block.type),
          组块作用: Array.isArray(block.roles) ? block.roles : [],
          文风类型: text(block.style),
          组块间组织关系: text(block.rel),
          叙述作用: text(block.narr),
          关键标记: text(block.mark),
          "位置（页图百分比）": { x: block.x, y: block.y, w: block.w, h: block.h },
        })),
      })),
  };
}

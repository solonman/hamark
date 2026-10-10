// 本地假实现（docs/25 4.10）：AUDIO_REVIEW_PROVIDER=fake 或本机演示模式下用，供本机预览和验收。
// 不碰网络、不产生费用。
//   - 转写：提交后约 3 秒「完成」（每 1.5 秒查一次，第二次查询返回），给出 demo 里那段「捉迷藏」点评；
//   - 理解：约 3 秒后，按快照里真实的桥段和镜头 id 确定性地生成一份原始输出（与真模型同一形状），
//     覆盖总体意见（多处改动）、具体意见（单处）、选项字段、评价、细项、镜头字段和「没落到条目的话」，
//     再交给 proposal.ts 走同一套校验。
// 整个流程（上传后）大约 10 秒走完。

import type { V04ChoiceValue, V04DraftPayloadV1, V04PerceptionType } from "@/lib/v04-contract";
import type { AsrDescribeOutcome, AsrSubmitOutcome } from "./tencent-asr";
import type { LlmMessages, LlmOutcome } from "./deepseek";
import type { AudioReviewPromptContext } from "./prompt";
import { PRIMARY_DETAIL_KEYS, vocabularyOptions } from "./fields";
import type { AudioReviewTranscriptSegment } from "./transcript";

export const FAKE_ASR_ENGINE = "fake-16k_zh_en";
export const FAKE_LLM_MODEL = "fake-deepseek";
export const FAKE_ASR_READY_MS = 3_000;
export const FAKE_ASR_POLL_INTERVAL_MS = 1_500;
export const FAKE_LLM_DELAY_MS = 3_000;
export const FAKE_AUDIO_DURATION_MS = 684_000;

/** demo 里的「捉迷藏」点评。S0＝老孙，S1＝被点评人，S2＝提问的同事。第 11 段保留听写原文「对质生意」。 */
const FAKE_LINES: Array<[number, string, string]> = [
  [8, "S0", "好，下一个，梦娜的《捉迷藏》。片子大家都看过了，我直接说。"],
  [31, "S0", "先说好的，镜头拆得很细，时间码也准，这个基本功是到位的。"],
  [112, "S0", "问题出在判断上。你这个母题写的是“让日常城市生活绽放活力美好”，这个太虚了，换十条片子都能这么写。"],
  [134, "S0", "这片子真正好的地方是什么？是那些穿西装的、开报亭的、还有最后那个警察，这些平时最体面、最正经的大人，突然被允许当一回小孩。张力在这儿，不在“城市变游乐场”。"],
  [185, "S1", "我当时觉得结尾大家都不见了，算是一个反转。"],
  [192, "S0", "那个是结果，不是反转。它的反转是“原来全城都在陪一个孩子玩”，而且一个比一个认真。重新理解那一栏也要跟着改，不是城市好玩，是大人心里一直想玩。"],
  [260, "S0", "第二段你叫“城市变游乐场”，作用选的是升级视听规则。其实它是同一个“躲”的动作一直重复，但躲的人一个比一个不该躲——上班族、报亭老板、警察，意思是一层层变的。"],
  [298, "S0", "对了，井盖那个镜头，钻出来的是个警察，你写成“一个人”，这个信息很关键，要写出来。"],
  [340, "S0", "还有一个通病啊，不光是梦娜，你们很多人都这样：关键创意描述全在复述画面，邮筒后面躲一个人、报亭躲一个人，这个我看片子就知道了。要写的是这一段为什么成立，它在机制上干了什么。"],
  [422, "S2", "孙老师，那它主导机制还算形式游戏吗？"],
  [429, "S0", "形式游戏没错。但辅助不是洞察共鸣，是对质生意——体面和幼稚放在一起，才生出意思来。"],
  [495, "S0", "最后说分。梦娜你给 S，我觉得高了，我给 A。前面两段都很好，问题在结尾：回头一看街上没人，这个处理太常见了，收得软。"],
  [570, "S0", "这条片子的导演之前那条洗衣液也是这个路子，有空可以找来看看。"],
  [612, "S0", "最后一个建议，下次拆之前先完整看三遍再动笔，别边看边写。"],
  [648, "S0", "好，梦娜这条就到这儿。"],
];

export function fakeTranscriptSegments(): AudioReviewTranscriptSegment[] {
  return FAKE_LINES.map(([seconds, speakerId, text], index) => {
    const next = FAKE_LINES[index + 1];
    const endSeconds = next ? Math.max(seconds + 2, next[0] - 1) : FAKE_AUDIO_DURATION_MS / 1000 - 2;
    return { id: index + 1, startMs: seconds * 1000, endMs: endSeconds * 1000, speakerId, text };
  });
}

export function createFakeAsr(clock: () => number = Date.now) {
  return {
    engine: FAKE_ASR_ENGINE,
    pollIntervalMs: FAKE_ASR_POLL_INTERVAL_MS,
    async submit(): Promise<AsrSubmitOutcome> {
      return { ok: true, taskId: `fake-${clock()}`, usedHotwords: true, engine: FAKE_ASR_ENGINE };
    },
    async describe(taskId: string): Promise<AsrDescribeOutcome> {
      const submittedAt = Number(taskId.replace(/^fake-/, ""));
      if (!Number.isFinite(submittedAt)) return { kind: "FAILED", reason: "假转写任务编号无效。" };
      if (clock() - submittedAt < FAKE_ASR_READY_MS) return { kind: "PENDING", status: 1 };
      return { kind: "SUCCESS", segments: fakeTranscriptSegments(), durationMs: FAKE_AUDIO_DURATION_MS };
    },
  };
}

// ---------------------------------------------------------------------------
// 假理解：确定性地拼出一份原始输出
// ---------------------------------------------------------------------------

const DETAIL_AFTER: Record<V04PerceptionType, Record<string, string>> = {
  FUN: {
    deviation: "越来越体面的大人一个接一个躲起来，连警察也加入了。",
    reveal: "原来全城的大人都在陪一个孩子捉迷藏，而且一个比一个认真。",
    reinterpretation: "不是城市好玩，是大人心里一直想玩，只差一个被允许的理由。",
    mainCarrier: "躲藏者的身份递进（上班族 → 报亭老板 → 警察）",
  },
  LOVE: {
    accumulation: "一个比一个体面的大人放下身份陪孩子玩，善意一层层叠加。",
    releaseMethod: "孩子回头时只剩藏不住的笑声：大人们的童心在这一刻被听见。",
    mainCarrier: "躲藏者的身份递进（上班族 → 报亭老板 → 警察）",
  },
  PERCEPTION: {
    repetitionVariation: "同一个“躲”的动作反复出现，躲的人一次比一次“不该躲”。",
    payoff: "空街上的笑声兑现：看不见人，却听得见大人在玩。",
    mainCarrier: "躲藏者的身份递进（上班族 → 报亭老板 → 警察）",
  },
};

const BRIDGE_DESCRIPTIONS = [
  "先把规则交给一个孩子：她只负责数数，城市的反应全在她背后发生。匆忙的上班族作背景，立住“这座城市本来没空陪你玩”的原始预期。",
  "同一个“躲”的动作反复出现，但躲的人一次比一次“不该躲”——上班族、报亭老板、警察。动作不变、身份递进，意义随之改变，荒唐感逐级累加。",
  "用“空街＋笑声”兑现：看不见人，却听得见大人藏不住的开心，把母题落在“大人也在玩”上。",
];

function label(field: "bridgeCreativeRole" | "generalMechanism", optionId: string) {
  return vocabularyOptions(field).find((option) => option.optionId === optionId)?.labelZhCn ?? optionId;
}

/** 不和另一侧选项撞车的第一个候选。 */
function firstFree(field: "bridgeCreativeRole" | "generalMechanism", candidates: string[], taken: V04ChoiceValue) {
  const id = candidates.find((candidate) => !taken.selectedOptionIds.includes(candidate)) ?? candidates[candidates.length - 1];
  return label(field, id);
}

export function buildFakeModelOutput(context: Pick<AudioReviewPromptContext, "snapshot" | "segments" | "revieweeName">) {
  const snapshot: V04DraftPayloadV1 = context.snapshot;
  const facts = snapshot.factsAndCoreJudgement;
  const groups = snapshot.script.shotGroups;
  const changes: Array<{ key: string; value: unknown; opinionIds: string[] }> = [];

  // 意见 1（总体）：母题看浅了——母题、张力、思维链、契约、路径细项一起改。
  changes.push(
    { key: "facts.creativeMotif", value: "让最体面的大人被允许重新当一回孩子", opinionIds: ["o1"] },
    {
      key: "facts.tensionButton",
      value: "西装革履的上班族、报亭老板、执勤的警察——城市里最“不该玩”的人，一个接一个蹲下、钻进、缩起来，陪一个孩子躲猫猫。",
      opinionIds: ["o1"],
    },
    {
      key: "facts.creativeThinkingChain",
      value: "体面的大人平时不被允许玩\n  - 借一个孩子的数数，给所有人一个“合法”的理由\n  - 越正经的身份越要躲，荒唐感逐级放大\n    - 上班族 → 报亭老板 → 警察\n  - 大人重新当了一回孩子",
      opinionIds: ["o1"],
    },
    {
      key: "facts.acceptanceContract",
      value: "观众相信“孩子发起的游戏”是一张通行证：只要是陪孩子玩，再体面的大人放下身份也不丢人。",
      opinionIds: ["o1"],
    },
  );
  const primaryType = snapshot.perceptionPath.primaryType;
  if (primaryType) {
    for (const subKey of PRIMARY_DETAIL_KEYS[primaryType]) {
      const value = DETAIL_AFTER[primaryType][subKey];
      if (value) changes.push({ key: `path.primaryDetails.${subKey}`, value, opinionIds: ["o1"] });
    }
  }

  // 意见 2（具体）：第二桥段的作用与名称，井盖里钻出来的是警察。
  const second = groups[1] ?? groups[0];
  if (second) {
    changes.push(
      { key: `shotGroup:${second.id}.bridgeName`, value: "越正经的人越要躲", opinionIds: ["o2"] },
      {
        key: `shotGroup:${second.id}.primaryCreativeRole`,
        value: {
          options: [firstFree("bridgeCreativeRole", ["REPEAT_AND_SHIFT_MEANING", "ACCUMULATE_INFORMATION"], second.auxiliaryCreativeRole)],
          custom: "",
        },
        opinionIds: ["o2"],
      },
    );
    const shot = second.shots[2] ?? second.shots[second.shots.length - 1];
    if (shot) {
      changes.push({ key: `shot:${shot.id}.visualContent`, value: "井盖被顶起，一名执勤的警察探出头张望，又缩了回去。", opinionIds: ["o2"] });
    }
  }

  // 意见 3（总体）：关键创意描述都在复述画面——每个桥段都改，承重说明也改。
  groups.forEach((group, index) => {
    const value = BRIDGE_DESCRIPTIONS[index]
      ?? `这一段在机制上的作用：承接前文“体面的大人被允许玩”的判断，把${group.bridgeName.trim() || `桥段 ${index + 1}`}写成推进这一判断的一步，而不是复述画面。`;
    changes.push({
      key: `shotGroup:${group.id}.keyCreativeDescription`,
      value,
      opinionIds: group === second ? ["o3", "o2"] : ["o3"],
    });
  });
  changes.push({
    key: "facts.carrierExplanation",
    value: "故事上靠躲藏者的身份递进制造荒唐感；视听上让同一个“躲”的动作反复出现、节奏逐次收紧，观众开始预判下一个会是谁。",
    opinionIds: ["o3"],
  });

  // 意见 4（具体，来自问答）：辅助机制是对置生义。
  changes.push({
    key: "facts.auxiliaryMechanism",
    value: {
      options: [firstFree("generalMechanism", ["JUXTAPOSITION_CREATES_MEANING", "REPETITION_CHANGES_MEANING"], facts.mainMechanism)],
      custom: "身份与行为对置：越体面的人做越幼稚的事",
      advanced: "",
    },
    opinionIds: ["o4"],
  });

  // 意见 5（具体）：评价给高了。
  changes.push(
    { key: "facts.overallCreativeRating", value: facts.overallCreativeRating === "A" ? "B" : "A", opinionIds: ["o5"] },
    {
      key: "facts.ratingReason",
      value: "前两个桥段把“体面的大人被允许玩”做得很足，身份递进清楚；但结尾“回头街上空无一人”的处理较常见，收得偏软，没有把母题再推一步。",
      opinionIds: ["o5"],
    },
  );

  return {
    speakers: {
      reviewer: "S0",
      labels: { S1: context.revieweeName || "被点评人", S2: "王一凡" },
      // 按内容逐段判断（真实转写的说话人标签常常全是 S0）：第 5 段是被点评人的自述，第 10 段是同事提问。
      others: [
        { segmentId: 5, speaker: context.revieweeName || "被点评人" },
        { segmentId: 10, speaker: "王一凡" },
      ],
    },
    opinions: [
      {
        id: "o1", kind: "GENERAL",
        summary: "母题看浅了：片子说的不是“城市变游乐场”，而是“最体面的大人被允许重新当一回孩子”",
        segmentIds: [3, 4, 6],
        rationale: "总体意见：改变了对全片的核心判断，逐个检查了全部条目，凡是建立在旧判断上的都跟着改。",
      },
      {
        id: "o2", kind: "SPECIFIC",
        summary: "第二桥段的作用不是“升级视听规则”，而是同一个“躲”的动作重复、躲的人一个比一个不该躲；井盖里钻出来的是警察",
        segmentIds: [7, 8],
        rationale: "具体意见：只落到第二个桥段和其中一个镜头。",
      },
      {
        id: "o3", kind: "GENERAL",
        summary: "关键创意描述都在复述画面，要写“这一段为什么成立、在机制上做了什么”",
        segmentIds: [9],
        rationale: "总体意见：每个桥段的关键创意描述和承重载体说明都按“写机制、不写画面”重写。",
      },
      {
        id: "o4", kind: "SPECIFIC",
        summary: "主导机制“形式游戏”没错，辅助机制应是“对置生义”而不是“洞察共鸣”",
        segmentIds: [10, 11],
        rationale: "具体意见，来自问答：问题是同事提的，以老孙的回答为准；“对置生义”在词表内。",
      },
      {
        id: "o5", kind: "SPECIFIC",
        summary: "整体创意评价给 S 偏高，应为 A：结尾“回头街上没人”处理常见，收得软",
        segmentIds: [12],
        rationale: "具体意见：改评价和评价理由。",
      },
    ],
    changes,
    unaddressed: [
      { segmentIds: [1], reason: "开场白，不对应作业条目。" },
      { segmentIds: [2], reason: "肯定的部分，不需要改。" },
      { segmentIds: [5], reason: "被点评人的解释，只用来理解上下文（老孙随后的回答已并入意见 1）。" },
      { segmentIds: [13], reason: "背景信息，不对应作业条目。" },
      { segmentIds: [14], reason: "做法建议，不对应作业条目。" },
    ],
    corrections: [{ segmentId: 11, from: "对质生意", to: "对置生义" }],
  };
}

export function createFakeLlm(sleep: (ms: number) => Promise<void>, clock: () => number = Date.now) {
  return {
    model: FAKE_LLM_MODEL,
    async complete(_messages: LlmMessages, context: AudioReviewPromptContext): Promise<LlmOutcome> {
      const started = clock();
      await sleep(FAKE_LLM_DELAY_MS);
      return {
        ok: true,
        content: JSON.stringify(buildFakeModelOutput(context)),
        finishReason: "stop",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, fake: true },
        model: FAKE_LLM_MODEL,
        durationMs: Math.max(0, clock() - started),
      };
    },
  };
}

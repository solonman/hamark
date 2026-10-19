// 月度整理测试共用的快照样例（不是测试文件本身；文件名不以 .test.ts 结尾）。
// 两个参与提炼的案例（案例 2 有两段点评录音和一段客户录音）、一个没有录音的案例、一段整场总结；
// 案例 1 是已删除的案例，只占序号。

import type { RetroTranscriptSegment } from "../lib/retro-model";
import type { RetroGenerateSnapshot, RetroSnapshotCase } from "../lib/retro/month-snapshot";

export const seg = (id: number, seconds: number, speakerId: string, text: string): RetroTranscriptSegment => ({
  id,
  startMs: seconds * 1000,
  endMs: seconds * 1000 + 4000,
  speakerId,
  text,
});

export const CASE_A: RetroSnapshotCase = {
  caseId: "rtc_a",
  number: 2,
  department: "策略部",
  clientName: "乳企",
  title: "年货节主视觉三次被否",
  sceneTags: ["改稿"],
  background: "客户要年货节主视觉，要求有团圆感。",
  outcome: "第三版通过，延期两周。",
  turningPoints: "",
  discussionQuestions: "",
  rounds: [
    { id: "rnd_a1", position: 1, title: "第 1 版", occurredOn: "9 月初", deliveryText: "红色团圆餐桌", feedbackText: "太像去年", responseText: "换国潮", links: [] },
    { id: "rnd_a2", position: 2, title: "第 2 版", occurredOn: "", deliveryText: "国潮插画", feedbackText: "产品看不见", responseText: "", links: [] },
  ],
  clientAudio: [
    {
      assetId: "ast_voice",
      roundId: "rnd_a1",
      fileName: "客户语音.m4a",
      segments: [seg(1, 5, "S0", "你们这个太像去年了，年轻一点。"), seg(2, 20, "S0", "团圆感和新意你们自己平衡。")],
      omittedSegments: 0,
    },
  ],
  recordings: [
    {
      recordingId: "rtr_a1",
      partNo: 1,
      segments: [
        seg(1, 15, "S1", "我讲一下乳企年货节这个案子。"),
        seg(2, 760, "S0", "客户说年轻一点，你们当时有没有问他为什么要年轻一点？"),
        seg(3, 845, "S0", "这是一个生意问题，不是一个画风问题。"),
        seg(4, 930, "S2", "那第二版其实方向也不算错？"),
      ],
    },
    {
      recordingId: "rtr_a2",
      partNo: 2,
      segments: [
        seg(1, 20, "S2", "录音刚才断了，接着说。"),
        seg(2, 310, "S0", "堆头是年轻人真正会碰到这个礼盒的地方，不在海报上。"),
      ],
    },
  ],
};

export const CASE_B: RetroSnapshotCase = {
  caseId: "rtc_b",
  number: 3,
  department: "客户部",
  clientName: "茶饮",
  title: "客户一直说要刷屏",
  sceneTags: [],
  background: "",
  outcome: "",
  turningPoints: "",
  discussionQuestions: "",
  rounds: [{ id: "rnd_b1", position: 1, title: "比稿", occurredOn: "", deliveryText: "门店体验", feedbackText: "", responseText: "", links: [] }],
  clientAudio: [],
  recordings: [
    {
      recordingId: "rtr_b1",
      partNo: 1,
      segments: [
        seg(1, 20, "S1", "茶饮这个是新品上市的传播方案。"),
        seg(2, 920, "S0", "客户为什么提刷屏这个要求？你们问过吗？"),
        seg(3, 2050, "S0", "这位客户刚换了市场总监，先别争。"),
      ],
    },
  ],
};

export const CASE_C: RetroSnapshotCase = {
  caseId: "rtc_c",
  number: 4,
  department: "设计部",
  clientName: "文旅",
  title: "古镇导视",
  sceneTags: [],
  background: "",
  outcome: "",
  turningPoints: "",
  discussionQuestions: "",
  rounds: [],
  clientAudio: [],
  recordings: [],
};

export function sampleSnapshot(): RetroGenerateSnapshot {
  return {
    kind: "GENERATE",
    monthKey: "2026-10",
    capturedAt: "2026-10-20T08:00:00.000Z",
    caseNumbers: { rtc_deleted: 1, rtc_a: 2, rtc_b: 3, rtc_c: 4 },
    cases: structuredClone([CASE_A, CASE_B, CASE_C]),
    summaryRecordings: [
      {
        recordingId: "rtr_sum",
        partNo: 1,
        segments: [seg(1, 15, "S0", "今天几个案例，我最后说几句。"), seg(2, 195, "S0", "客户提的要求都先问一句为什么。"), seg(3, 900, "S1", "孙老师，要不要补录？")],
      },
    ],
  };
}

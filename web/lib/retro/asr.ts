// 客户需求复盘库的转写提供方：真实（腾讯云录音文件识别，复用 lib/audio-review/tencent-asr.ts）或本地假实现。
// 点评录音和附件里的客户录音走同一个提供方（docs/26 5.2）。
//
// 选择：RETRO_AI_PROVIDER=fake 走假实现；本机演示模式下没写这个变量时默认就是 fake
// （本机没有 COS，腾讯云也下载不到 localhost 上的录音）；写成其它非空值（如 real）一律走真实。
// fake 不碰网络、不产生费用；真实转写要付费，本机验收不会走到。

import { readAudioReviewConfig } from "@/lib/audio-review/config";
import { createRecTask, describeTaskStatus, type AsrDescribeOutcome, type AsrFetch, type AsrSubmitOutcome } from "@/lib/audio-review/tencent-asr";
import type { AudioReviewTranscriptSegment } from "@/lib/audio-review/transcript";
import { isLocalDemoMode } from "@/lib/local-demo";

export type RetroAiProviderKind = "real" | "fake";
/** 转写的是哪一类录音：案例点评、整场总结、附件里的客户录音（只影响 fake 给哪段文字稿）。 */
export type RetroAsrKind = "REVIEW" | "SUMMARY" | "CLIENT";

type Env = Record<string, string | undefined>;

export function resolveRetroAiProvider(env: Env, localDemo: boolean): RetroAiProviderKind {
  const explicit = (env.RETRO_AI_PROVIDER ?? "").trim().toLowerCase();
  if (explicit === "fake") return "fake";
  if (explicit) return "real";
  return localDemo ? "fake" : "real";
}

export type RetroAsrProvider = {
  kind: RetroAiProviderKind;
  engine: string;
  pollIntervalMs: number;
  submit(input: { audioUrl: string; hotwordList: string; kind: RetroAsrKind }): Promise<AsrSubmitOutcome>;
  describe(taskId: string): Promise<AsrDescribeOutcome>;
};

export const REAL_RETRO_ASR_POLL_INTERVAL_MS = 4_000;

export function createRetroAsrProvider(
  options: { env?: Env; localDemo?: boolean; clock?: () => number; asrFetch?: AsrFetch } = {},
): RetroAsrProvider {
  const env = options.env ?? process.env;
  const kind = resolveRetroAiProvider(env, options.localDemo ?? isLocalDemoMode());
  const clock = options.clock ?? Date.now;
  if (kind === "fake") return createFakeRetroAsr(clock);

  // 与录音点评共用密钥：专用 TENCENT_ASR_* 优先，没配时退回 COS 那一对（见 audio-review/config.ts）。
  const config = readAudioReviewConfig(env, false);
  const credentials = { secretId: config.asr.secretId, secretKey: config.asr.secretKey };
  const configured = Boolean(credentials.secretId && credentials.secretKey);
  const notConfigured = {
    ok: false as const,
    reason: "转写还没有配置好（缺少腾讯云语音识别密钥），请联系管理员。",
    transient: false,
    code: null,
  };
  return {
    kind: "real",
    engine: config.asr.engine,
    pollIntervalMs: REAL_RETRO_ASR_POLL_INTERVAL_MS,
    submit: async ({ audioUrl, hotwordList }) => {
      if (!configured) return notConfigured;
      return createRecTask({ engine: config.asr.engine, audioUrl, hotwordList }, { credentials, fetchImpl: options.asrFetch });
    },
    describe: async (taskId) => {
      if (!configured) return { kind: "FAILED", reason: notConfigured.reason };
      return describeTaskStatus(taskId, { credentials, fetchImpl: options.asrFetch });
    },
  };
}

// ---------------------------------------------------------------------------
// 本地假实现：提交后约 3 秒「完成」（每 1.5 秒查一次，第一次查还在处理中，第二次返回）。
// ---------------------------------------------------------------------------

export const FAKE_RETRO_ASR_ENGINE = "fake-16k_zh_en";
export const FAKE_RETRO_ASR_READY_MS = 3_000;
export const FAKE_RETRO_ASR_POLL_INTERVAL_MS = 1_500;

type FakeLine = [seconds: number, speakerId: string, text: string];

/** 案例点评：S0＝老孙，S1＝汇报人，S2＝其他同事。老孙追问「客户为什么提这个要求」，并分清方法、直觉和只适用本案的判断。 */
const FAKE_REVIEW_LINES: FakeLine[] = [
  [6, "S0", "好，下一个案例。先请汇报人把经过讲一下，三分钟，别念稿。"],
  [14, "S1", "好的。这个是年货节的主视觉，客户一开始给的需求就一句话，要喜庆、要有年味、要比去年更抢眼。"],
  [48, "S1", "我们第一版做了红金配色加传统剪纸元素，客户的反馈是太老气，像十年前的年货海报。"],
  [86, "S1", "第二版我们换成了插画风，色彩更亮，客户又说太幼稚，不像他们的品牌。"],
  [121, "S1", "第三版我们折中，客户这次没说具体哪里不好，只回了一句再想想，然后项目就拖了两周。"],
  [160, "S2", "我插一句，他们这个客户是不是换了市场负责人？"],
  [168, "S1", "对，第二版之后市场部来了新的负责人，之前的对接人只是执行。"],
  [201, "S0", "好，我先问一个问题。第一版客户说老气，你当时问过他为什么这么说吗？"],
  [214, "S1", "没有，我们当时直接按老气去改了，想着往年轻的方向走。"],
  [236, "S0", "这就是问题。客户说一个词的时候，你得先问他是拿什么在比。老气，是跟去年的比，还是跟竞品比，还是他老板说的？你不问清楚，改的方向全是猜。"],
  [291, "S0", "我碰到这种情况，第一件事不是改稿，是先问客户为什么提这个要求。问清楚了，后面两版可能一版就过了。"],
  [338, "S1", "我们后来复盘也觉得，是需求没有挖到底。"],
  [352, "S0", "还有第二版。幼稚这个反馈，其实是在告诉你品牌调性的边界。这个信息很值钱，但你们只当成一次被否，没有记下来。"],
  [405, "S2", "孙老师，那第三版客户不说话，我们应该怎么办？"],
  [414, "S0", "客户不说话，不是没有意见。这种时候别再交新稿，先约一个电话，当面问，不要发微信。"],
  [462, "S0", "这个客户新来的负责人，你要先搞清楚他怕什么。新人上任第一个项目，怕的往往是出错，不是要惊艳。这个是我的判断，不一定对，但你们可以去验证。"],
  [520, "S1", "明白，我们接下来会先约他们负责人单独聊一次。"],
  [548, "S0", "好。改进建议我总结三条。第一，客户给形容词反馈，先追问对比对象。第二，每一版被否之后，把反馈背后的边界写下来，下一版开头先对一遍。第三，客户沉默超过三天，主动约电话。"],
  [640, "S2", "第三条的三天有依据吗，还是经验？"],
  [650, "S0", "经验。我自己的习惯，不是标准，你们根据客户的节奏调整。"],
  [690, "S0", "好，这个案例就到这里，休息五分钟。"],
];
const FAKE_REVIEW_DURATION_MS = 702_000;

/** 客户电话讲需求：S0＝客户，S1＝业务同事。 */
const FAKE_CLIENT_LINES: FakeLine[] = [
  [2, "S0", "喂，你好，我是市场部的，你们那个年货节的方案，我想跟你说下我们的想法。"],
  [10, "S1", "好的，您说，我记一下。"],
  [16, "S0", "今年的年货节我们想比去年更突出，海报要喜庆，一眼就能看到年味。"],
  [31, "S1", "明白，有没有参考的风格或者不想要的东西？"],
  [40, "S0", "不想要太花哨的，去年那个就太花了。预算方面主视觉这块不要超过八万。"],
  [58, "S1", "好，那交稿时间您这边有要求吗？"],
  [64, "S0", "下个月十号之前要定稿，因为要提前备货印刷。"],
  [78, "S1", "好的，那我们月底前给您第一版。"],
  [86, "S0", "可以。另外，我们老板对颜色比较在意，他不太喜欢特别暗的红色。"],
  [101, "S1", "明白，我们会注意，红色偏亮一些。"],
  [112, "S0", "对，大概就这些，有问题我们再联系。"],
  [120, "S1", "好的，谢谢您，再见。"],
];
const FAKE_CLIENT_DURATION_MS = 124_000;

/** 整场总结：S0＝老孙。 */
const FAKE_SUMMARY_LINES: FakeLine[] = [
  [5, "S0", "各位，今天六个案例讲完了，我说几句整体的感受。"],
  [22, "S0", "第一个共同的问题，客户一说反馈，我们就急着改，很少有人先问为什么。"],
  [60, "S0", "第二个，我们做了很多版本，但没有人把每一版被否的原因整理下来，所以同样的坑反复踩。"],
  [105, "S0", "第三，大家汇报的时候讲的是做了什么，很少讲客户当时在想什么。下个月请大家把客户的原话带上。"],
  [150, "S0", "最后，今天提到的几个做法，有的是方法，有的只是我个人的习惯，用的时候自己判断。"],
  [185, "S0", "好，今天就到这里，辛苦大家。"],
];
const FAKE_SUMMARY_DURATION_MS = 192_000;

const FAKE_SOURCES: Record<RetroAsrKind, { lines: FakeLine[]; durationMs: number }> = {
  REVIEW: { lines: FAKE_REVIEW_LINES, durationMs: FAKE_REVIEW_DURATION_MS },
  CLIENT: { lines: FAKE_CLIENT_LINES, durationMs: FAKE_CLIENT_DURATION_MS },
  SUMMARY: { lines: FAKE_SUMMARY_LINES, durationMs: FAKE_SUMMARY_DURATION_MS },
};

export function fakeRetroTranscript(kind: RetroAsrKind): { segments: AudioReviewTranscriptSegment[]; durationMs: number } {
  const { lines, durationMs } = FAKE_SOURCES[kind];
  const segments = lines.map(([seconds, speakerId, text], index) => {
    const next = lines[index + 1];
    const endSeconds = next ? Math.max(seconds + 2, next[0] - 1) : durationMs / 1000 - 2;
    return { id: index + 1, startMs: seconds * 1000, endMs: endSeconds * 1000, speakerId, text };
  });
  return { segments, durationMs };
}

const FAKE_TASK_PATTERN = /^fake-(REVIEW|SUMMARY|CLIENT)-(\d+)$/;

export function createFakeRetroAsr(clock: () => number = Date.now): RetroAsrProvider {
  return {
    kind: "fake",
    engine: FAKE_RETRO_ASR_ENGINE,
    pollIntervalMs: FAKE_RETRO_ASR_POLL_INTERVAL_MS,
    async submit({ kind }): Promise<AsrSubmitOutcome> {
      return { ok: true, taskId: `fake-${kind}-${clock()}`, usedHotwords: true, engine: FAKE_RETRO_ASR_ENGINE };
    },
    async describe(taskId): Promise<AsrDescribeOutcome> {
      const match = FAKE_TASK_PATTERN.exec(taskId);
      if (!match) return { kind: "FAILED", reason: "假转写任务编号无效。" };
      if (clock() - Number(match[2]) < FAKE_RETRO_ASR_READY_MS) return { kind: "PENDING", status: 1 };
      const { segments, durationMs } = fakeRetroTranscript(match[1] as RetroAsrKind);
      return { kind: "SUCCESS", segments, durationMs };
    },
  };
}

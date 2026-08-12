import assert from "node:assert/strict";
import type { AnnotationDraft } from "../lib/types.ts";

const baseUrl = process.env.V03_SMOKE_BASE_URL || "http://localhost:3000";
const targetVideoId =
  process.env.V03_SMOKE_VIDEO_ID ||
  "video_1329aaab-2c5c-40b2-867e-d30abb325cb1";

if (process.env.LOCAL_DEMO_MODE !== "1") {
  throw new Error("V0.3 local verification is allowed only in LOCAL_DEMO_MODE=1.");
}
const parsedBase = new URL(baseUrl);
if (
  parsedBase.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "::1"].includes(parsedBase.hostname)
) {
  throw new Error("V0.3 local verification accepts only an HTTP loopback URL.");
}

const login = await fetch(`${baseUrl}/api/auth/local-demo`, {
  method: "POST",
  redirect: "manual",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: baseUrl,
  },
  body: new URLSearchParams({ profile: "owner", return_to: "/" }),
});
assert.equal(login.status, 303, "local demo login must redirect after success");
const sessionCookie = login.headers.get("set-cookie")?.split(";")[0];
if (!sessionCookie) {
  throw new Error("Local demo login did not issue a session cookie.");
}
const authenticatedCookie: string = sessionCookie;

async function api<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Cookie: authenticatedCookie,
      Origin: baseUrl,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json()) as T & { error?: string };
  assert.ok(response.ok, `${path}: ${payload.error || response.status}`);
  return payload;
}

const videoList = await api<{ videos: Array<{ id: string; title: string }> }>(
  "/api/videos",
);
assert.ok(
  videoList.videos.some((video) => video.id === targetVideoId),
  "the real local demo case must exist",
);

const v02Before = await api<{ annotation: AnnotationDraft }>(
  `/api/videos/${targetVideoId}/annotation?taxonomy=V0.2`,
);
const v02CanonicalBefore = JSON.stringify(v02Before.annotation);
const v03Seed = await api<{
  annotation: AnnotationDraft;
  seededFromV02: boolean;
}>(`/api/videos/${targetVideoId}/annotation?taxonomy=V0.3-PILOT`);
assert.equal(v03Seed.annotation.taxonomyVersion, "V0.3-PILOT");
assert.equal(v03Seed.annotation.workflowVersion, "REVERSE-WORKFLOW-V0.3-PILOT");
assert.ok(v03Seed.annotation.sourceSnapshotId || v03Seed.annotation.id);

const roleByIndex = [
  "建立人物／关系",
  "累积情感",
  "累积情感",
  "推进故事事件",
  "制造偏离／异常",
  "完成情感释放",
  "完成品牌／产品进入",
];
const next: AnnotationDraft = {
  ...v03Seed.annotation,
  shotGroups: (v03Seed.annotation.shotGroups ?? []).map((group, index) => ({
    ...group,
    primaryRole: roleByIndex[index] || "推进故事事件",
    auxiliaryRoles:
      index === 5 ? ["完成视听高潮／兑现"] : [],
    note: group.note || `说明${group.title}对整片创意的作用。`,
  })),
  creativeStructure: {
    ...v03Seed.annotation.creativeStructure!,
    creativeButton:
      "把父亲“接女儿回家”的习惯，从交通功能重新定义为“怕她忘了回家的路”。",
    mechanismStatement:
      "用同一条回家路和同一个父亲背影跨时间重复累积，再以汽车与自行车的对照重释“来接我”。",
    mechanismPrimary: "重复积累",
    mechanismAuxiliary: ["对比冲突", "反转重释"],
    realizationSkeleton:
      "现实电话切入回忆—自行车后座上的成长—女儿开车回家—父亲仍骑车来接—文案完成重释—品牌落点。",
    brandProductLanding:
      "女儿的汽车与父亲的自行车共同进入回家关系，使三菱服务站的“家”不只是口号。",
    storyReferenceType: "家庭亲情／成长陪伴",
    storyArchetype: "回归／成长",
    primaryCreativePath: "LOVE",
    auxiliaryCreativePaths: ["INTERESTING"],
    compositeStateReason:
      "拿掉父女情感累积，结尾重释不再成立；拿掉信息转折，情感仍成立但高潮力量明显减弱。",
    formationPrimary: "CROSS_GROUP_ACCUMULATION",
    formationAuxiliary: ["BEFORE_AFTER_CONTRAST"],
    formationStatement:
      "全片主要靠多个成长桥段累积父亲的“接”；现实中汽车与回忆中自行车的前后对照，负责在结尾把功能差异升华为关系意义。",
    creativeCarriers:
      "父亲的背影、自行车后座、回家路、汽车／自行车对照和点题旁白。",
    establishmentConditions:
      "观众能接受父亲长期接送是关爱习惯，并把回家路理解为归属关系的象征。",
    strengthSources:
      "现实与回忆的剪辑、冷暖色调、克制表演、声画交错和点题文案的集中释放。",
    informationReleaseTurning:
      "原始预期是父亲仍来解决女儿的交通需求；女儿已开车形成偏离；“怕我忘了回家的路”揭示其真正动机，重释全片接送记忆。",
    creativeGrade: "A",
    creativeGradeReason:
      "母题、重复机制、情感释放和品牌的“欢迎回家”高度统一，是有力量的优秀创意。",
    mainPathPayload: {
      emotionalBase: "父女陪伴与归属感。",
      emotionalAccumulation:
        "用不同年龄的自行车后座、冰棒、车站接人和回家路细节逐步累积。",
      emotionalGap:
        "女儿长大离家、工作忙碌，新的汽车似乎使父亲的接送失去了功能。",
      emotionalRelease:
        "父亲仍骑车在前面带路，旁白将“接”重释为“怕她忘了回家的路”。",
      loveMainCarrier: "父亲的背影与跨时间反复出现的回家路。",
    },
    auxiliaryPathNotes: {
      INTERESTING:
        "信息转折将“来接女儿”从功能行为重释为情感关系，增强了高潮；拿掉它后父女陪伴仍成立，但点题力量明显变弱。",
    },
    conditionFlags: {
      unconventionalWorld: false,
      audiovisualCarriesIdea: false,
      interestingLoadBearing: true,
    },
  },
};

const saved = await api<{ revision: number; annotationId: string }>(
  `/api/videos/${targetVideoId}/annotation?taxonomy=V0.3-PILOT`,
  { method: "PUT", body: JSON.stringify(next) },
);
assert.ok(saved.annotationId);
assert.ok(saved.revision > v03Seed.annotation.revision);

const published = await api<{ snapshotId: string; versionNumber: number }>(
  `/api/videos/${targetVideoId}/annotation/submit?taxonomy=V0.3-PILOT`,
  { method: "POST" },
);
assert.ok(published.snapshotId);
assert.ok(published.versionNumber >= 1);

const v02After = await api<{ annotation: AnnotationDraft }>(
  `/api/videos/${targetVideoId}/annotation?taxonomy=V0.2`,
);
assert.equal(JSON.stringify(v02After.annotation), v02CanonicalBefore);

const detail = await api<{
  analyses: Array<{ id: string; taxonomyVersion: string }>;
}>(`/api/videos/${targetVideoId}`);
assert.ok(
  detail.analyses.some(
    (analysis) =>
      analysis.id === published.snapshotId &&
      analysis.taxonomyVersion === "V0.3-PILOT",
  ),
);

console.log(
  JSON.stringify(
    {
      ok: true,
      videoId: targetVideoId,
      v03AnnotationId: saved.annotationId,
      v03SnapshotId: published.snapshotId,
      v03PublicVersion: published.versionNumber,
      v02Unchanged: true,
    },
    null,
    2,
  ),
);

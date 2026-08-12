import assert from "node:assert/strict";
import type { AnnotationDraft, ApprovedAnalysisRelease } from "../lib/types.ts";

const baseUrl = process.env.V031_SMOKE_BASE_URL || "http://localhost:3000";
const videoId = process.env.V031_SMOKE_VIDEO_ID || "video_1329aaab-2c5c-40b2-867e-d30abb325cb1";
if (process.env.LOCAL_DEMO_MODE !== "1") throw new Error("V0.3.1 verification is local-demo only.");
const parsedBase = new URL(baseUrl);
assert.equal(parsedBase.protocol, "http:");
assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsedBase.hostname));

async function login(profile: "owner" | "reviewer") {
  const response = await fetch(`${baseUrl}/api/auth/local-demo`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: baseUrl },
    body: new URLSearchParams({ profile, return_to: "/" }),
  });
  assert.equal(response.status, 303);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Local demo login did not issue a cookie.");
  return cookie;
}

const ownerCookie = await login("owner");
const reviewerCookie = await login("reviewer");

async function api<T>(path: string, init: RequestInit = {}, cookie = ownerCookie) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Cookie: cookie,
      Origin: baseUrl,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json()) as T & { error?: string };
  assert.ok(response.ok, `${path}: ${payload.error || response.status}`);
  return payload;
}

async function detail() {
  return api<{
    analyses: Array<{ id: string; taxonomyVersion: string; payload: AnnotationDraft }>;
    approvedStandards: ApprovedAnalysisRelease[];
  }>(`/api/videos/${videoId}`);
}

const before = await detail();
const initialReleaseNumber = before.approvedStandards[0]?.releaseNumber ?? 0;
const baseAnalysis = before.analyses.find((analysis) => analysis.taxonomyVersion === "V0.3-PILOT");
assert.ok(baseAnalysis, "a submitted V0.3 case is required");
const baseSnapshotId = baseAnalysis.id;
await api(`/api/analyses/${baseSnapshotId}/review`);

const commercial = baseAnalysis.payload.commercialIntent;
const commercialReplacement = commercial.endsWith("品牌与归属感的连接。")
  ? `${commercial.replace(/，并强化品牌与归属感的连接。$/, "")}，并让品牌与归属感的连接更清晰。`
  : `${commercial.replace(/，并让品牌与归属感的连接更清晰。$/, "").replace(/[。.]$/, "")}，并强化品牌与归属感的连接。`;
const revision = await api<{ suggestionId: string }>(
  `/api/analyses/${baseSnapshotId}/suggestions`,
  {
    method: "POST",
    body: JSON.stringify({
      targetKey: "core:commercial-intent",
      targetLabel: "商业意图",
      selectedText: commercial,
      anchorStart: 0,
      anchorEnd: commercial.length,
      replacementText: commercialReplacement,
      reason: "",
    }),
  },
);
assert.ok(revision.suggestionId);

const quote = baseAnalysis.payload.synopsis.slice(0, Math.min(4, baseAnalysis.payload.synopsis.length));
const comment = await api<{ commentId: string }>(
  `/api/analyses/${baseSnapshotId}/comments`,
  {
    method: "POST",
    body: JSON.stringify({
      targetKey: "core:story-synopsis",
      targetLabel: "故事梗概",
      selectedText: quote,
      anchorStart: 0,
      anchorEnd: quote.length,
      body: "请补足人物关系变化与结局，不要在梗概中先评价创意。",
      kind: "EXPERT_NOTE",
    }),
  },
);

const immutable = await api<{ analysis: { payload: AnnotationDraft } }>(`/api/analyses/${baseSnapshotId}`);
assert.equal(immutable.analysis.payload.commercialIntent, commercial, "review traces must not change the submitted snapshot");

await api(`/api/analyses/${baseSnapshotId}/review`, {
  method: "PATCH",
  body: JSON.stringify({ action: "RETURN", decisionNote: "补足梗概后复审。" }),
});
const returned = await api<{ annotation: AnnotationDraft }>(
  `/api/videos/${videoId}/annotation?taxonomy=V0.3-PILOT`,
);
assert.equal(returned.annotation.reviewStatus, "CHANGES_REQUESTED");
assert.equal(returned.annotation.commercialIntent, commercialReplacement);
const synopsisSuffix = "人物关系变化与结局已补充完整。";
const authorDraft = {
  ...returned.annotation,
  synopsis: returned.annotation.synopsis.includes(synopsisSuffix)
    ? returned.annotation.synopsis
    : `${returned.annotation.synopsis.replace(/[。.]$/, "")}；${synopsisSuffix}`,
};
await api(`/api/videos/${videoId}/annotation?taxonomy=V0.3-PILOT`, {
  method: "PUT",
  body: JSON.stringify(authorDraft),
});
await api(`/api/analyses/${baseSnapshotId}/comments/${comment.commentId}`, {
  method: "PATCH",
  body: JSON.stringify({ status: "AUTHOR_MARKED_HANDLED" }),
});
const resubmitted = await api<{ snapshotId: string }>(
  `/api/videos/${videoId}/annotation/submit?taxonomy=V0.3-PILOT`,
  { method: "POST" },
);
const commentState = await api<{ comments: Array<{ id: string; status: string }> }>(
  `/api/analyses/${resubmitted.snapshotId}/comments`,
);
for (const pendingComment of commentState.comments.filter((item) => item.status !== "RESOLVED")) {
  await api(`/api/analyses/${resubmitted.snapshotId}/comments/${pendingComment.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "RESOLVED" }),
  });
}
const approvedR1 = await api<{ releaseNumber: number; approvedSnapshotId: string }>(
  `/api/analyses/${resubmitted.snapshotId}/review`,
  {
    method: "PATCH",
    body: JSON.stringify({ action: "APPROVE", expertCreativeGrade: "A" }),
  },
);
assert.equal(approvedR1.releaseNumber, initialReleaseNumber + 1);
let afterApproval = await detail();
assert.equal(afterApproval.approvedStandards[0]?.releaseNumber, initialReleaseNumber + 1);
assert.equal(afterApproval.approvedStandards[0]?.payload.commercialIntent, commercialReplacement);
assert.doesNotMatch(JSON.stringify(afterApproval.approvedStandards[0]?.payload), /终审.*修订为|\[.*原因：/);

const nonFinalAttempt = await fetch(`${baseUrl}/api/analyses/${resubmitted.snapshotId}/suggestions`, {
  method: "POST",
  headers: { Cookie: reviewerCookie, Origin: baseUrl, "Content-Type": "application/json" },
  body: JSON.stringify({
    targetKey: "core:commercial-intent",
    targetLabel: "商业意图",
    selectedText: commercialReplacement,
    anchorStart: 0,
    anchorEnd: commercialReplacement.length,
    replacementText: "无权限修改",
  }),
});
assert.equal(nonFinalAttempt.status, 403);

const r2Base = await api<{ annotation: AnnotationDraft }>(
  `/api/videos/${videoId}/annotation?taxonomy=V0.3-PILOT`,
);
const r2Strength = r2Base.annotation.creativeStructure!.strengthSources.includes("信息次序")
  ? r2Base.annotation.creativeStructure!.strengthSources
  : `${r2Base.annotation.creativeStructure!.strengthSources.replace(/[。.]$/, "")}，并由信息次序控制最终释放。`;
await api(`/api/videos/${videoId}/annotation?taxonomy=V0.3-PILOT`, {
  method: "PUT",
  body: JSON.stringify({
    ...r2Base.annotation,
    creativeStructure: { ...r2Base.annotation.creativeStructure!, strengthSources: r2Strength },
  }),
});
const r2Submitted = await api<{ snapshotId: string }>(
  `/api/videos/${videoId}/annotation/submit?taxonomy=V0.3-PILOT`,
  { method: "POST" },
);
afterApproval = await detail();
assert.equal(afterApproval.approvedStandards[0]?.releaseNumber, initialReleaseNumber + 1, "the previous release stays active while the next is under review");
const approvedR2 = await api<{ releaseNumber: number }>(
  `/api/analyses/${r2Submitted.snapshotId}/review`,
  { method: "PATCH", body: JSON.stringify({ action: "APPROVE", expertCreativeGrade: "A" }) },
);
assert.equal(approvedR2.releaseNumber, initialReleaseNumber + 2);
const finalDetail = await detail();
assert.equal(finalDetail.approvedStandards[0]?.releaseNumber, initialReleaseNumber + 2);

console.log(JSON.stringify({
  ok: true,
  videoId,
  returnedAndResubmitted: true,
  immutableBaseSnapshot: true,
  nonFinalReviewerBlocked: true,
  activeRelease: `R${initialReleaseNumber + 2}`,
}, null, 2));

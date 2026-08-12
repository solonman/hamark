import assert from "node:assert/strict";
import type {
  AnalysisReviewContext,
  AnalysisRevisionSuggestion,
  AnnotationDraft,
  ApprovedAnalysisRelease,
} from "../lib/types.ts";

const baseUrl = process.env.V032_SMOKE_BASE_URL || "http://localhost:3000";
const videoId = process.env.V032_SMOKE_VIDEO_ID || "video_1329aaab-2c5c-40b2-867e-d30abb325cb1";
if (process.env.LOCAL_DEMO_MODE !== "1") throw new Error("V0.3.2 verification is local-demo only.");
const parsedBase = new URL(baseUrl);
assert.equal(parsedBase.protocol, "http:");
assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsedBase.hostname));

const login = await fetch(`${baseUrl}/api/auth/local-demo`, {
  method: "POST",
  redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: baseUrl },
  body: new URLSearchParams({ profile: "owner", return_to: "/" }),
});
assert.equal(login.status, 303);
const cookie = login.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie);

async function api<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Cookie: cookie!,
      Origin: baseUrl,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = (await response.json()) as T & { error?: string };
  assert.ok(response.ok, `${path}: ${body.error || response.status}`);
  return body;
}

const detail = await api<{
  analyses: Array<{ id: string; taxonomyVersion: string; payload: AnnotationDraft }>;
  approvedStandards: ApprovedAnalysisRelease[];
}>(`/api/videos/${videoId}`);
const analysis = detail.analyses.find((item) => item.taxonomyVersion === "V0.3-PILOT");
assert.ok(analysis);
const original = analysis.payload.creativeStructure!.mechanismPrimary;
const replacement = original === "隐喻转译" ? "重复变义" : "隐喻转译";

const revision = await api<{ suggestionId: string }>(
  `/api/analyses/${analysis.id}/suggestions`,
  {
    method: "POST",
    body: JSON.stringify({
      targetKey: "structure:mechanism-primary",
      targetLabel: "机制主归类",
      valueType: "SINGLE_SELECT",
      originalValue: original,
      replacementValue: replacement,
      reason: "验证选择型字段按结构化值修订。",
    }),
  },
);
assert.ok(revision.suggestionId);
const workLayer = await api<{ suggestions: AnalysisRevisionSuggestion[] }>(
  `/api/analyses/${analysis.id}/suggestions`,
);
const stored = workLayer.suggestions.find((item) => item.id === revision.suggestionId);
assert.equal(stored?.valueType, "SINGLE_SELECT");
assert.equal(stored?.originalValue, original);
assert.equal(stored?.replacementValue, replacement);

const immutable = await api<{ analysis: { payload: AnnotationDraft } }>(`/api/analyses/${analysis.id}`);
assert.equal(immutable.analysis.payload.creativeStructure!.mechanismPrimary, original);

const approved = await api<{ releaseNumber: number }>(`/api/analyses/${analysis.id}/review`, {
  method: "PATCH",
  body: JSON.stringify({ action: "APPROVE", expertCreativeGrade: "A" }),
});
const finalDetail = await api<{ approvedStandards: ApprovedAnalysisRelease[] }>(`/api/videos/${videoId}`);
assert.equal(finalDetail.approvedStandards[0]?.releaseNumber, approved.releaseNumber);
assert.equal(finalDetail.approvedStandards[0]?.payload.creativeStructure!.mechanismPrimary, replacement);
assert.doesNotMatch(JSON.stringify(finalDetail.approvedStandards[0]?.payload), /终审修订为/);
const completedReview = await api<{ review: AnalysisReviewContext }>(
  `/api/analyses/${analysis.id}/review`,
);
assert.equal(completedReview.review.canReview, false);
assert.equal(completedReview.review.canApprove, false);

console.log(JSON.stringify({
  ok: true,
  videoId,
  structuredTarget: "structure:mechanism-primary",
  from: original,
  to: replacement,
  immutableBaseSnapshot: true,
  completedReviewReadOnly: true,
  activeRelease: `R${approved.releaseNumber}`,
}, null, 2));

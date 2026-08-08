import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("source contains the RE:VERSE library and worksheet flows", async () => {
  const [
    home,
    practice,
    detail,
    shotTable,
    taxonomyEditor,
    reviewPanel,
    reviewRubric,
    comments,
    styles,
    layout,
  ] =
    await Promise.all([
      readFile(
        new URL("../app/components/HomeClient.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../app/videos/[id]/practice/PracticeClient.tsx",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../app/videos/[id]/VideoDetailClient.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/components/ResizableShotTable.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../app/videos/[id]/practice/TaxonomyFieldEditor.tsx",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../app/videos/[id]/ReviewPanel.tsx", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../lib/review-rubric.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../app/videos/[id]/AnalysisComments.tsx", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    ]);

  assert.match(home, /看完一支片/);
  assert.match(home, /把创意重新拆开/);
  assert.match(home, /上传作品/);
  assert.match(home, /标注体系 V0\.2/);
  assert.match(practice, /逐镜脚本还原/);
  assert.match(shotTable, /镜头组序号／名称/);
  assert.match(shotTable, /创意点评／标注依据/);
  assert.match(practice, /创意构成 9 项/);
  assert.match(practice, /故事组织 10 项/);
  assert.match(taxonomyEditor, /V0\.2 预设选项/);
  assert.match(taxonomyEditor, /其他（自主输入）/);
  assert.match(practice, /修改约3秒自动保存/);
  assert.match(practice, /发布公开版本/);
  assert.match(practice, /对照视频 · 始终悬浮/);
  assert.match(shotTable, /拖动表头边界调整列宽/);
  assert.match(shotTable, /恢复默认列宽/);
  assert.match(detail, /原位批改 · 100分/);
  assert.match(detail, /替换原视频/);
  assert.match(detail, /对照视频 · 随页面悬浮/);
  assert.match(reviewPanel, /提交正式评分/);
  assert.match(reviewRubric, /RUBRIC-V0\.4/);
  assert.match(reviewRubric, /镜头组分段与顺序/);
  assert.match(reviewPanel, /参照项/);
  assert.match(reviewPanel, /taxonomy-reference-dock/);
  assert.match(comments, /InlineAnnotationText/);
  assert.match(comments, /data-inline-annotation-target/);
  assert.match(comments, /inline-text-mark/);
  assert.match(comments, /提交修订建议/);
  assert.match(comments, /接受并写入草稿/);
  assert.match(comments, /专家精修意见/);
  assert.match(comments, /标记优秀/);
  assert.doesNotMatch(comments, /开启批注模式/);
  assert.match(styles, /\.inline-annotation-entry-actions/);
  assert.match(styles, /\.inline-text-mark/);
  assert.match(styles, /\.inline-annotation-popover/);
  assert.match(layout, /GlobalHomeButton/);
  assert.doesNotMatch(home, /Your site is taking shape|Starter Project/);
  assert.doesNotMatch(home, /react-loading-skeleton/);
});

test("home renders authenticated user controls and handles logout securely", async () => {
  const [page, home, userMenu] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/HomeClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/UserMenu.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /displayName: user\.displayName/);
  assert.match(home, /<UserMenu user=\{user\}/);
  assert.match(
    home,
    /<nav className="header-actions"[\s\S]*上传作品[\s\S]*<UserMenu user=\{user\} \/>[\s\S]*<\/nav>/,
  );
  assert.ok(userMenu.includes('fetch("/api/auth/logout", { method: "POST" })'));
  assert.doesNotMatch(userMenu, /href=["']\/api\/auth\/logout/);
});

test("client mutations redirect to login on unauthorized business API responses", async () => {
  const [upload, detail, practice, review] = await Promise.all([
    readFile(new URL("../app/components/UploadDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/VideoDetailClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/practice/PracticeClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/ReviewPanel.tsx", import.meta.url), "utf8"),
  ]);

  for (const source of [upload, detail, practice, review]) {
    assert.match(source, /redirectOnUnauthorized\(/);
  }
});

test("home keeps the current screen when its background library request is unauthorized", async () => {
  const home = await readFile(new URL("../app/components/HomeClient.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(home, /if \(redirectOnUnauthorized\(response\)\) return;/);
  assert.match(home, /登录状态已失效/);
});

test("video uploads go directly to COS and are completed through a small API request", async () => {
  const [upload, createRoute, completeRoute] = await Promise.all([
    readFile(new URL("../app/components/UploadDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/[id]/complete/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(createRoute, /createPresignedPutUrl/);
  assert.match(upload, /data\.uploadUrl/);
  assert.match(createRoute, /thumbnail_key/);
  assert.match(createRoute, /thumbnailUploadUrl/);
  assert.match(createRoute, /image\/jpeg/);
  assert.match(upload, /createThumbnailFromVideoFile/);
  assert.match(upload, /data\.thumbnailUploadUrl/);
  assert.match(upload, /Promise\.all/);
  assert.match(upload, /\/api\/videos\/\$\{data\.videoId\}\/complete/);
  assert.doesNotMatch(upload, /\/api\/videos\/\$\{data\.videoId\}\/content/);
  assert.match(completeRoute, /const bucket = getVideoBucket\(\)/);
  assert.match(completeRoute, /bucket\.head\(video\.object_key\)/);
  assert.match(completeRoute, /thumbnail_key/);
  assert.match(completeRoute, /thumbnailObject/);
  assert.match(completeRoute, /created_by_email !== user\.identityKey/);
  assert.match(completeRoute, /status = 'READY'/);
});

test("video thumbnail generation skips black frames with simple multi-point sampling", async () => {
  const thumbnail = await readFile(
    new URL("../app/components/video-thumbnail.ts", import.meta.url),
    "utf8",
  );

  assert.match(thumbnail, /function thumbnailCandidateTimes/);
  assert.match(thumbnail, /function isLikelyBlackFrame/);
  assert.match(thumbnail, /brightnessTotal/);
  assert.match(thumbnail, /brightPixels/);
  assert.match(thumbnail, /captureCanvasAtTime/);
  assert.match(thumbnail, /for \(const captureTime of thumbnailCandidateTimes\(duration\)\)/);
  assert.match(thumbnail, /fallbackCanvas/);
});

test("video playback uses signed COS URLs while the library renders only thumbnails", async () => {
  const [home, detail, listRoute, replaceCompleteRoute] = await Promise.all([
    readFile(new URL("../app/components/HomeClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/VideoDetailClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/[id]/replace/complete/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(detail, /src=\{video\.playbackUrl\}/);
  assert.match(listRoute, /thumbnailUrl/);
  assert.match(listRoute, /createPresignedGetUrl\(row\.thumbnail_key/);
  assert.match(replaceCompleteRoute, /createPresignedGetUrl\(replacementKey/);
  assert.match(home, /src=\{video\.thumbnailUrl\}/);
  assert.match(home, /loading="lazy"/);
  assert.doesNotMatch(home, /\/api\/videos\/\$\{video\.id\}\/stream/);
  assert.doesNotMatch(home, /<video/);
  assert.doesNotMatch(home, /preload="metadata"/);
});

test("replacing an original video never streams the file through a serverless function", async () => {
  const [startRoute, completeRoute, dialog] = await Promise.all([
    readFile(new URL("../app/api/videos/[id]/replace/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/[id]/replace/complete/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/ReplaceVideoDialog.tsx", import.meta.url), "utf8"),
  ]);

  // The old flow PUT the whole file at the API route and died on the platform body limit.
  assert.doesNotMatch(startRoute, /export async function PUT/);
  assert.doesNotMatch(startRoute, /request\.body/);
  assert.doesNotMatch(completeRoute, /request\.body/);
  assert.doesNotMatch(startRoute, /bucket\.put\(/);
  assert.doesNotMatch(completeRoute, /bucket\.put\(/);

  // Both the file and its cover go straight to COS with presigned URLs.
  assert.match(startRoute, /createPresignedPutUrl\(replacementObjectKey\(id, assetId\)/);
  assert.match(startRoute, /createPresignedPutUrl\(replacementThumbnailKey\(id, assetId\)/);
  assert.match(dialog, /uploadToStorage\(started\.uploadUrl, file/);
  assert.match(dialog, /uploadToStorage\(\s*started\.thumbnailUploadUrl/s);
  assert.match(dialog, /createThumbnailFromVideoFile\(file\)/);
  assert.match(dialog, /`\/api\/videos\/\$\{videoId\}\/replace\/complete`/);

  // The swap is confirmed server-side against the objects that actually landed.
  assert.match(completeRoute, /bucket\.head\(replacementKey\)/);
  assert.match(completeRoute, /bucket\.head\(replacementThumbnail\)/);
  assert.match(completeRoute, /VIDEO_ORIGINAL_REPLACED/);
  assert.match(completeRoute, /SET object_key = \?, thumbnail_key = \?/);
});

test("replacement object keys are rebuilt from an opaque asset id", async () => {
  const {
    isReplacementAssetId,
    replacementObjectKey,
    replacementThumbnailKey,
  } = await import("../lib/video-replacement.ts");

  const assetId = "asset_11111111-2222-4333-8444-555555555555";
  assert.equal(isReplacementAssetId(assetId), true);
  assert.equal(
    replacementObjectKey("video_abc", assetId),
    `videos/video_abc/replacements/${assetId}`,
  );
  assert.equal(
    replacementThumbnailKey("video_abc", assetId),
    `videos/video_abc/replacements/${assetId}-thumbnail.jpg`,
  );

  // A client must not be able to steer the swap at an unrelated object.
  assert.equal(isReplacementAssetId("../../original"), false);
  assert.equal(isReplacementAssetId("asset_../../../original"), false);
  assert.equal(isReplacementAssetId("videos/other/original"), false);
  assert.equal(isReplacementAssetId(""), false);
  assert.equal(isReplacementAssetId(undefined), false);
});

test("video detail API returns current user's analysis status", async () => {
  const source = await readFile(
    new URL("../app/api/videos/[id]/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /WHERE video_id = \? AND author_email = \? AND deleted_at IS NULL/,
  );
  assert.match(source, /\.bind\(id, user\.identityKey\)/);
  assert.match(source, /myAnalysis:/);
});

test("video detail client labels my analysis CTA by status", async () => {
  const source = await readFile(
    new URL("../app/videos/[id]/VideoDetailClient.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /myAnalysis/);
  assert.match(source, /继续编辑我的分析 ↗/);
  assert.match(source, /继续修订我的作业 ↗/);
  assert.match(source, /写下我的分析 ↗/);
});

test("video management dialogs use protected edit and delete mutations", async () => {
  const [editDialog, deleteDialog] = await Promise.all([
    readFile(new URL("../app/videos/[id]/EditVideoDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/DeleteVideoDialog.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(editDialog, /method: "PATCH"/);
  assert.match(editDialog, /编辑作品信息/);
  assert.match(deleteDialog, /method: "DELETE"/);
  assert.match(deleteDialog, /永久删除后无法恢复/);
});

test("video detail exposes management controls only from server-provided permissions", async () => {
  const detail = await readFile(
    new URL("../app/videos/[id]/VideoDetailClient.tsx", import.meta.url),
    "utf8",
  );

  assert.match(detail, /canManage/);
  assert.match(detail, /canDeletePermanently/);
  assert.match(detail, /编辑信息/);
  assert.match(detail, /永久删除/);
  assert.match(detail, /<EditVideoDialog/);
  assert.match(detail, /<DeleteVideoDialog/);
  assert.match(detail, /window\.location\.assign\("\/"\)/);
});

test("shot autosave resets its debounce window for every edit", async () => {
  const practice = await readFile(
    new URL("../app/videos/[id]/practice/PracticeClient.tsx", import.meta.url),
    "utf8",
  );

  assert.match(practice, /const \[editVersion, setEditVersion\] = useState\(0\)/);
  assert.match(practice, /setEditVersion\(editSequence\.current\)/);
  assert.match(practice, /window\.setTimeout\(\(\) => \{\s*void saveDraft\(\);\s*\}, 2500\)/s);
  assert.match(practice, /\[conflict, dirty, editVersion, saveDraft, saveState\]/);
  assert.match(practice, /修改约3秒自动保存/);
});

test("shot autosave serializes requests and retains newer draft content", async () => {
  const practice = await readFile(
    new URL("../app/videos/[id]/practice/PracticeClient.tsx", import.meta.url),
    "utf8",
  );

  assert.match(practice, /const saveInFlight = useRef<Promise<AnnotationDraft \| null> \| null>\(null\)/);
  assert.match(practice, /if \(saveInFlight\.current\) return saveInFlight\.current;/);
  assert.match(practice, /const latest = draftRef\.current/);
  assert.match(practice, /draftRef\.current = merged;/);
  assert.match(practice, /if \(editSequence\.current === sequenceAtStart\)/);
});

test("shot group names stay local while typing before updating the full table", async () => {
  const editor = await readFile(
    new URL("../app/videos/[id]/practice/ShotGroupEditor.tsx", import.meta.url),
    "utf8",
  );

  assert.match(editor, /function DeferredGroupNameInput/);
  assert.match(editor, /window\.setTimeout\(\(\) => commitRef\.current\(value\), 600\)/);
  assert.match(editor, /if \(value !== committedValue\) onCommit\(value\);/);
  // 新镜头必须带真实存储组名，兜底显示名会把它裂进相邻的幽灵组。
  assert.match(editor, /createShot\(insertionIndex, group\.rawName\)/);
  assert.match(editor, /placeholder=\{group\.name\}/);
});

test("V0.2 taxonomy preserves all appendix fields and preset values", async () => {
  const taxonomy = JSON.parse(
    await readFile(new URL("../lib/taxonomy-v0.2.json", import.meta.url), "utf8"),
  );

  assert.deepEqual(
    taxonomy.map((field) => field.code),
    [
      "A1",
      "A2",
      "A3",
      "A4",
      "A5",
      "A6",
      "A7",
      "A8",
      "A9",
      "B1",
      "B2",
      "B3",
      "B4",
      "B5",
      "B6",
      "B7",
      "B8",
      "B9",
      "B10",
    ],
  );
  assert.equal(
    taxonomy.reduce((total, field) => total + field.options.length, 0),
    196,
  );
  assert.equal(taxonomy[0].options[0].value, "有爱");
  assert.equal(
    taxonomy.find((field) => field.code === "A2").options.at(-1).value,
    "其他（自定义机制）",
  );
  assert.equal(
    taxonomy.find((field) => field.code === "B10").options.at(-1).value,
    "行动号召",
  );
});

test("social preview asset is a 1200 by 630 PNG", async () => {
  const png = await readFile(new URL("../public/og.png", import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

// 录音点评改写 B1：版本链里排除点评版的每一处、点评版的保存、集成版采纳点评版写法、
// 外部 Agent 接口。见 docs/25_录音点评改写_实施规格_V0.1.md 三、3.3 / 五 / 六 / 八，
// 以及十、验收清单第 2 条（3.3 表每一处都有测试）。
//
// 数据库函数用脚本化的假 db 驱动：每条 SQL 按正则路由到一个处理函数，没有匹配的 SQL 直接
// 抛错——所以 SQL 文本本身（例如 `version_kind = 'PERSONAL'`）就是断言的一部分，绑定值另行
// 断言。路由只读源码断言（导入路由模块会在加载时拉起 @/db 连接池）。

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { DbClient } from "../db/index.ts";
import {
  adoptFinalReviewCandidates,
  computeV19ReviewCandidates,
  ensureFinalVersion,
  loadFinalTrace,
  loadFinalVersion,
  type FinalReviewSource,
} from "../lib/final-version.ts";
import {
  createV19VersionFrom,
  formatV19VersionLabel,
  loadV19VersionChain,
  pickV19ActorVersion,
  resolveV19DefaultVersion,
  saveV19VersionChanges,
  toSummary,
  type AnalysisVersionRow,
  type WorkspaceRow,
} from "../lib/v19-version-chain.ts";
import { formatV19VersionLabel as formatV19VersionLabelClient } from "../lib/v19-ui-model.ts";
import {
  caseReviewVersionLabel,
  loadCaseReview,
  saveCaseReviewComment,
  saveCaseReviewRating,
} from "../lib/case-review-server.ts";
import { loadCaseEngagement } from "../lib/case-engagement-server.ts";
import { loadV04CaseCardsReadModel } from "../lib/v04-read-models.ts";
import {
  agentVersionSummary,
  getAgentVideoAnalysis,
  listAgentVideos,
  loadAgentReviewDigests,
} from "../lib/agent-api/video-read.ts";
import { buildAgentGuideMarkdown } from "../lib/agent-api/guide.ts";
import { emptyV04ChoiceValue, emptyV04DraftPayload, hashV04Payload } from "../lib/v04-domain.ts";
import {
  V04_PAYLOAD_SCHEMA_VERSION,
  V04_TAXONOMY_VERSION,
  V04_VOCABULARY_VERSION,
  V04_WORKFLOW_VERSION,
  type V04Change,
  type V04DraftPayloadV1,
  type V04ShotGroupPayload,
  type V04ShotPayload,
} from "../lib/v04-contract.ts";
import type { V04Actor } from "../lib/v04-workspace-service.ts";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const codeOnly = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-10T08:00:00.000Z");

function actor(userId: string, displayName: string): V04Actor {
  return { userId, identityKey: `${userId}@example.test`, displayName, sessionId: "session", requestId: "request" };
}

const LAOSUN = actor("user_laosun", "老孙");
const LIU = actor("user_liu", "刘梦娜");
const ZHAO = actor("user_zhao", "赵雅诗");

function shot(id: string, orderIndex: number, overrides: Partial<V04ShotPayload> = {}): V04ShotPayload {
  return {
    id, orderIndex,
    startTime: "00:00", endTime: "00:02", shotScale: "", cameraAngle: "", cameraMovement: "",
    visualContent: "", screenCopy: "", subtitleEffect: "", dialogue: "", voiceOver: "",
    soundEffect: "", music: "",
    ...overrides,
  };
}

function group(id: string, orderIndex: number, shots: V04ShotPayload[], overrides: Partial<V04ShotGroupPayload> = {}): V04ShotGroupPayload {
  return {
    id, orderIndex, bridgeName: `桥段${orderIndex + 1}`,
    primaryCreativeRole: emptyV04ChoiceValue(),
    auxiliaryCreativeRole: emptyV04ChoiceValue(),
    keyCreativeDescription: "",
    shots,
    ...overrides,
  };
}

/** 刘梦娜 v1 的作业：一个桥段两个镜头，母题写成「捉迷藏」。 */
function homework(): V04DraftPayloadV1 {
  const empty = emptyV04DraftPayload();
  return {
    ...empty,
    script: {
      shotGroups: [group("g1", 0, [
        shot("s1", 0, { visualContent: "孩子躲进井盖" }),
        shot("s2", 1, { visualContent: "大人四处找" }),
      ], { keyCreativeDescription: "复述画面" })],
    },
    factsAndCoreJudgement: { ...empty.factsAndCoreJudgement, creativeMotif: "捉迷藏", ratingReason: "节奏好" },
  };
}

function edit(payload: V04DraftPayloadV1, mutate: (draft: V04DraftPayloadV1) => void): V04DraftPayloadV1 {
  const next = structuredClone(payload);
  mutate(next);
  return next;
}

function versionRow(overrides: Partial<AnalysisVersionRow> & Pick<AnalysisVersionRow, "id" | "version_number" | "owner_user_id">): AnalysisVersionRow {
  const row: AnalysisVersionRow = {
    workspace_id: "ws1",
    video_id: "video1",
    owner_name_snapshot: "",
    base_version_id: null,
    base_version_number: null,
    base_payload_json: null,
    base_captured_at: null,
    payload_json: homework(),
    content_hash: "",
    revision: 1,
    taxonomy_version: V04_TAXONOMY_VERSION,
    workflow_version: V04_WORKFLOW_VERSION,
    vocabulary_version: V04_VOCABULARY_VERSION,
    payload_schema_version: V04_PAYLOAD_SCHEMA_VERSION,
    base_is_final: false,
    version_kind: "PERSONAL",
    audio_review_id: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
  if (!overrides.content_hash) row.content_hash = hashV04Payload(row.payload_json as V04DraftPayloadV1);
  return row;
}

/** 老孙对刘梦娜 v1 的点评版 v3：母题改成「躲藏与寻回」，镜头 s1 补了画面信息。 */
function reviewPayload() {
  return edit(homework(), (draft) => {
    draft.factsAndCoreJudgement.creativeMotif = "躲藏与寻回";
    draft.script.shotGroups[0].shots[0].visualContent = "井盖里钻出来的是警察";
  });
}

const WORKSPACE: WorkspaceRow = {
  id: "ws1",
  video_id: "video1",
  canonical_annotation_id: "annotation1",
  active_round_id: "round1",
  current_working_snapshot_id: null,
  created_by_user_id: LIU.userId,
  status: "ACTIVE",
  updated_at: "2026-10-01T00:00:00.000Z",
};

type FinalRow = {
  id: string; workspace_id: string; video_id: string; status: "OPEN" | "DONE";
  done_at: string | null; done_by_user_id: string | null; done_by_name: string | null;
  origin_payload_json: V04DraftPayloadV1; payload_json: V04DraftPayloadV1;
  content_hash: string; revision: number; created_at: string; updated_at: string;
};

function finalRow(payload: V04DraftPayloadV1, overrides: Partial<FinalRow> = {}): FinalRow {
  return {
    id: "final1", workspace_id: "ws1", video_id: "video1", status: "OPEN",
    done_at: null, done_by_user_id: null, done_by_name: null,
    origin_payload_json: homework(), payload_json: payload, content_hash: hashV04Payload(payload),
    revision: 4, created_at: "2026-10-02T00:00:00.000Z", updated_at: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scripted fake db
// ---------------------------------------------------------------------------

type Call = { sql: string; values: unknown[]; method: "first" | "all" | "run" };
type Handler = {
  match: RegExp;
  first?: (values: unknown[]) => unknown;
  all?: (values: unknown[]) => unknown[];
  run?: (values: unknown[]) => void;
};

function scriptedDb(handlers: Handler[], options: { permissive?: boolean } = {}) {
  const calls: Call[] = [];
  const route = (sql: string, method: Call["method"]) => {
    const handler = handlers.find((item) => item.match.test(sql));
    if (!handler && !options.permissive) throw new Error(`unexpected ${method}: ${sql}`);
    return handler;
  };
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first() {
          calls.push({ sql, values, method: "first" });
          return (route(sql, "first")?.first?.(values) ?? null);
        },
        async all() {
          calls.push({ sql, values, method: "all" });
          return { results: route(sql, "all")?.all?.(values) ?? [] };
        },
        async run() {
          calls.push({ sql, values, method: "run" });
          route(sql, "run")?.run?.(values);
          return { success: true, meta: { rows_read: 0, rows_written: 1 } };
        },
      };
      return statement;
    },
    async withTransaction<T>(operation: (tx: DbClient) => Promise<T>) {
      return operation(db as unknown as DbClient);
    },
  };
  return { db: db as unknown as DbClient, calls };
}

type RevisionEvent = {
  id: string; change_set_id: string; version_id: string; target_key: string;
  source_kind: string; after_value_json: unknown; actor_user_id: string;
};
type IntakeRow = {
  id: string; final_id: string; kind: string; target_key: string; target_label: string; value_json: string;
  source: string; source_version_id: string | null; source_version_number: number | null;
  actor_user_id: string; actor_name: string; change_set_id: string | null; applied: boolean; applied_at: string | null;
};

type World = {
  versions: AnalysisVersionRow[];
  revisionEvents: RevisionEvent[];
  final: FinalRow | null;
  intakes: IntakeRow[];
  audits: Array<{ action: string; objectId: string; detail: Record<string, unknown> }>;
  /** 回放用的历史修订事件（集成版虚拟计算 / 首次物化时读）。 */
  history: Array<{ id: string; created_at: string; version_id: string; target_key: string; before: unknown; after: unknown }>;
};

function world(partial: Partial<World> = {}): World {
  return { versions: [], revisionEvents: [], final: null, intakes: [], audits: [], history: [], ...partial };
}

/** 视频工作台读写会用到的全部 SQL。任何不在这里的 SQL 都是测试失败。 */
function studioDb(state: World) {
  const byNumber = () => [...state.versions].sort((a, b) => a.version_number - b.version_number);
  const versionById = (id: unknown) => state.versions.find((row) => row.id === id) ?? null;
  const handlers: Handler[] = [
    { match: /FROM videos\s+WHERE id = \?/, first: () => ({ id: "video1", deleted_at: null, deletion_state: null }) },
    { match: /FROM collaboration_workspaces\s+WHERE video_id = \? AND workflow_version = \?/, first: () => WORKSPACE },
    {
      match: /^SELECT version_id FROM collaboration_revision_events/,
      first: ([, changeSetId]) => state.revisionEvents.find((event) => event.change_set_id === changeSetId) ?? null,
    },
    {
      match: /^SELECT COUNT\(\*\) AS count FROM analysis_versions WHERE workspace_id = \? AND version_kind = 'PERSONAL'$/,
      first: () => ({ count: state.versions.filter((row) => row.version_kind === "PERSONAL").length }),
    },
    {
      match: /FROM analysis_versions\s+WHERE workspace_id = \? AND owner_user_id = \? AND version_kind = 'PERSONAL'$/,
      first: ([, owner]) => state.versions.find((row) => row.owner_user_id === owner && row.version_kind === "PERSONAL") ?? null,
    },
    { match: /FROM analysis_versions\s+WHERE workspace_id = \? ORDER BY version_number ASC$/, all: () => byNumber() },
    { match: /FROM analysis_versions WHERE id = \?$/, first: ([id]) => versionById(id) },
    {
      match: /FROM analysis_versions\s+WHERE workspace_id = \? AND version_kind = 'AUDIO_REVIEW'\s+ORDER BY version_number ASC$/,
      all: () => byNumber().filter((row) => row.version_kind === "AUDIO_REVIEW"),
    },
    {
      match: /FROM analysis_versions\s+WHERE id = \? AND workspace_id = \? AND version_kind = 'AUDIO_REVIEW'$/,
      first: ([id, workspaceId]) => state.versions.find((row) =>
        row.id === id && row.workspace_id === workspaceId && row.version_kind === "AUDIO_REVIEW") ?? null,
    },
    {
      match: /FROM analysis_versions\s+WHERE workspace_id = \? AND version_number = 1 AND version_kind = 'PERSONAL'$/,
      first: () => state.versions.find((row) => row.version_number === 1 && row.version_kind === "PERSONAL") ?? null,
    },
    {
      // 只有带 PERSONAL 过滤的 JOIN 才会被路由到这里——点评版的事件由假库按 JOIN 语义滤掉。
      match: /INNER JOIN analysis_versions v ON v\.id = e\.version_id AND v\.version_kind = 'PERSONAL'/,
      all: () => state.history
        .filter((event) => versionById(event.version_id)?.version_kind === "PERSONAL")
        .map((event) => ({
          id: event.id, created_at: event.created_at, version_id: event.version_id,
          version_number: versionById(event.version_id)!.version_number, change_set_id: `cs_${event.id}`,
          target_key: event.target_key, target_label_snapshot: event.target_key, value_type: "TEXT",
          before_value_json: event.before, after_value_json: event.after,
          actor_user_id: versionById(event.version_id)!.owner_user_id, actor_name_snapshot: "",
        })),
    },
    {
      match: /^\s*INSERT INTO analysis_versions/,
      first: (values) => {
        // insertVersionFromBase 的绑定顺序（新建个人版本）。
        const [newId, workspaceId, videoId, versionNumber, ownerUserId, ownerName, baseId, baseNumber, basePayloadJson,
          capturedAt, payloadJson, contentHash] = values as [string, string, string, number, string, string, string, number, string, string, string, string];
        state.versions.push(versionRow({
          id: newId, workspace_id: workspaceId, video_id: videoId, version_number: versionNumber,
          owner_user_id: ownerUserId, owner_name_snapshot: ownerName, base_version_id: baseId,
          base_version_number: baseNumber, base_payload_json: JSON.parse(basePayloadJson), base_captured_at: capturedAt,
          payload_json: JSON.parse(payloadJson), content_hash: contentHash,
        }));
        return { id: newId };
      },
      run: () => {
        throw new Error("v1 materialization is not expected in these fixtures");
      },
    },
    {
      match: /^\s*UPDATE analysis_versions/,
      run: ([payloadJson, hash, revision, updatedAt, id]) => {
        const row = versionById(id)!;
        Object.assign(row, { payload_json: JSON.parse(payloadJson as string), content_hash: hash, revision, updated_at: updatedAt });
      },
    },
    {
      match: /INSERT INTO collaboration_revision_events[\s\S]*'HUMAN_DIRECT'/,
      run: (values) => state.revisionEvents.push({
        id: values[0] as string, change_set_id: values[4] as string, target_key: values[7] as string,
        after_value_json: JSON.parse(values[11] as string), actor_user_id: values[13] as string,
        version_id: values[16] as string, source_kind: "HUMAN_DIRECT",
      }),
    },
    {
      match: /INSERT INTO audit_logs/,
      run: (values) => state.audits.push({
        action: values[2] as string, objectId: values[4] as string, detail: JSON.parse(values[5] as string),
      }),
    },
    // ---- 集成版 ----
    { match: /FROM analysis_final_versions WHERE workspace_id = \? FOR UPDATE$/, first: () => state.final },
    { match: /FROM analysis_final_versions WHERE workspace_id = \?$/, first: () => state.final },
    { match: /FROM analysis_final_versions WHERE id = \?$/, first: () => state.final },
    {
      match: /^\s*INSERT INTO analysis_final_versions/,
      first: (values) => {
        const [id, workspaceId, videoId, originJson, payloadJson, hash, createdAt] = values as string[];
        state.final = {
          id, workspace_id: workspaceId, video_id: videoId, status: "OPEN", done_at: null, done_by_user_id: null,
          done_by_name: null, origin_payload_json: JSON.parse(originJson), payload_json: JSON.parse(payloadJson),
          content_hash: hash, revision: 1, created_at: createdAt, updated_at: createdAt,
        };
        return state.final;
      },
    },
    {
      match: /^\s*UPDATE analysis_final_versions/,
      run: ([payloadJson, hash, updatedAt]) => {
        Object.assign(state.final!, {
          payload_json: JSON.parse(payloadJson as string), content_hash: hash,
          revision: state.final!.revision + 1, updated_at: updatedAt,
        });
      },
    },
    { match: /^SELECT applied FROM analysis_final_intakes/, first: () => null },
    {
      match: /^SELECT COUNT\(\*\) AS count FROM analysis_final_intakes WHERE final_id = \? AND applied = false$/,
      first: () => ({ count: state.intakes.filter((row) => !row.applied).length }),
    },
    {
      match: /FROM analysis_final_intakes WHERE final_id = \? ORDER BY seq ASC$/,
      all: () => state.intakes.map((row, index) => ({ ...row, seq: index + 1, workspace_id: "ws1", video_id: "video1", created_at: row.applied_at })),
    },
    {
      match: /^\s*INSERT INTO analysis_final_intakes/,
      run: (values) => state.intakes.push({
        id: values[0] as string, final_id: values[1] as string, kind: values[4] as string,
        target_key: values[5] as string, target_label: values[6] as string, value_json: values[7] as string,
        source: values[8] as string, source_version_id: values[9] as string | null,
        source_version_number: values[10] as number | null, actor_user_id: values[11] as string,
        actor_name: values[12] as string, change_set_id: values[13] as string | null,
        applied: values[14] as boolean, applied_at: values[15] as string | null,
      }),
    },
  ];
  return scriptedDb(handlers);
}

const touchesFinal = (calls: Call[]) => calls.filter((call) => /analysis_final_(versions|intakes)/.test(call.sql));

/** 刘梦娜 v1（被点评）、赵雅诗 v2、老孙的点评版 v3（基于 v1，updated_at 最新）。 */
function reviewedWorkspace(extra: Partial<World> = {}) {
  const v1 = versionRow({
    id: "v1", version_number: 1, owner_user_id: LIU.userId, owner_name_snapshot: LIU.displayName,
    updated_at: "2026-10-03T00:00:00.000Z",
  });
  const v2 = versionRow({
    id: "v2", version_number: 2, owner_user_id: ZHAO.userId, owner_name_snapshot: ZHAO.displayName,
    base_version_id: "v1", base_version_number: 1, base_payload_json: homework(),
    payload_json: edit(homework(), (draft) => { draft.factsAndCoreJudgement.ratingReason = "节奏好，结尾弱"; }),
    updated_at: "2026-10-04T00:00:00.000Z",
  });
  const v3 = versionRow({
    id: "v3", version_number: 3, owner_user_id: LAOSUN.userId, owner_name_snapshot: LAOSUN.displayName,
    base_version_id: "v1", base_version_number: 1, base_payload_json: homework(),
    payload_json: reviewPayload(), version_kind: "AUDIO_REVIEW", audio_review_id: "arv_1",
    updated_at: "2026-10-09T00:00:00.000Z",
  });
  return world({ versions: [v1, v2, v3], ...extra });
}

function change(targetKey: string, beforeValue: unknown, afterValue: unknown): V04Change {
  return { targetKey, targetLabel: targetKey, valueType: "TEXT", beforeValue, afterValue };
}

// ---------------------------------------------------------------------------
// 3.3 纯函数：默认版本、我的版本、版本标签
// ---------------------------------------------------------------------------

test("resolveV19DefaultVersion never picks a review version, even the most recently modified one", () => {
  const picked = resolveV19DefaultVersion([
    { id: "v1", number: 1, updatedAt: "2026-10-03T00:00:00.000Z", kind: "PERSONAL" },
    { id: "v2", number: 2, updatedAt: "2026-10-04T00:00:00.000Z", kind: "PERSONAL" },
    { id: "v3", number: 3, updatedAt: "2026-10-09T00:00:00.000Z", kind: "AUDIO_REVIEW" },
  ]);
  assert.equal(picked.id, "v2");
  // 报告侧的版本不带 kind，照旧按最新修改。
  assert.equal(resolveV19DefaultVersion([
    { number: 1, updatedAt: "2026-10-03T00:00:00.000Z" },
    { number: 2, updatedAt: "2026-10-09T00:00:00.000Z" },
  ]).number, 2);
  assert.throws(
    () => resolveV19DefaultVersion([{ number: 3, updatedAt: "2026-10-09T00:00:00.000Z", kind: "AUDIO_REVIEW" }]),
    /EMPTY_VERSION_LIST/,
  );
});

test("pickV19ActorVersion: 老孙's review version is never his own version", () => {
  const versions = [
    { id: "v3", ownerUserId: LAOSUN.userId, kind: "AUDIO_REVIEW" },
    { id: "v4", ownerUserId: LAOSUN.userId, kind: "PERSONAL" },
  ];
  assert.equal(pickV19ActorVersion(versions, LAOSUN.userId)?.id, "v4");
  assert.equal(pickV19ActorVersion(versions.slice(0, 1), LAOSUN.userId), null);
});

test("a review version's summary is never 'mine' and carries its kind and review id", () => {
  const summary = toSummary(reviewedWorkspace().versions[2], LAOSUN.userId);
  assert.equal(summary.isMine, false);
  assert.equal(summary.kind, "AUDIO_REVIEW");
  assert.equal(summary.audioReviewId, "arv_1");
  assert.equal(toSummary(reviewedWorkspace().versions[0], LIU.userId).kind, "PERSONAL");
});

test("server and client formatV19VersionLabel agree, review versions included", () => {
  const inputs = [
    { number: 1, baseNumber: null, ownerName: "刘梦娜", ownerIsUploader: true },
    { number: 2, baseNumber: 1, ownerName: "赵雅诗", ownerIsUploader: false },
    { number: 4, baseNumber: null, ownerName: "老孙", ownerIsUploader: false, baseIsFinal: true },
    { number: 3, baseNumber: 1, ownerName: "老孙", ownerIsUploader: false, kind: "AUDIO_REVIEW" as const },
    { number: 5, baseNumber: 2, ownerName: "赵雅诗", ownerIsUploader: false, kind: "PERSONAL" as const },
  ];
  for (const input of inputs) assert.equal(formatV19VersionLabel(input), formatV19VersionLabelClient(input));
  assert.equal(formatV19VersionLabel(inputs[3]), "v3（老孙录音点评，基于v1）");
});

// ---------------------------------------------------------------------------
// 3.3 读路径：「我的版本」与默认展示
// ---------------------------------------------------------------------------

test("loadV19VersionChain: 老孙 owning only a review version has no 'my version' and lands on 集成版 with review candidates", async () => {
  const state = reviewedWorkspace({ final: finalRow(homework()) });
  const { db } = studioDb(state);
  const chain = await loadV19VersionChain(db, "video1", LAOSUN);
  assert.equal(chain.myVersionId, null);
  assert.equal(chain.current.isFinal, true);
  assert.deepEqual(chain.versions.map((version) => [version.number, version.kind, version.isMine]), [
    [1, "PERSONAL", false], [2, "PERSONAL", false], [3, "AUDIO_REVIEW", false],
  ]);
  assert.deepEqual(
    chain.finalTrace?.reviewCandidates.map((candidate) => [candidate.reviewVersionNumber, candidate.targetKey]),
    [[3, "shot:s1.visualContent"], [3, "facts.creativeMotif"]],
  );
});

test("loadV19VersionChain: 老孙 with both a personal and a review version defaults to the personal one", async () => {
  const state = reviewedWorkspace({ final: finalRow(homework()) });
  state.versions.push(versionRow({
    id: "v4", version_number: 4, owner_user_id: LAOSUN.userId, owner_name_snapshot: "老孙",
    base_version_id: "v2", base_version_number: 2, base_payload_json: homework(), updated_at: "2026-10-05T00:00:00.000Z",
  }));
  const chain = await loadV19VersionChain(studioDb(state).db, "video1", LAOSUN);
  assert.equal(chain.myVersionId, "v4");
  assert.equal(chain.current.id, "v4");
  // 显式指定点评版照常能看。
  const explicit = await loadV19VersionChain(studioDb(state).db, "video1", LAOSUN, { versionId: "v3" });
  assert.equal(explicit.current.id, "v3");
  assert.equal(explicit.current.kind, "AUDIO_REVIEW");
  assert.equal(explicit.current.isMine, false);
});

// ---------------------------------------------------------------------------
// 五、点评版的保存
// ---------------------------------------------------------------------------

test("老孙 saving on his own review version writes into that row and never touches 集成版", async () => {
  const state = reviewedWorkspace({ final: finalRow(homework()) });
  const { db, calls } = studioDb(state);
  const result = await saveV19VersionChanges(db, LAOSUN, {
    videoId: "video1",
    basedOnVersionId: "v3",
    changeSetId: "cs_review_edit",
    changes: [change("facts.ratingReason", "节奏好", "节奏好，但母题看浅了")],
    now: NOW,
  });
  assert.equal(result.versionId, "v3");
  assert.equal(result.versionKind, "AUDIO_REVIEW");
  assert.equal(result.createdVersion, false);
  assert.equal(result.revision, 2);
  assert.deepEqual(result.finalIntake, { merged: false, pending: 0 });

  const review = state.versions.find((row) => row.id === "v3")!;
  assert.equal((review.payload_json as V04DraftPayloadV1).factsAndCoreJudgement.ratingReason, "节奏好，但母题看浅了");
  assert.equal(state.versions.length, 3, "no personal version is created for 老孙");
  const update = calls.find((call) => /^\s*UPDATE analysis_versions/.test(call.sql))!;
  assert.equal(update.values[4], "v3");
  assert.deepEqual(state.revisionEvents.map((event) => [event.version_id, event.source_kind, event.target_key]), [
    ["v3", "HUMAN_DIRECT", "facts.ratingReason"],
  ]);
  assert.equal(state.audits[0].action, "V19_VERSION_SAVED");
  assert.equal(state.audits[0].objectId, "v3");
  assert.equal(state.audits[0].detail.versionKind, "AUDIO_REVIEW");
  assert.deepEqual(touchesFinal(calls), [], "a review version never feeds 集成版");
  assert.equal(state.intakes.length, 0);
});

test("replaying a review-version save stays off 集成版 too, and a no-op save on it does not intake either", async () => {
  const state = reviewedWorkspace({ final: finalRow(homework()) });
  const first = studioDb(state);
  const input = {
    videoId: "video1", basedOnVersionId: "v3", changeSetId: "cs_once",
    changes: [change("facts.ratingReason", "节奏好", "节奏好！")], now: NOW,
  };
  await saveV19VersionChanges(first.db, LAOSUN, input);
  const replay = studioDb(state);
  const replayed = await saveV19VersionChanges(replay.db, LAOSUN, input);
  assert.equal(replayed.versionId, "v3");
  assert.equal(replayed.versionKind, "AUDIO_REVIEW");
  assert.deepEqual(replayed.finalIntake, { merged: false, pending: 0 });
  assert.deepEqual(touchesFinal(replay.calls), []);
  assert.equal(state.revisionEvents.length, 1, "the replay does not write a second event");

  const noop = studioDb(state);
  const unchanged = await saveV19VersionChanges(noop.db, LAOSUN, {
    ...input, changeSetId: "cs_noop", changes: [change("facts.ratingReason", "节奏好！", "节奏好！")],
  });
  assert.equal(unchanged.versionKind, "AUDIO_REVIEW");
  assert.deepEqual(unchanged.finalIntake, { merged: false, pending: 0 });
  assert.deepEqual(touchesFinal(noop.calls), []);
});

test("someone without a version who edits on the review version gets a new personal version based on it", async () => {
  const state = reviewedWorkspace({ final: finalRow(homework()) });
  const newcomer = actor("user_wang", "王大明");
  const { db, calls } = studioDb(state);
  const result = await saveV19VersionChanges(db, newcomer, {
    videoId: "video1", basedOnVersionId: "v3", changeSetId: "cs_wang",
    changes: [change("facts.tensionButton", "", "警察")], now: NOW,
  });
  assert.equal(result.versionKind, "PERSONAL");
  assert.equal(result.createdVersion, true);
  assert.equal(result.versionNumber, 4, "numbers continue past the review version");
  const created = state.versions.find((row) => row.id === result.versionId)!;
  assert.equal(created.version_kind, "PERSONAL");
  assert.equal(created.owner_user_id, "user_wang");
  assert.equal(created.base_version_id, "v3");
  assert.equal(created.base_version_number, 3);
  assert.deepEqual(created.base_payload_json, reviewPayload(), "the base snapshot is the review version's content at that moment");
  assert.equal((created.payload_json as V04DraftPayloadV1).factsAndCoreJudgement.creativeMotif, "躲藏与寻回");
  assert.equal((created.payload_json as V04DraftPayloadV1).factsAndCoreJudgement.tensionButton, "警察");
  // 个人版本的保存照常汇入集成版，来源是新建的个人版本。
  assert.ok(touchesFinal(calls).length > 0);
  assert.deepEqual(state.intakes.map((row) => [row.source_version_id, row.target_key]), [[result.versionId, "facts.tensionButton"]]);
  // 被点评的点评版本身一字未动。
  assert.deepEqual(state.versions.find((row) => row.id === "v3")!.payload_json, reviewPayload());
});

test("someone who already owns a version and edits on the review version writes into their own version", async () => {
  const state = reviewedWorkspace({ final: finalRow(homework()) });
  const { db } = studioDb(state);
  const result = await saveV19VersionChanges(db, ZHAO, {
    videoId: "video1", basedOnVersionId: "v3", changeSetId: "cs_zhao",
    changes: [change("facts.tensionButton", "", "井盖")], now: NOW,
  });
  assert.equal(result.versionId, "v2");
  assert.equal(result.versionKind, "PERSONAL");
  assert.equal(state.versions.length, 3);
  assert.deepEqual(state.versions.find((row) => row.id === "v3")!.payload_json, reviewPayload());
});

test("老孙 editing someone else's version gets his own personal version, not his review version", async () => {
  const state = reviewedWorkspace({ final: finalRow(homework()) });
  const { db } = studioDb(state);
  const result = await saveV19VersionChanges(db, LAOSUN, {
    videoId: "video1", basedOnVersionId: "v2", changeSetId: "cs_laosun_personal",
    changes: [change("facts.tensionButton", "", "警察")], now: NOW,
  });
  assert.notEqual(result.versionId, "v3");
  assert.equal(result.versionKind, "PERSONAL");
  const created = state.versions.find((row) => row.id === result.versionId)!;
  assert.equal(created.owner_user_id, LAOSUN.userId);
  assert.equal(created.version_kind, "PERSONAL");
  assert.equal(created.base_version_id, "v2");
});

test("a review version from another case is never written through basedOnVersionId", async () => {
  const state = reviewedWorkspace({ final: finalRow(homework()) });
  state.versions.push(versionRow({
    id: "foreign_review", version_number: 9, owner_user_id: LAOSUN.userId, workspace_id: "ws_other",
    version_kind: "AUDIO_REVIEW", audio_review_id: "arv_other",
  }));
  const { db } = studioDb(state);
  const result = await saveV19VersionChanges(db, LAOSUN, {
    videoId: "video1", basedOnVersionId: "foreign_review", changeSetId: "cs_foreign",
    changes: [change("facts.tensionButton", "", "警察")], now: NOW,
  });
  assert.notEqual(result.versionId, "foreign_review");
  assert.equal(result.versionKind, "PERSONAL");
});

test("without basedOnVersionId a newcomer's default base is the latest personal version, never the review version", async () => {
  const state = reviewedWorkspace({ final: finalRow(homework()) });
  const { db } = studioDb(state);
  const result = await saveV19VersionChanges(db, actor("user_wang", "王大明"), {
    videoId: "video1", basedOnVersionId: null, changeSetId: "cs_default",
    changes: [change("facts.tensionButton", "", "警察")], now: NOW,
  });
  assert.equal(state.versions.find((row) => row.id === result.versionId)!.base_version_id, "v2");
});

test("createV19VersionFrom: owning a review version does not count as already owning a version", async () => {
  const state = reviewedWorkspace({ final: finalRow(homework()) });
  const { db, calls } = studioDb(state);
  const result = await createV19VersionFrom(db, LAOSUN, { videoId: "video1", baseVersionId: "v3", now: NOW });
  assert.equal(result.versionKind, "PERSONAL");
  assert.equal(result.versionNumber, 4);
  const created = state.versions.find((row) => row.id === result.versionId)!;
  assert.equal(created.version_kind, "PERSONAL");
  assert.equal(created.base_version_id, "v3");
  assert.ok(calls.some((call) => /COUNT\(\*\) AS count FROM analysis_versions WHERE workspace_id = \? AND version_kind = 'PERSONAL'/.test(call.sql)));
  // 有了个人版本之后再建就被挡下。
  await assert.rejects(
    createV19VersionFrom(studioDb(state).db, LAOSUN, { videoId: "video1", baseVersionId: "v1", now: NOW }),
    /你已经拥有本工作区的版本/,
  );
});

// ---------------------------------------------------------------------------
// 3.3 集成版：回放、物化只看个人版本
// ---------------------------------------------------------------------------

test("集成版 replay ignores review-version revision events (virtual final)", async () => {
  const state = reviewedWorkspace({
    history: [
      { id: "e1", created_at: "2026-10-04T00:00:00.000Z", version_id: "v2", target_key: "facts.ratingReason", before: "节奏好", after: "节奏好，结尾弱" },
      { id: "e2", created_at: "2026-10-09T00:00:00.000Z", version_id: "v3", target_key: "facts.creativeMotif", before: "捉迷藏", after: "躲藏与寻回" },
    ],
  });
  const final = await loadFinalVersion(studioDb(state).db, WORKSPACE);
  assert.equal(final.isVirtual, true);
  assert.equal(final.payload.factsAndCoreJudgement.ratingReason, "节奏好，结尾弱");
  assert.equal(final.payload.factsAndCoreJudgement.creativeMotif, "捉迷藏", "the review version's rewrite is not merged");

  const trace = await loadFinalTrace(studioDb(state).db, WORKSPACE);
  assert.deepEqual(trace.intakes.map((intake) => intake.sourceVersionNumber), [2]);
  assert.deepEqual(trace.reviewCandidates.map((candidate) => candidate.targetKey), ["shot:s1.visualContent", "facts.creativeMotif"]);
});

test("ensureFinalVersion materializes from personal versions only", async () => {
  const state = reviewedWorkspace({
    history: [
      { id: "e2", created_at: "2026-10-09T00:00:00.000Z", version_id: "v3", target_key: "facts.creativeMotif", before: "捉迷藏", after: "躲藏与寻回" },
    ],
  });
  const { db, calls } = studioDb(state);
  const row = await ensureFinalVersion(db, WORKSPACE, NOW);
  assert.equal((row.payload_json as V04DraftPayloadV1).factsAndCoreJudgement.creativeMotif, "捉迷藏");
  assert.equal(state.intakes.length, 0);
  assert.ok(calls.some((call) => /version_kind = 'PERSONAL'$/.test(call.sql) && /COUNT\(\*\)/.test(call.sql)));
});

// ---------------------------------------------------------------------------
// 六、点评版候选与采纳
// ---------------------------------------------------------------------------

function reviewSource(payload: V04DraftPayloadV1, overrides: Partial<FinalReviewSource> = {}): FinalReviewSource {
  return { id: "v3", number: 3, payload, basePayload: homework(), updatedAt: "2026-10-09T00:00:00.000Z", ...overrides };
}

test("review candidates: every changed FIELD key against the upload-time snapshot, minus what 集成版 already says", () => {
  const final = edit(homework(), (draft) => { draft.factsAndCoreJudgement.creativeMotif = "躲藏与寻回"; });
  const candidates = computeV19ReviewCandidates(final, [reviewSource(reviewPayload())]);
  assert.deepEqual(candidates, [{
    reviewVersionId: "v3",
    reviewVersionNumber: 3,
    targetKey: "shot:s1.visualContent",
    targetLabel: "画面内容（镜头故事）",
    value: "井盖里钻出来的是警察",
    updatedAt: "2026-10-09T00:00:00.000Z",
  }], "facts.creativeMotif already matches 集成版 and is not listed");
});

test("review candidates: shots inserted in the review version, and keys 集成版 no longer has, are not listed", () => {
  const review = edit(reviewPayload(), (draft) => {
    draft.script.shotGroups[0].shots.splice(1, 0, shot("s_new", 1, { visualContent: "老孙补的镜头" }));
    draft.script.shotGroups[0].shots[2].orderIndex = 2;
    draft.script.shotGroups[0].shots[2].visualContent = "大人找到了警察";
  });
  const finalWithoutS2 = edit(homework(), (draft) => { draft.script.shotGroups[0].shots.splice(1, 1); });
  const keys = computeV19ReviewCandidates(finalWithoutS2, [reviewSource(review)]).map((candidate) => candidate.targetKey);
  assert.deepEqual(keys, ["shot:s1.visualContent", "facts.creativeMotif"]);
  assert.ok(!keys.some((key) => key.includes("s_new")));
  // 没有基版快照（不该出现）就什么都不列，而不是把整份内容当改动。
  assert.deepEqual(computeV19ReviewCandidates(homework(), [reviewSource(reviewPayload(), { basePayload: null })]), []);
});

test("review candidates ignore object key order when comparing with 集成版", () => {
  const withPath = (details: Record<string, string>) => edit(homework(), (draft) => {
    draft.perceptionPath = { primaryType: "FUN", primaryDetails: details, auxiliaryTypes: [] };
  });
  const review = withPath({ reveal: "警察", deviation: "躲" });
  const final = withPath({ deviation: "躲", reveal: "警察" });
  assert.deepEqual(computeV19ReviewCandidates(final, [reviewSource(review, { basePayload: withPath({ reveal: "", deviation: "" }) })]), []);
});

test("ADOPT_REVIEW is 老孙's alone and is refused before touching the database", async () => {
  const { db, calls } = studioDb(reviewedWorkspace({ final: finalRow(homework()) }));
  await assert.rejects(
    adoptFinalReviewCandidates(db, LIU, { videoId: "video1", reviewVersionId: "v3", targetKeys: ["facts.creativeMotif"], now: NOW }),
    (error: Error & { code?: string }) => error.code === "FORBIDDEN" && /只有老孙/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test("ADOPT_REVIEW writes the server-recomputed value into 集成版 with an applied intake sourced from the review version", async () => {
  const state = reviewedWorkspace({ final: finalRow(homework()) });
  const { db } = studioDb(state);
  const result = await adoptFinalReviewCandidates(db, LAOSUN, {
    videoId: "video1",
    reviewVersionId: "v3",
    // 一个真候选、一个点评版根本没改的键（客户端自己编的），后者被忽略。
    targetKeys: ["facts.creativeMotif", "facts.ratingReason"],
    now: NOW,
  });
  assert.equal(result.adopted, 1);
  assert.equal(result.final.pendingCount, 0, "adopting never creates pending intakes");
  assert.equal(state.final!.payload_json.factsAndCoreJudgement.creativeMotif, "躲藏与寻回");
  assert.equal(state.final!.payload_json.factsAndCoreJudgement.ratingReason, "节奏好");
  assert.equal(state.final!.revision, 5);
  assert.equal(state.final!.content_hash, hashV04Payload(state.final!.payload_json));
  assert.deepEqual(state.intakes.map((row) => ({
    kind: row.kind, target: row.target_key, value: JSON.parse(row.value_json), source: row.source,
    versionId: row.source_version_id, versionNumber: row.source_version_number, applied: row.applied, appliedAt: row.applied_at,
  })), [{
    kind: "FIELD", target: "facts.creativeMotif", value: "躲藏与寻回", source: "VERSION",
    versionId: "v3", versionNumber: 3, applied: true, appliedAt: NOW.toISOString(),
  }]);
  const audit = state.audits.find((entry) => entry.action === "V19_FINAL_REVIEW_ADOPTED")!;
  assert.equal(audit.objectId, "final1");
  assert.deepEqual(audit.detail, {
    reviewVersionId: "v3", reviewVersionNumber: 3, adopted: 1,
    targets: ["facts.creativeMotif"], skippedTargets: ["facts.ratingReason"],
  });
  // 采纳过的候选自然从溯源里消失。
  const trace = await loadFinalTrace(studioDb(state).db, WORKSPACE);
  assert.deepEqual(trace.reviewCandidates.map((candidate) => candidate.targetKey), ["shot:s1.visualContent"]);
});

test("ADOPT_REVIEW works on a 定稿 集成版 too", async () => {
  const state = reviewedWorkspace({
    final: finalRow(homework(), { status: "DONE", done_at: "2026-10-08T00:00:00.000Z", done_by_name: "老孙" }),
  });
  const result = await adoptFinalReviewCandidates(studioDb(state).db, LAOSUN, {
    videoId: "video1", reviewVersionId: "v3", targetKeys: ["shot:s1.visualContent"], now: NOW,
  });
  assert.equal(result.adopted, 1);
  assert.equal(result.final.status, "DONE");
  assert.equal(state.final!.payload_json.script.shotGroups[0].shots[0].visualContent, "井盖里钻出来的是警察");
});

test("ADOPT_REVIEW resolves interdependent keys: retried after the others, then all together for a swap", async () => {
  const mechanism = (ids: string[]) => ({ ...emptyV04ChoiceValue(), selectedOptionIds: ids });
  const base = edit(homework(), (draft) => {
    draft.factsAndCoreJudgement.mainMechanism = mechanism(["INSIGHT_RESONANCE"]);
    draft.factsAndCoreJudgement.auxiliaryMechanism = mechanism(["METAPHOR_TRANSLATION"]);
    draft.perceptionPath = {
      primaryType: "LOVE",
      primaryDetails: {},
      auxiliaryTypes: [{ type: "FUN", description: "反差", creativeRole: "" }],
    };
  });
  const review = edit(base, (draft) => {
    // 老孙：主导、辅助机制看反了；主导路径其实是 FUN，辅助路径不要了。
    draft.factsAndCoreJudgement.mainMechanism = mechanism(["METAPHOR_TRANSLATION"]);
    draft.factsAndCoreJudgement.auxiliaryMechanism = mechanism(["INSIGHT_RESONANCE"]);
    draft.perceptionPath.primaryType = "FUN";
    draft.perceptionPath.auxiliaryTypes = [];
  });
  const state = world({
    versions: [
      versionRow({ id: "v1", version_number: 1, owner_user_id: LIU.userId, payload_json: base }),
      versionRow({
        id: "v3", version_number: 3, owner_user_id: LAOSUN.userId, base_version_id: "v1", base_version_number: 1,
        base_payload_json: base, payload_json: review, version_kind: "AUDIO_REVIEW", audio_review_id: "arv_1",
      }),
    ],
    final: finalRow(base),
  });
  const result = await adoptFinalReviewCandidates(studioDb(state).db, LAOSUN, {
    videoId: "video1", reviewVersionId: "v3",
    targetKeys: ["facts.mainMechanism", "facts.auxiliaryMechanism", "path.primaryType", "path.auxiliaryTypes"],
    now: NOW,
  });
  assert.equal(result.adopted, 4);
  const facts = state.final!.payload_json.factsAndCoreJudgement;
  assert.deepEqual(facts.mainMechanism.selectedOptionIds, ["METAPHOR_TRANSLATION"]);
  assert.deepEqual(facts.auxiliaryMechanism.selectedOptionIds, ["INSIGHT_RESONANCE"]);
  assert.equal(state.final!.payload_json.perceptionPath.primaryType, "FUN");
  assert.deepEqual(state.final!.payload_json.perceptionPath.auxiliaryTypes, []);
  assert.equal(state.intakes.length, 4);
});

test("ADOPT_REVIEW only accepts a review version of this case, and an empty selection changes nothing", async () => {
  const state = reviewedWorkspace({ final: finalRow(homework()) });
  for (const reviewVersionId of ["v2", "missing"]) {
    await assert.rejects(
      adoptFinalReviewCandidates(studioDb(state).db, LAOSUN, { videoId: "video1", reviewVersionId, targetKeys: ["facts.creativeMotif"], now: NOW }),
      (error: Error & { code?: string }) => error.code === "VERSION_NOT_FOUND",
    );
  }
  const { db, calls } = studioDb(state);
  const result = await adoptFinalReviewCandidates(db, LAOSUN, { videoId: "video1", reviewVersionId: "v3", targetKeys: [], now: NOW });
  assert.equal(result.adopted, 0);
  assert.equal(state.intakes.length, 0);
  assert.ok(!calls.some((call) => /^\s*(INSERT|UPDATE)/.test(call.sql)));
});

test("the final route dispatches ADOPT_REVIEW to the service, which owns the 老孙 check", async () => {
  const route = codeOnly(await source("../app/api/videos/[id]/analysis/v19/final/route.ts"));
  assert.match(route, /body\.action === "ADOPT_REVIEW"[\s\S]*adoptFinalReviewCandidates\(db, actor, \{[\s\S]*reviewVersionId[\s\S]*targetKeys/);
  assert.doesNotMatch(route, /老孙/);
  // 路由不把客户端的值传下去：只有点评版 id 和键。
  assert.doesNotMatch(route.slice(route.indexOf("ADOPT_REVIEW")), /value/);
  const lib = codeOnly(await source("../lib/final-version.ts"));
  assert.match(lib, /export async function adoptFinalReviewCandidates[\s\S]*?\{\s*requireReviewerActor\(actor,/);
});

// ---------------------------------------------------------------------------
// 3.3 评分与评论
// ---------------------------------------------------------------------------

function reviewDb(kind: "PERSONAL" | "AUDIO_REVIEW") {
  const ratingWrites: unknown[][] = [];
  const { db, calls } = scriptedDb([
    {
      match: /^SELECT id, video_id, version_kind FROM analysis_versions WHERE id = \?$/,
      first: ([id]) => ({ id, video_id: "video1", version_kind: kind }),
    },
    {
      match: /^SELECT id, video_id, version_number, version_kind FROM analysis_versions WHERE id = \?$/,
      first: ([id]) => ({ id, video_id: "video1", version_number: 3, version_kind: kind }),
    },
    { match: /FROM analysis_version_ratings WHERE version_id = \?/, first: () => ({ stars: 4 }) },
    {
      match: /av\.version_kind\s+FROM analysis_version_comments c\s+LEFT JOIN analysis_versions av ON av\.id = c\.version_id/,
      all: () => [
        { target_key: "facts.creativeMotif", target_label: "创意母题", body: "看浅了", author_name: "老孙", updated_at: "2026-10-09T00:00:00.000Z", version_id: "v3", version_number: 3, version_kind: "AUDIO_REVIEW" },
        { target_key: "facts.creativeMotif", target_label: "创意母题", body: "好", author_name: "老孙", updated_at: "2026-10-08T00:00:00.000Z", version_id: "v1", version_number: 1, version_kind: "PERSONAL" },
        { target_key: "facts.creativeMotif", target_label: "创意母题", body: "定", author_name: "老孙", updated_at: "2026-10-07T00:00:00.000Z", version_id: "final1", version_number: null, version_kind: null },
      ],
    },
    { match: /analysis_version_ratings/, run: (values) => ratingWrites.push(values) },
    {
      match: /^\s*INSERT INTO analysis_version_comments/,
      first: (values) => ({ target_key: values[1], target_label: values[3], body: values[4], author_name: values[6], updated_at: "2026-10-10T08:00:00.000Z" }),
    },
  ]);
  return { db, calls, ratingWrites };
}

test("a review version cannot be rated: canRate is false and no rating is read", async () => {
  const { db, calls } = reviewDb("AUDIO_REVIEW");
  const review = await loadCaseReview(db, { videoId: "video1", versionId: "v3", viewer: { userId: LAOSUN.userId, displayName: "老孙" } });
  assert.equal(review.canRate, false);
  assert.equal(review.stars, null);
  assert.ok(!calls.some((call) => /analysis_version_ratings/.test(call.sql)));
  assert.deepEqual(review.comments.map((comment) => comment.versionLabel), ["v3（点评版）", "v1", "集成版"]);

  const personal = await loadCaseReview(reviewDb("PERSONAL").db, { videoId: "video1", versionId: "v1", viewer: { userId: LAOSUN.userId, displayName: "老孙" } });
  assert.equal(personal.canRate, true);
  assert.equal(personal.stars, 4);
});

test("rating a review version is refused with 点评版不评分 — clearing a rating too", async () => {
  for (const stars of [4, 0]) {
    const { db, ratingWrites } = reviewDb("AUDIO_REVIEW");
    await assert.rejects(
      saveCaseReviewRating(db, { videoId: "video1", versionId: "v3", stars, viewer: { userId: LAOSUN.userId, displayName: "老孙" } }),
      /点评版不评分/,
    );
    assert.equal(ratingWrites.length, 0);
  }
  const { db, ratingWrites } = reviewDb("PERSONAL");
  assert.deepEqual(await saveCaseReviewRating(db, { videoId: "video1", versionId: "v1", stars: 5, viewer: { userId: LAOSUN.userId, displayName: "老孙" } }), { stars: 5 });
  assert.equal(ratingWrites.length, 1);
});

test("a comment written on a review version is labelled vN（点评版）", async () => {
  const { db } = reviewDb("AUDIO_REVIEW");
  const saved = await saveCaseReviewComment(db, {
    videoId: "video1", versionId: "v3", targetKey: "facts.creativeMotif", targetLabel: "创意母题", body: "母题看浅了",
    viewer: { userId: LAOSUN.userId, displayName: "老孙" },
  });
  assert.equal(saved.comment?.versionLabel, "v3（点评版）");
  assert.equal(caseReviewVersionLabel(3, "AUDIO_REVIEW"), "v3（点评版）");
});

// ---------------------------------------------------------------------------
// 3.3 案例库：作业评级、案例卡
// ---------------------------------------------------------------------------

test("case-library ratings only join personal versions", async () => {
  const { db, calls } = scriptedDb([], { permissive: true });
  await loadCaseEngagement(db, ["video1"], LAOSUN.userId);
  const ratings = calls.find((call) => /FROM analysis_version_ratings r/.test(call.sql))!;
  assert.match(ratings.sql, /JOIN analysis_versions v ON v\.id = r\.version_id AND v\.version_kind = 'PERSONAL'/);
});

test("case cards count and date versions from personal versions only", async () => {
  const { db, calls } = scriptedDb([], { permissive: true });
  await loadV04CaseCardsReadModel(db, ["video1"], { actor: { userId: LAOSUN.userId, sessionId: "session" } });
  const cards = calls.find((call) => /version_stats/.test(call.sql))!;
  assert.match(
    cards.sql,
    /SELECT COUNT\(\*\)::integer AS version_count,[\s\S]*FROM analysis_versions item\s+WHERE item\.workspace_id = w\.id AND item\.version_kind = 'PERSONAL'\s+\) version_stats ON TRUE/,
  );
});

// ---------------------------------------------------------------------------
// 八、外部 Agent 接口
// ---------------------------------------------------------------------------

test("agent list counts personal versions only, while updatedSince still sees review-version saves", async () => {
  const { db, calls } = scriptedDb([], { permissive: true });
  await listAgentVideos(db, { limit: 10, offset: 0, q: "", hasAnalysis: true, updatedSince: "2026-10-01T00:00:00Z" });
  const sql = calls[0].sql;
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE av\.version_kind = 'PERSONAL'\)::int AS version_count/);
  assert.match(sql, /MAX\(av\.updated_at\) AS last_version_at\s+FROM analysis_versions av WHERE av\.workspace_id = w\.id\s/);
  assert.match(sql, /COALESCE\(stats\.version_count, 0\) > 0/);
});

function agentDb(state: World, digests: Array<Record<string, unknown>>) {
  const reviewQueries: unknown[][] = [];
  const handlers: Handler[] = [
    {
      match: /FROM videos v WHERE v\.id = \?/,
      first: () => ({ id: "video1", title: "捉迷藏", brand: "某品牌", description: "", tags_json: "[]", object_key: null, thumbnail_key: null, content_type: "video/mp4", file_size: 1, created_by_name: "刘梦娜", created_at: "2026-10-01T00:00:00.000Z" }),
    },
    { match: /FROM collaboration_workspaces\s+WHERE video_id = \? AND workflow_version = \?/, first: () => WORKSPACE },
    { match: /FROM analysis_versions\s+WHERE workspace_id = \? ORDER BY version_number ASC$/, all: () => state.versions },
    {
      match: /^SELECT id, audio_duration_ms, proposal_json FROM audio_reviews\s+WHERE id IN \([?, ]+\) AND status = 'GENERATED'$/,
      all: (values) => {
        reviewQueries.push(values);
        return digests.filter((row) => values.includes(row.id));
      },
    },
  ];
  return { ...scriptedDb(handlers), reviewQueries };
}

const GENERATED_DIGEST = {
  id: "arv_1",
  audio_duration_ms: 754_000,
  proposal_json: {
    opinions: [
      { id: "o2", number: 2, kind: "SPECIFIC", summary: "井盖里钻出来的是警察" },
      { id: "o1", number: 1, kind: "GENERAL", summary: "母题看浅了" },
    ],
    changes: [], dropped: [{ key: "x", reason: "不对外" }],
  },
};

test("agent version=latest never returns a review version, even the newest one", async () => {
  const state = reviewedWorkspace();
  const { db } = agentDb(state, [GENERATED_DIGEST]);
  const result = await getAgentVideoAnalysis(db, "video1", { kind: "LATEST" }, "raw");
  assert.equal(result.version.kind, "VERSION");
  assert.equal("id" in result.version ? result.version.id : null, "v2");
  assert.equal("类型" in result.version ? result.version.类型 : null, "个人版本");
});

test("agent reads a review version by id with 类型=点评版 and its 点评录音 digest", async () => {
  const state = reviewedWorkspace();
  const { db, reviewQueries } = agentDb(state, [GENERATED_DIGEST]);
  const result = await getAgentVideoAnalysis(db, "video1", { kind: "ID", id: "v3" }, "raw");
  assert.equal("类型" in result.version ? result.version.类型 : null, "点评版");
  assert.deepEqual("点评录音" in result.version ? result.version.点评录音 : null, {
    录音时长: "12:34",
    意见: [{ 序号: 1, 类型: "总体", 摘要: "母题看浅了" }, { 序号: 2, 类型: "具体", 摘要: "井盖里钻出来的是警察" }],
  });
  assert.deepEqual(reviewQueries, [["arv_1"]]);
});

test("agent version summaries: personal versions never query audio_reviews, and an ungenerated review gets no digest", async () => {
  const { db, calls } = scriptedDb([], { permissive: true });
  const [v1, , v3] = reviewedWorkspace().versions;
  assert.equal((await loadAgentReviewDigests(db, [v1])).size, 0);
  assert.equal(calls.length, 0, "no review version, no query");
  const personal = agentVersionSummary(v1);
  assert.equal(personal.类型, "个人版本");
  assert.ok(!("点评录音" in personal));
  const withoutDigest = agentVersionSummary(v3, new Map());
  assert.equal(withoutDigest.类型, "点评版");
  assert.ok(!("点评录音" in withoutDigest), "查不到就不附");
  // 时长缺失时给 null，意见照样给。
  const digests = await loadAgentReviewDigests(agentDb(world(), [{ ...GENERATED_DIGEST, audio_duration_ms: null }]).db, [v3]);
  assert.equal(digests.get("arv_1")?.录音时长, null);
  assert.equal(digests.get("arv_1")?.意见.length, 2);
});

test("agent read code stays read-only and the guide and docs/23 explain review versions", async () => {
  const video = codeOnly(await source("../lib/agent-api/video-read.ts"));
  assert.match(video, /resolveV19DefaultVersion\(rows\.map\(\(r\) => \(\{[\s\S]*kind: r\.version_kind/);
  assert.doesNotMatch(video, /\b(INSERT|UPDATE|DELETE)\b\s/);
  const guide = buildAgentGuideMarkdown("");
  for (const text of ["`类型`", "`个人版本`", "`点评版`", "`点评录音`", "录音时长", "不计入 `versionCount`", "不含点评版"]) {
    assert.ok(guide.includes(text), `guide must mention ${text}`);
  }
  const docs = await source("../../docs/23_外部Agent只读API_V0.1.md");
  for (const text of ["`类型`", "点评版", "点评录音", "不含点评版"]) assert.ok(docs.includes(text), `docs/23 must mention ${text}`);
});

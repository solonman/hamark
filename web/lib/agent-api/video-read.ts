// 外部 Agent 读取视频案例与拆解作业（V1.9 每人一版 + 集成版）。只读：只有 SELECT，
// 以及复用 loadFinalVersion / loadV19VersionChain 这两个本来就不写库的读路径。
// 见 docs/23_外部Agent只读API_V0.1.md 三、接口。

import { getVideoBucket, type DbClient, type QueryResultRow } from "@/db";
import { V04_WORKFLOW_VERSION, type V04DraftPayloadV1 } from "@/lib/v04-contract";
import { emptyV04DraftPayload, hashV04Payload } from "@/lib/v04-domain";
import {
  listVersionRows,
  loadV19VersionChain,
  parseJsonPayload,
  resolveV19DefaultVersion,
  workspaceForVideo,
  type AnalysisVersionRow,
} from "@/lib/v19-version-chain";
import { loadFinalVersion } from "@/lib/final-version";
import {
  AGENT_MEDIA_URL_TTL_SECONDS,
  AgentApiError,
  isoOrNull,
  likePattern,
  tagsFromJson,
  type AgentListQuery,
  type AgentPayloadFormat,
  type AgentVersionSelector,
} from "./params";
import { toReadableVideoAnalysis } from "./readable";


// 与站内案例库同一口径：业务数据、未删除、不在回收站、资产完好、已上传完成。
const VISIBLE_VIDEO_WHERE = `v.deleted_at IS NULL
  AND COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS'
  AND COALESCE(v.deletion_state, 'ACTIVE') = 'ACTIVE'
  AND v.status = 'READY'`;

type VideoRow = QueryResultRow & {
  id: string;
  title: string;
  brand: string;
  description: string;
  tags_json: string;
  object_key: string | null;
  thumbnail_key: string | null;
  content_type: string;
  file_size: number;
  created_by_name: string;
  created_at: string;
};

type VideoListRow = VideoRow & {
  version_count: number | string | null;
  last_version_at: Date | string | null;
  final_status: "OPEN" | "DONE" | null;
  final_done_at: Date | string | null;
  final_updated_at: Date | string | null;
  total_count: number | string;
};

function analysisSummary(row: VideoListRow) {
  const versionCount = Number(row.version_count ?? 0);
  return {
    versionCount,
    lastVersionUpdatedAt: isoOrNull(row.last_version_at),
    // 有真实版本却还没物化集成版行时，集成版是内存里算出来的虚拟版，状态恒为未定稿。
    finalStatus: row.final_status ?? (versionCount > 0 ? "OPEN" : null),
    finalDoneAt: isoOrNull(row.final_done_at),
    finalUpdatedAt: isoOrNull(row.final_updated_at),
  };
}

function caseFields(row: VideoRow) {
  return {
    id: row.id,
    title: row.title,
    brand: row.brand,
    description: row.description,
    tags: tagsFromJson(row.tags_json),
    uploaderName: row.created_by_name,
    createdAt: isoOrNull(row.created_at),
  };
}

export async function listAgentVideos(db: DbClient, query: AgentListQuery) {
  const where = [VISIBLE_VIDEO_WHERE];
  const binds: Array<string | number> = [V04_WORKFLOW_VERSION];
  if (query.q) {
    where.push(`(v.title ILIKE ? OR v.brand ILIKE ? OR v.tags_json ILIKE ?)`);
    const pattern = likePattern(query.q);
    binds.push(pattern, pattern, pattern);
  }
  if (query.hasAnalysis) where.push(`COALESCE(stats.version_count, 0) > 0`);
  if (query.updatedSince) {
    where.push(`GREATEST(stats.last_version_at, f.updated_at) >= ?::timestamptz`);
    binds.push(query.updatedSince);
  }
  binds.push(query.limit, query.offset);

  const { results } = await db.prepare(
    `SELECT v.id, v.title, v.brand, v.description, v.tags_json,
      NULL AS object_key, to_jsonb(v)->>'thumbnail_key' AS thumbnail_key,
      v.content_type, v.file_size, v.created_by_name, v.created_at,
      stats.version_count, stats.last_version_at,
      f.status AS final_status, f.done_at AS final_done_at, f.updated_at AS final_updated_at,
      COUNT(*) OVER () AS total_count
    FROM videos v
    LEFT JOIN collaboration_workspaces w ON w.video_id = v.id AND w.workflow_version = ?
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS version_count, MAX(av.updated_at) AS last_version_at
      FROM analysis_versions av WHERE av.workspace_id = w.id
    ) stats ON TRUE
    LEFT JOIN analysis_final_versions f ON f.workspace_id = w.id
    WHERE ${where.join("\n      AND ")}
    ORDER BY v.created_at DESC, v.id ASC
    LIMIT ? OFFSET ?`,
  ).bind(...binds).all<VideoListRow>();

  return {
    total: results.length ? Number(results[0].total_count) : 0,
    limit: query.limit,
    offset: query.offset,
    videos: results.map((row) => ({ ...caseFields(row), analysis: analysisSummary(row) })),
  };
}

async function requireVisibleVideo(db: DbClient, videoId: string) {
  const row = await db.prepare(
    `SELECT v.id, v.title, v.brand, v.description, v.tags_json, v.object_key,
      to_jsonb(v)->>'thumbnail_key' AS thumbnail_key,
      v.content_type, v.file_size, v.created_by_name, v.created_at
    FROM videos v WHERE v.id = ? AND ${VISIBLE_VIDEO_WHERE}`,
  ).bind(videoId).first<VideoRow>();
  if (!row) throw new AgentApiError(404, "CASE_NOT_FOUND", "案例不存在。");
  return row;
}

function versionSummary(row: AnalysisVersionRow) {
  return {
    id: row.id,
    number: Number(row.version_number),
    ownerName: row.owner_name_snapshot,
    baseNumber: row.base_version_number == null ? null : Number(row.base_version_number),
    baseIsFinal: Boolean(row.base_is_final),
    createdAt: isoOrNull(row.created_at),
    updatedAt: isoOrNull(row.updated_at),
  };
}

export async function getAgentVideo(db: DbClient, videoId: string) {
  const video = await requireVisibleVideo(db, videoId);
  const workspace = await workspaceForVideo(db, videoId);
  const rows = workspace ? await listVersionRows(db, workspace.id) : [];
  const final = workspace && rows.length ? await loadFinalVersion(db, workspace) : null;

  const bucket = getVideoBucket();
  const sign = (key: string | null) =>
    key ? bucket.createPresignedGetUrl(key, { expiresInSeconds: AGENT_MEDIA_URL_TTL_SECONDS }) : Promise.resolve(null);
  const [videoUrl, thumbnailUrl] = await Promise.all([sign(video.object_key), sign(video.thumbnail_key)]);

  return {
    case: caseFields(video),
    media: {
      videoUrl,
      thumbnailUrl,
      contentType: video.content_type,
      fileSize: Number(video.file_size),
      expiresInSeconds: AGENT_MEDIA_URL_TTL_SECONDS,
    },
    versions: rows.map(versionSummary),
    final: final
      ? {
          status: final.status,
          doneAt: isoOrNull(final.doneAt),
          doneByName: final.doneByName,
          updatedAt: isoOrNull(final.updatedAt),
          pendingCount: final.pendingCount,
          isVirtual: final.isVirtual,
        }
      : null,
  };
}

function shapePayload(payload: V04DraftPayloadV1, format: AgentPayloadFormat) {
  return {
    payloadSchemaVersion: payload.contract?.payloadSchemaVersion ?? null,
    ...(format !== "readable" ? { payload } : {}),
    ...(format !== "raw" ? { readable: toReadableVideoAnalysis(payload) } : {}),
  };
}

export async function getAgentVideoAnalysis(
  db: DbClient,
  videoId: string,
  selector: AgentVersionSelector,
  format: AgentPayloadFormat,
) {
  const video = await requireVisibleVideo(db, videoId);
  const caseRef = { id: video.id, title: video.title, brand: video.brand };
  const workspace = await workspaceForVideo(db, videoId);
  const rows = workspace ? await listVersionRows(db, workspace.id) : [];

  if (rows.length === 0) {
    // 还没人在 V1.9 工作台保存过：工作台此时展示的是由旧工作稿（若有）生成的虚拟 v1，
    // 这里给出同一份内容；连旧工作稿也没有就是真的还没拆。
    if (selector.kind === "ID") throw new AgentApiError(404, "VERSION_NOT_FOUND", "指定的版本不存在。");
    const chain = await loadV19VersionChain(db, videoId, {
      userId: "agent", identityKey: "agent", displayName: "", sessionId: "", requestId: "",
    });
    if (chain.current.contentHash === hashV04Payload(emptyV04DraftPayload())) {
      throw new AgentApiError(404, "NO_ANALYSIS", "这条案例还没有拆解内容。");
    }
    return {
      case: caseRef,
      version: {
        kind: "VIRTUAL_V1" as const,
        id: null,
        number: 1,
        ownerName: chain.current.ownerName,
        updatedAt: isoOrNull(chain.current.updatedAt),
        contentHash: chain.current.contentHash,
      },
      ...shapePayload(chain.current.payload, format),
    };
  }

  if (selector.kind === "FINAL") {
    const final = await loadFinalVersion(db, workspace!);
    return {
      case: caseRef,
      version: {
        kind: "FINAL" as const,
        id: final.id,
        label: "集成版",
        status: final.status,
        doneAt: isoOrNull(final.doneAt),
        doneByName: final.doneByName,
        pendingCount: final.pendingCount,
        isVirtual: final.isVirtual,
        updatedAt: isoOrNull(final.updatedAt),
        revision: final.revision,
        contentHash: final.contentHash,
      },
      ...shapePayload(final.payload, format),
    };
  }

  let row: AnalysisVersionRow | null;
  if (selector.kind === "LATEST") {
    const latest = resolveV19DefaultVersion(rows.map((r) => ({
      id: r.id, number: Number(r.version_number), updatedAt: isoOrNull(r.updated_at) ?? "",
    })));
    row = rows.find((r) => r.id === latest.id) ?? null;
  } else {
    // 只在这条案例自己的版本里找：别的案例的版本 id 在这里一律当不存在。
    row = rows.find((r) => r.id === selector.id) ?? null;
  }
  if (!row) throw new AgentApiError(404, "VERSION_NOT_FOUND", "指定的版本不存在。");

  return {
    case: caseRef,
    version: {
      kind: "VERSION" as const,
      ...versionSummary(row),
      revision: Number(row.revision),
      contentHash: row.content_hash,
    },
    ...shapePayload(parseJsonPayload(row.payload_json), format),
  };
}

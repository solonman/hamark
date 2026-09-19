"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { readJsonResponse } from "@/lib/http-json";
import { createThumbnailFromVideoFile } from "@/app/components/video-thumbnail";
import {
  VISUAL_FILE_ACCEPT,
  VISUAL_LIMITS,
  VISUAL_SUBDOMAINS,
  VISUAL_SUBDOMAIN_SPECS,
  classifyVisualFile,
  isHeicLike,
  parseVisualTags,
  type VisualAssetType,
  type VisualCaseDetail,
  type VisualCaseFieldsInput,
  type VisualCompleteResponse,
  type VisualCreateResponse,
  type VisualMetadata,
  type VisualNewAssetInput,
  type VisualSubdomain,
  type VisualUploadUrlResponse,
} from "@/lib/visual-contract";
import {
  aggregateUploadPercent,
  countAssetsByType,
  countCompletedUploads,
  countFilledMetadata,
  formatUploadProgressLabel,
  pruneVisualMetadata,
  remainingVisualSlots,
  validateVisualDraft,
} from "@/lib/visual-ui";
import report from "../report/library/ReportLibrary.module.css";
import styles from "./Visual.module.css";

export type VisualUploadDialogMode = "create" | "edit" | "resume";

/** 未登录时后端会先一步 401，跟视频/报告上传对话框一样直接带回登录页。 */
function redirectOnUnauthorized(response: Response): boolean {
  if (response.status === 401) {
    window.location.assign(`/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    return true;
  }
  return false;
}

function putFile(url: string, file: File, onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) { onProgress(file.size); resolve(); }
      else reject(new Error("文件上传失败，请重试。"));
    });
    request.addEventListener("error", () => reject(new Error("文件上传失败，请检查网络后重试。")));
    request.send(file);
  });
}

/** 同时传 3 个（规格 6.4）。 */
async function runWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function pull(): Promise<void> {
    const index = cursor;
    cursor += 1;
    if (index >= items.length) return;
    await worker(items[index]);
    return pull();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => pull()));
}

function readImageDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

function readVideoMetadata(file: File): Promise<{ durationSeconds: number; width: number; height: number }> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const objectUrl = URL.createObjectURL(file);
    const finish = (value: { durationSeconds: number; width: number; height: number }) => {
      URL.revokeObjectURL(objectUrl);
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => finish({
      durationSeconds: Number.isFinite(video.duration) ? Math.round(video.duration) : 0,
      width: video.videoWidth || 0,
      height: video.videoHeight || 0,
    });
    video.onerror = () => finish({ durationSeconds: 0, width: 0, height: 0 });
    video.src = objectUrl;
    video.load();
  });
}

// ---------------------------------------------------------------------------
// 草稿里的素材：existing（编辑/继续上传时已经在服务端的）与 new（这次对话框里新选的）。
// ---------------------------------------------------------------------------

type ExistingDraftAsset = {
  kind: "existing";
  assetId: string;
  type: VisualAssetType;
  originalName: string;
  thumbnailUrl: string | null;
  ready: boolean;
  fileSize: number;
  durationSeconds: number;
};

type NewDraftAsset = {
  kind: "new";
  localId: string;
  type: VisualAssetType;
  file: File;
  coverFile: File | null;
  previewUrl: string | null;
  originalName: string;
  contentType: string;
  fileSize: number;
  durationSeconds: number;
  width: number;
  height: number;
};

type DraftAsset = ExistingDraftAsset | NewDraftAsset;

type Draft = {
  subdomain: VisualSubdomain | "";
  title: string;
  location: string;
  tagsText: string;
  textBody: string;
  creator: string;
  occurredAt: string;
  sourceUrl: string;
  summary: string;
  rightsNote: string;
  metadata: VisualMetadata;
  assets: DraftAsset[];
};

function blankDraft(): Draft {
  return {
    subdomain: "", title: "", location: "", tagsText: "", textBody: "",
    creator: "", occurredAt: "", sourceUrl: "", summary: "", rightsNote: "仅公司内部学习使用",
    metadata: {}, assets: [],
  };
}

function draftFromDetail(detail: VisualCaseDetail): Draft {
  return {
    subdomain: detail.subdomain,
    title: detail.title,
    location: detail.location,
    tagsText: detail.tags.join(", "),
    textBody: detail.textBody,
    creator: detail.creator,
    occurredAt: detail.occurredAt,
    sourceUrl: detail.sourceUrl,
    summary: detail.summary,
    rightsNote: detail.rightsNote,
    metadata: JSON.parse(JSON.stringify(detail.metadata)) as VisualMetadata,
    assets: [...detail.assets]
      .sort((a, b) => a.position - b.position)
      .map((asset): ExistingDraftAsset => ({
        kind: "existing",
        assetId: asset.id,
        type: asset.type,
        originalName: asset.originalName,
        thumbnailUrl: asset.thumbnailUrl,
        ready: asset.uploadStatus === "READY",
        fileSize: asset.fileSize,
        durationSeconds: asset.durationSeconds,
      })),
  };
}

function fmtDur(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 60))}:${pad(Math.round(seconds) % 60)}`;
}

type MissingItem = {
  assetId: string;
  originalName: string;
  type: VisualAssetType;
  /** 同一次会话里刚失败的，还留着原始文件可以直接重传；「继续上传」重新打开的没有，需要重新选文件。 */
  file: File | null;
};

/** 从详情里挑出没传完的素材，构造「有几个没传上」这一步要用的列表（没有本地 File）。 */
function missingFromDetail(detail: VisualCaseDetail): MissingItem[] {
  return detail.assets
    .filter((asset) => asset.uploadStatus !== "READY")
    .map((asset) => ({ assetId: asset.id, originalName: asset.originalName, type: asset.type, file: null }));
}

type Phase = "loading" | "form" | "uploading" | "partial";

export default function VisualUploadDialog({
  mode,
  caseId,
  initialDetail,
  onClose,
  onCreated,
  onSaved,
  notify,
}: {
  mode: VisualUploadDialogMode;
  /** edit / resume 必填（没有 initialDetail 时用它去读详情）。 */
  caseId?: string;
  /** 调用方已经有详情数据时直接给（详情页打开编辑/继续上传都是这种情况），省一次网络往返。 */
  initialDetail?: VisualCaseDetail;
  onClose: () => void;
  /** mode="create" 成功；hasImage 供调用方决定提示文案要不要带「预览生成后自动出现」。 */
  onCreated: (caseId: string, hasImage: boolean) => void;
  /** mode="edit"｜"resume" 成功；addedImage 供调用方决定提示文案要不要带「新图片的预览…」。 */
  onSaved: (caseId: string, addedImage: boolean) => void;
  /** 调用方（VisualLibrary／VisualCaseClient）自己的 useLibraryToast，选文件时的提示走这一个，不另开一份。 */
  notify: (message: string, tone?: "plain" | "warn") => void;
}) {
  const titleId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refillInputRef = useRef<HTMLInputElement>(null);
  const objectUrlsRef = useRef(new Set<string>());

  const [phase, setPhase] = useState<Phase>(mode === "create" ? "form" : initialDetail ? (mode === "resume" ? "partial" : "form") : "loading");
  const [loadError, setLoadError] = useState("");
  const [detail, setDetail] = useState<VisualCaseDetail | null>(initialDetail ?? null);
  const [resolvedCaseId, setResolvedCaseId] = useState(caseId ?? initialDetail?.id ?? "");
  const [draft, setDraft] = useState<Draft>(() => (initialDetail ? draftFromDetail(initialDetail) : blankDraft()));
  const [dirty, setDirty] = useState(false);
  const [fold, setFold] = useState(mode === "edit");
  const [error, setError] = useState("");
  const formErrorRef = useRef<HTMLParagraphElement>(null);

  const [progressMap, setProgressMap] = useState<Record<string, { size: number; loaded: number; name: string }>>({});
  const [activeUploadName, setActiveUploadName] = useState("");

  const [missing, setMissing] = useState<MissingItem[]>(() => (
    initialDetail && mode === "resume" ? missingFromDetail(initialDetail) : []
  ));
  const [totalAssetsAtSubmit, setTotalAssetsAtSubmit] = useState(() => (
    initialDetail && mode === "resume" ? initialDetail.assets.length : 0
  ));

  const editing = mode === "edit";

  // resume / edit 且没有现成 detail 时，先读一次。
  useEffect(() => {
    if (initialDetail || mode === "create") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 响应 caller 传入的 mode/caseId 组合是否有效，不是渲染期能算出的派生状态；调用方给错参数时直接在这里报错退回表单态
    if (!caseId) { setLoadError("缺少案例编号，无法继续。"); setPhase("form"); return; }
    const controller = new AbortController();
    void fetch(`/api/visual-cases/${encodeURIComponent(caseId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (redirectOnUnauthorized(response)) return;
        const data = await readJsonResponse<{ case?: VisualCaseDetail; error?: string }>(response, "读取案例详情");
        if (!response.ok || !data.case) throw new Error(data.error || "案例详情读取失败。");
        if (controller.signal.aborted) return;
        setDetail(data.case);
        setResolvedCaseId(data.case.id);
        setDraft(draftFromDetail(data.case));
        if (mode === "resume") {
          setMissing(missingFromDetail(data.case));
          setTotalAssetsAtSubmit(data.case.assets.length);
          setPhase("partial");
        } else {
          setPhase("form");
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(reason instanceof Error ? reason.message : "案例详情读取失败。");
        setPhase("form");
      });
    return () => controller.abort();
  }, [mode, caseId, initialDetail]);

  // 卸载时回收所有 object URL，别漏内存。
  useEffect(() => () => { objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url)); }, []);

  function trackObjectUrl(url: string): string {
    objectUrlsRef.current.add(url);
    return url;
  }

  const counts = useMemo(() => countAssetsByType(draft.assets), [draft.assets]);
  const remaining = useMemo(() => remainingVisualSlots(counts), [counts]);
  const fields = draft.subdomain ? VISUAL_SUBDOMAIN_SPECS[draft.subdomain].fields : [];
  const filledMeta = countFilledMetadata(draft.subdomain, draft.metadata);

  function markDirty() { setDirty(true); }

  // -------------------------------------------------------------------------
  // 选文件
  // -------------------------------------------------------------------------

  async function handleFilesPicked(fileList: FileList | null) {
    if (!fileList || !fileList.length) return;
    const files = Array.from(fileList);
    let room = { ...remaining };
    let skippedVideos = 0;
    let skippedImages = 0;
    const accepted: NewDraftAsset[] = [];
    for (const file of files) {
      const type = classifyVisualFile(file.name, file.type);
      if (!type) {
        notify(`不支持这种文件：${file.name}`);
        continue;
      }
      if (type === "VIDEO") {
        if (room.videos <= 0) { skippedVideos += 1; continue; }
        room = { ...room, videos: room.videos - 1 };
      } else {
        if (room.images <= 0) { skippedImages += 1; continue; }
        room = { ...room, images: room.images - 1 };
      }
      if (type === "IMAGE") {
        const previewUrl = trackObjectUrl(URL.createObjectURL(file));
        const dims = await readImageDimensions(previewUrl);
        accepted.push({
          kind: "new", localId: `n${crypto.randomUUID()}`, type: "IMAGE", file, coverFile: null,
          previewUrl, originalName: file.name, contentType: file.type, fileSize: file.size,
          durationSeconds: 0, width: dims.width, height: dims.height,
        });
      } else {
        const meta = await readVideoMetadata(file);
        let coverFile: File | null = null;
        try { coverFile = await createThumbnailFromVideoFile(file); } catch { /* 截封面失败也允许上传，只是没有封面 */ }
        const previewUrl = coverFile ? trackObjectUrl(URL.createObjectURL(coverFile)) : null;
        accepted.push({
          kind: "new", localId: `n${crypto.randomUUID()}`, type: "VIDEO", file, coverFile,
          previewUrl, originalName: file.name, contentType: file.type, fileSize: file.size,
          durationSeconds: meta.durationSeconds, width: meta.width, height: meta.height,
        });
      }
    }
    if (skippedVideos > 0) notify(`单条案例最多 ${VISUAL_LIMITS.videos} 段视频`, "warn");
    if (skippedImages > 0) notify(`单条案例最多 ${VISUAL_LIMITS.images} 张图片，多出来的没有加进来`, "warn");
    if (accepted.length) {
      setDraft((current) => ({ ...current, assets: [...current.assets, ...accepted] }));
      markDirty();
    }
  }

  // -------------------------------------------------------------------------
  // 素材格：设为封面／挪动／移除
  // -------------------------------------------------------------------------

  function moveAsset(index: number, kind: "cover" | "left" | "right" | "remove") {
    setDraft((current) => {
      const list = [...current.assets];
      if (kind === "remove") {
        list.splice(index, 1);
      } else if (kind === "cover" && index > 0) {
        const [item] = list.splice(index, 1);
        list.unshift(item);
      } else if (kind === "left" && index > 0) {
        [list[index - 1], list[index]] = [list[index], list[index - 1]];
      } else if (kind === "right" && index < list.length - 1) {
        [list[index + 1], list[index]] = [list[index], list[index + 1]];
      }
      return { ...current, assets: list };
    });
    markDirty();
  }

  // -------------------------------------------------------------------------
  // 表单字段
  // -------------------------------------------------------------------------

  function setSubdomain(next: VisualSubdomain | "") {
    setDraft((current) => ({
      ...current,
      subdomain: next,
      metadata: pruneVisualMetadata(next, current.metadata),
    }));
    markDirty();
  }

  function setMetaOne(key: string, value: string) {
    setDraft((current) => ({ ...current, metadata: { ...current.metadata, [key]: value } }));
    markDirty();
  }

  function toggleMetaMany(key: string, value: string) {
    setDraft((current) => {
      const existing = current.metadata[key];
      const list = Array.isArray(existing) ? [...existing] : [];
      const index = list.indexOf(value);
      if (index >= 0) list.splice(index, 1); else list.push(value);
      return { ...current, metadata: { ...current.metadata, [key]: list } };
    });
    markDirty();
  }

  // -------------------------------------------------------------------------
  // 提交
  // -------------------------------------------------------------------------

  function buildFields(): VisualCaseFieldsInput {
    return {
      subdomain: draft.subdomain as VisualSubdomain,
      title: draft.title.trim(),
      location: draft.location.trim(),
      tags: parseVisualTags(draft.tagsText),
      textBody: draft.textBody,
      creator: draft.creator.trim(),
      occurredAt: draft.occurredAt.trim(),
      sourceUrl: draft.sourceUrl.trim(),
      summary: draft.summary.trim(),
      rightsNote: draft.rightsNote.trim() || "仅公司内部学习使用",
      metadata: pruneVisualMetadata(draft.subdomain, draft.metadata),
    };
  }

  function updateProgress(key: string, size: number, name: string, loaded: number) {
    setProgressMap((current) => ({ ...current, [key]: { size, loaded, name } }));
    setActiveUploadName(name);
  }

  async function uploadNewAssets(targetCaseId: string, tasks: Array<{ key: string; assetId: string; asset: NewDraftAsset }>): Promise<string[]> {
    const failedIds: string[] = [];
    const initialProgress: Record<string, { size: number; loaded: number; name: string }> = {};
    for (const task of tasks) {
      initialProgress[task.key] = {
        size: task.asset.fileSize + (task.asset.coverFile?.size ?? 0),
        loaded: 0,
        name: task.asset.originalName,
      };
    }
    setProgressMap(initialProgress);
    setActiveUploadName(tasks[0]?.asset.originalName ?? "");
    await runWithConcurrency(tasks, 3, async (task) => {
      try {
        const signResponse = await fetch(
          `/api/visual-cases/${encodeURIComponent(targetCaseId)}/assets/${encodeURIComponent(task.assetId)}/upload-url`,
          { method: "POST", cache: "no-store" },
        );
        if (redirectOnUnauthorized(signResponse)) return;
        const signed = await readJsonResponse<VisualUploadUrlResponse & { error?: string }>(signResponse, "获取上传地址");
        if (!signResponse.ok || !signed.uploadUrl) throw new Error(signed.error || "获取上传地址失败");
        let coverLoaded = 0;
        await putFile(signed.uploadUrl, task.asset.file, (loaded) => {
          updateProgress(task.key, task.asset.fileSize + (task.asset.coverFile?.size ?? 0), task.asset.originalName, loaded + coverLoaded);
        });
        if (task.asset.coverFile && signed.coverUploadUrl) {
          const coverUrl = signed.coverUploadUrl;
          await putFile(coverUrl, task.asset.coverFile, (loaded) => {
            coverLoaded = loaded;
            updateProgress(task.key, task.asset.fileSize + task.asset.coverFile!.size, task.asset.originalName, task.asset.fileSize + loaded);
          });
        }
      } catch {
        failedIds.push(task.assetId);
      }
    });
    return failedIds;
  }

  async function callComplete(targetCaseId: string): Promise<VisualCompleteResponse & { error?: string }> {
    const response = await fetch(`/api/visual-cases/${encodeURIComponent(targetCaseId)}/complete`, { method: "POST", cache: "no-store" });
    redirectOnUnauthorized(response);
    return readJsonResponse<VisualCompleteResponse & { error?: string }>(response, "确认上传完成");
  }

  function enterPartial(targetCaseId: string, missingIds: string[], assetLookup: Map<string, { originalName: string; type: VisualAssetType; file: File | null }>, total: number) {
    setResolvedCaseId(targetCaseId);
    setMissing(missingIds.map((id) => {
      const found = assetLookup.get(id);
      return { assetId: id, originalName: found?.originalName ?? id, type: found?.type ?? "IMAGE", file: found?.file ?? null };
    }));
    setTotalAssetsAtSubmit(total);
    setPhase("partial");
  }

  async function submitCreate() {
    const fields = buildFields();
    const assets: VisualNewAssetInput[] = draft.assets.map((asset) => (
      asset.kind === "new"
        ? { type: asset.type, originalName: asset.originalName, contentType: asset.contentType, fileSize: asset.fileSize, durationSeconds: asset.durationSeconds, width: asset.width, height: asset.height }
        : { type: asset.type, originalName: asset.originalName, contentType: "application/octet-stream", fileSize: asset.fileSize }
    ));
    const response = await fetch("/api/visual-cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...fields, assets }),
    });
    if (redirectOnUnauthorized(response)) return;
    const created = await readJsonResponse<VisualCreateResponse & { error?: string }>(response, "建立案例");
    if (!response.ok || !created.caseId) throw new Error(created.error || "无法建立案例。");

    const newOnes = draft.assets.filter((asset): asset is NewDraftAsset => asset.kind === "new");
    const tasks = newOnes.map((asset, index) => ({ key: asset.localId, assetId: created.assetIds[index], asset }));
    setPhase("uploading");
    await uploadNewAssets(created.caseId, tasks);

    const complete = await callComplete(created.caseId);
    if (complete.status === "READY") {
      onCreated(created.caseId, draft.assets.some((asset) => asset.type === "IMAGE"));
      return;
    }
    const lookup = new Map(tasks.map((task) => [task.assetId, { originalName: task.asset.originalName, type: task.asset.type, file: task.asset.file }]));
    enterPartial(created.caseId, complete.missing ?? [], lookup, draft.assets.length);
  }

  async function submitEdit() {
    if (!detail) return;
    const targetCaseId = detail.id;

    // 顺序：先 POST /assets 追加新素材，再 DELETE 被移除的素材，最后才 PATCH。
    // 反过来（先删后加）在「把全部旧素材都换掉」这种编辑里会踩空：案例只剩旧素材时，
    // 服务端拒绝删光最后一个素材（400「至少要保留一段视频或一张图片。」），因为那一刻
    // 新素材还没建好，案例眼看着就要变成零素材。新素材先落地，案例任何时候都至少有
    // 一个素材在，删除才总能成功。
    const newOnes = draft.assets.filter((asset): asset is NewDraftAsset => asset.kind === "new");
    let newAssetIds: string[] = [];
    if (newOnes.length) {
      const addResponse = await fetch(`/api/visual-cases/${encodeURIComponent(targetCaseId)}/assets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assets: newOnes.map((asset) => ({
            type: asset.type, originalName: asset.originalName, contentType: asset.contentType,
            fileSize: asset.fileSize, durationSeconds: asset.durationSeconds, width: asset.width, height: asset.height,
          })),
        }),
      });
      if (redirectOnUnauthorized(addResponse)) return;
      const added = await readJsonResponse<{ assetIds?: string[]; error?: string }>(addResponse, "追加素材");
      if (!addResponse.ok || !added.assetIds) throw new Error(added.error || "追加素材失败，请重试。");
      newAssetIds = added.assetIds;
    }

    const removedIds = detail.assets
      .filter((asset) => !draft.assets.some((item) => item.kind === "existing" && item.assetId === asset.id))
      .map((asset) => asset.id);
    for (const assetId of removedIds) {
      const response = await fetch(`/api/visual-cases/${encodeURIComponent(targetCaseId)}/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" });
      if (redirectOnUnauthorized(response)) return;
      if (!response.ok) {
        const body = await readJsonResponse<{ error?: string }>(response, "移除素材").catch(() => ({ error: undefined }));
        throw new Error(body.error || "移除素材失败，请重试。");
      }
    }

    const idByLocalId = new Map(newOnes.map((asset, index) => [asset.localId, newAssetIds[index]]));
    // PATCH 的 assetOrder 必须恰好是这条案例此刻全部素材 id 的一个排列（按对话框里的顺序）。
    const assetOrder = draft.assets.map((asset) => (asset.kind === "existing" ? asset.assetId : idByLocalId.get(asset.localId)!));

    const fields = buildFields();
    const patchResponse = await fetch(`/api/visual-cases/${encodeURIComponent(targetCaseId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...fields, updatedAt: detail.updatedAt, assetOrder }),
    });
    if (redirectOnUnauthorized(patchResponse)) return;
    const patched = await readJsonResponse<{ error?: string }>(patchResponse, "保存案例");
    if (!patchResponse.ok) throw new Error(patched.error || "保存失败，请重试。");

    const tasks = newOnes.map((asset) => ({ key: asset.localId, assetId: idByLocalId.get(asset.localId)!, asset }));
    if (tasks.length) {
      setPhase("uploading");
      await uploadNewAssets(targetCaseId, tasks);
    }

    const complete = await callComplete(targetCaseId);
    const addedImage = newOnes.some((asset) => asset.type === "IMAGE");
    if (complete.status === "READY") {
      onSaved(targetCaseId, addedImage);
      return;
    }
    const lookup = new Map(tasks.map((task) => [task.assetId, { originalName: task.asset.originalName, type: task.asset.type, file: task.asset.file }]));
    enterPartial(targetCaseId, complete.missing ?? [], lookup, assetOrder.length);
  }

  async function handleSubmit() {
    const validationError = validateVisualDraft(
      { assetCount: draft.assets.length, subdomain: draft.subdomain, title: draft.title, location: draft.location, tagsText: draft.tagsText, sourceUrl: draft.sourceUrl },
      editing,
    );
    if (validationError) {
      setError(validationError);
      if (validationError.startsWith("来源链接")) setFold(true);
      requestAnimationFrame(() => formErrorRef.current?.scrollIntoView({ block: "nearest" }));
      return;
    }
    setError("");
    try {
      if (editing) await submitEdit();
      else await submitCreate();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "提交失败，请重试。");
      setPhase("form");
    }
  }

  // -------------------------------------------------------------------------
  // 「有几个文件没传上」这一步
  // -------------------------------------------------------------------------

  async function retryMissing() {
    const withoutFile = missing.filter((item) => !item.file);
    if (withoutFile.length) {
      refillInputRef.current?.click();
      return;
    }
    await retryMissingWithFiles(missing);
  }

  async function retryMissingWithFiles(items: MissingItem[]) {
    const targetCaseId = resolvedCaseId;
    if (!targetCaseId) return;
    setPhase("uploading");
    const readyItems = items.filter((item): item is MissingItem & { file: File } => Boolean(item.file));
    const tasks = readyItems.map((item) => ({
      key: item.assetId, assetId: item.assetId,
      asset: { localId: item.assetId, fileSize: item.file.size, coverFile: null, originalName: item.originalName, file: item.file } as unknown as NewDraftAsset,
    }));
    await uploadNewAssets(targetCaseId, tasks);
    const complete = await callComplete(targetCaseId);
    const hasImage = items.some((item) => item.type === "IMAGE");
    if (complete.status === "READY") {
      if (mode === "create") onCreated(targetCaseId, hasImage);
      else onSaved(targetCaseId, hasImage);
      return;
    }
    const lookup = new Map(items.map((item) => [item.assetId, { originalName: item.originalName, type: item.type, file: item.file }]));
    enterPartial(targetCaseId, complete.missing ?? [], lookup, totalAssetsAtSubmit);
  }

  async function handleRefillPicked(fileList: FileList | null) {
    if (!fileList) return;
    const withoutFile = missing.filter((item) => !item.file);
    const files = Array.from(fileList).slice(0, withoutFile.length);
    if (files.length < withoutFile.length) {
      notify(`还差 ${withoutFile.length - files.length} 个没选，先补上已选的这些。`, "warn");
    }
    let cursor = 0;
    const filled = missing.map((item) => {
      if (item.file) return item;
      const file = files[cursor];
      cursor += 1;
      if (!file) return item;
      const type = classifyVisualFile(file.name, file.type);
      if (!type) { notify(`不支持这种文件：${file.name}`); return item; }
      return { ...item, file };
    });
    setMissing(filled);
    if (filled.every((item) => item.file)) await retryMissingWithFiles(filled);
  }

  async function dropMissing() {
    const targetCaseId = resolvedCaseId;
    if (!targetCaseId) return;
    const remainingCount = totalAssetsAtSubmit - missing.length;
    if (remainingCount <= 0) {
      setError("去掉之后这条案例一个素材都不剩了，请重传，或者删掉这条案例。");
      return;
    }
    setError("");
    try {
      for (const item of missing) {
        const response = await fetch(`/api/visual-cases/${encodeURIComponent(targetCaseId)}/assets/${encodeURIComponent(item.assetId)}`, { method: "DELETE" });
        if (redirectOnUnauthorized(response)) return;
        if (!response.ok) {
          const body = await readJsonResponse<{ error?: string }>(response, "移除素材").catch(() => ({ error: undefined }));
          throw new Error(body.error || "移除素材失败，请重试。");
        }
      }
      const complete = await callComplete(targetCaseId);
      if (complete.status === "READY") {
        if (mode === "create") onCreated(targetCaseId, false);
        else onSaved(targetCaseId, false);
        return;
      }
      enterPartial(targetCaseId, complete.missing ?? [], new Map(), remainingCount);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "移除失败，请重试。");
    }
  }

  // -------------------------------------------------------------------------
  // 关闭规则：× 与「取消」随时关；点遮罩、Esc 只在空表单时关；上传中不给关。
  // -------------------------------------------------------------------------

  const canDismissLightly = phase === "form" && !dirty;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && canDismissLightly) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [canDismissLightly, onClose]);

  const dialogTitleText = phase === "uploading" ? "正在上传" : mode === "resume" ? "继续上传" : editing ? "编辑信息与素材" : "上传案例";
  const eyebrow = editing ? "EDIT" : mode === "resume" ? "RESUME" : "UPLOAD";

  return (
    <div className={styles.root}>
      <div
        className={report.uploadBackdrop}
        role="presentation"
        onMouseDown={(event) => { if (event.target === event.currentTarget && canDismissLightly) onClose(); }}
      >
        <section className={report.uploadDialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <div className={report.uploadHead}>
            <div><small>{eyebrow}</small><b id={titleId}>{dialogTitleText}</b></div>
            {phase === "uploading" ? null : (
              <button type="button" className={report.uploadClose} onClick={onClose} aria-label="关闭上传窗口">×</button>
            )}
          </div>

          {phase === "loading" ? (
            <div className={report.uploadBody}><p className={report.hint}>正在读取案例详情…</p></div>
          ) : phase === "uploading" ? (
            <div className={report.uploadBody}>
              <div className={report.uploadProgress}>
                <span>{formatUploadProgressLabel(countCompletedUploads(Object.values(progressMap)), Object.keys(progressMap).length || 1, activeUploadName)}</span>
                <b>{aggregateUploadPercent(Object.values(progressMap))}%</b>
                <div className={report.coverBar}><i className={report.coverBarFill} style={{ width: `${aggregateUploadPercent(Object.values(progressMap))}%` }} /></div>
                <span>逐个直传到对象存储，每个文件用自己的上传链接，不经服务器中转</span>
              </div>
            </div>
          ) : phase === "partial" ? (
            <>
              <div className={report.uploadBody}>
                <p className={report.hint}>
                  {detail ? `《${detail.title}》已经建好，但有 ${missing.length} 个文件没传上。` : `有 ${missing.length} 个文件没传上。`}
                  已经传好的不用重传；这条案例在补齐之前以「上传未完成」显示在库里，只有你和管理员能继续处理。
                </p>
                <ul className={styles.failList}>
                  {missing.map((item) => <li key={item.assetId}>{item.originalName}<span>没有传完</span></li>)}
                </ul>
                {error ? <p className={report.formError} role="alert">{error}</p> : null}
                <div className={styles.inlineActs}>
                  <button type="button" className={styles.primary} onClick={() => void retryMissing()}>重传这 {missing.length} 个</button>
                  <button type="button" onClick={() => void dropMissing()}>去掉它们，其余入库</button>
                </div>
                <input
                  ref={refillInputRef}
                  type="file"
                  accept={VISUAL_FILE_ACCEPT}
                  multiple
                  hidden
                  onChange={(event) => { void handleRefillPicked(event.target.files); event.target.value = ""; }}
                />
              </div>
              <div className={report.uploadFooter}><button type="button" onClick={onClose}>稍后再说</button></div>
            </>
          ) : (
            <>
              <div className={report.uploadBody}>
                {loadError ? <p className={report.formError} role="alert">{loadError}</p> : null}
                <button type="button" className={report.fileDrop} onClick={() => fileInputRef.current?.click()}>
                  <b>{draft.assets.length ? "继续添加视频或图片" : "选择视频或图片 *"}</b>
                  <span>可以一次选多个 · 视频不限格式与大小 · 图片收 JPG／PNG／WebP／HEIC</span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={VISUAL_FILE_ACCEPT}
                  multiple
                  hidden
                  onChange={(event) => { void handleFilesPicked(event.target.files); event.target.value = ""; }}
                />

                {draft.assets.length ? (
                  <div className={report.field}>
                    <small>素材 <i>视频 {counts.videos} / {VISUAL_LIMITS.videos} · 图片 {counts.images} / {VISUAL_LIMITS.images} · 按这个顺序展示，第一位就是列表封面</i></small>
                    <ul className={styles.mediaList}>
                      {draft.assets.map((asset, index) => {
                        const isCover = index === 0;
                        const missingUpload = asset.kind === "existing" && !asset.ready;
                        const oversized = asset.type === "IMAGE" && asset.fileSize > VISUAL_LIMITS.derivativeMaxBytes;
                        const heic = isHeicLike(asset.originalName, asset.kind === "new" ? asset.contentType : "");
                        const kindLabel = missingUpload
                          ? "没传完"
                          : asset.type === "VIDEO"
                            ? `视频 ${fmtDur(asset.durationSeconds)}`
                            : oversized
                              ? `${(asset.fileSize / 1024 / 1024).toFixed(1)} MB`
                              : heic ? "HEIC" : "图片";
                        const art = asset.kind === "existing" ? asset.thumbnailUrl : asset.previewUrl;
                        return (
                          <li key={asset.kind === "existing" ? asset.assetId : asset.localId} className={`${styles.mediaTile} ${isCover ? styles.isCover : ""}`.trim()} data-v04-scheme="dark">
                            {art ? <img className={styles.tileArt} src={art} alt="" /> : null}
                            {isCover ? <span className={styles.coverMark}>01 · 封面</span> : <span className={styles.idx}>{String(index + 1).padStart(2, "0")}</span>}
                            <span
                              className={`${styles.kind} ${oversized || missingUpload ? styles.bad : ""}`.trim()}
                              title={oversized ? "超过 20 MB：原图照样保存，但不会生成预览" : missingUpload ? "上次没传完，保存后可在详情页继续上传" : ""}
                            >
                              {kindLabel}
                            </span>
                            <div className={styles.tileActs}>
                              <button type="button" aria-label="设为封面（挪到第一位）" title="设为封面（挪到第一位）" disabled={index === 0} onClick={() => moveAsset(index, "cover")}>⤒</button>
                              <button type="button" aria-label="往前挪" title="往前挪" disabled={index === 0} onClick={() => moveAsset(index, "left")}>←</button>
                              <button type="button" aria-label="往后挪" title="往后挪" disabled={index === draft.assets.length - 1} onClick={() => moveAsset(index, "right")}>→</button>
                              <span className={styles.grow} />
                              <button type="button" aria-label="移除这个素材" title="移除" onClick={() => moveAsset(index, "remove")}>×</button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}

                <label className={report.field}>
                  <small>子领域 *</small>
                  <select
                    value={draft.subdomain}
                    onChange={(event) => setSubdomain(event.target.value as VisualSubdomain | "")}
                  >
                    <option value="">请选择</option>
                    {VISUAL_SUBDOMAINS.map((key) => (
                      <option key={key} value={key}>{VISUAL_SUBDOMAIN_SPECS[key].label}（{VISUAL_SUBDOMAIN_SPECS[key].hint}）</option>
                    ))}
                  </select>
                </label>

                <label className={report.field}>
                  <small>标题 *</small>
                  <input
                    maxLength={VISUAL_LIMITS.titleMax}
                    value={draft.title}
                    placeholder="现场是什么、做了一件什么事"
                    onChange={(event) => { setDraft((current) => ({ ...current, title: event.target.value })); markDirty(); }}
                  />
                </label>

                <div className={report.two}>
                  <label className={report.field}>
                    <small>采集地点 *</small>
                    <input
                      maxLength={VISUAL_LIMITS.locationMax}
                      value={draft.location}
                      placeholder="城市 · 场地，写到城市即可"
                      onChange={(event) => { setDraft((current) => ({ ...current, location: event.target.value })); markDirty(); }}
                    />
                  </label>
                  <label className={report.field}>
                    <small>标签 *</small>
                    <input
                      value={draft.tagsText}
                      placeholder="用逗号分开，至少一个"
                      onChange={(event) => { setDraft((current) => ({ ...current, tagsText: event.target.value })); markDirty(); }}
                    />
                  </label>
                </div>

                <label className={report.field}>
                  <small>案例简介 <i>选填，纯文本，保留换行；不能单独成为一条案例，至少要有一段视频或一张图片</i></small>
                  <textarea
                    maxLength={VISUAL_LIMITS.textBodyMax}
                    value={draft.textBody}
                    placeholder="记下做法、看点、成本、可复用的地方…"
                    onChange={(event) => { setDraft((current) => ({ ...current, textBody: event.target.value })); markDirty(); }}
                  />
                </label>

                <button
                  type="button"
                  className={styles.foldToggle}
                  aria-expanded={fold}
                  onClick={() => setFold((current) => !current)}
                >
                  {fold ? "收起补充信息" : "补充信息（选填）"}
                  {draft.subdomain ? ` · 含${VISUAL_SUBDOMAIN_SPECS[draft.subdomain].label}专有 ${fields.length} 项${filledMeta ? `，已填 ${filledMeta}` : ""}` : ""}
                </button>

                {fold ? (
                  <>
                    <div className={report.two}>
                      <label className={report.field}>
                        <small>创作方／品牌</small>
                        <input
                          maxLength={VISUAL_LIMITS.creatorMax}
                          value={draft.creator}
                          placeholder="不确定可留空"
                          onChange={(event) => { setDraft((current) => ({ ...current, creator: event.target.value })); markDirty(); }}
                        />
                      </label>
                      <label className={report.field}>
                        <small>投放／落成时间</small>
                        <input
                          value={draft.occurredAt}
                          placeholder="2026-05 或 2026"
                          onChange={(event) => { setDraft((current) => ({ ...current, occurredAt: event.target.value })); markDirty(); }}
                        />
                      </label>
                    </div>
                    <label className={report.field}>
                      <small>一句话摘要 <i>卡片上显示，最多 {VISUAL_LIMITS.summaryMax} 字</i></small>
                      <input
                        maxLength={VISUAL_LIMITS.summaryMax}
                        value={draft.summary}
                        placeholder="留空就不显示"
                        onChange={(event) => { setDraft((current) => ({ ...current, summary: event.target.value })); markDirty(); }}
                      />
                    </label>
                    <label className={report.field}>
                      <small>来源链接</small>
                      <input
                        maxLength={VISUAL_LIMITS.sourceUrlMax}
                        value={draft.sourceUrl}
                        placeholder="https://…"
                        onChange={(event) => { setDraft((current) => ({ ...current, sourceUrl: event.target.value })); markDirty(); }}
                      />
                    </label>
                    <label className={report.field}>
                      <small>版权／拍摄说明</small>
                      <input
                        value={draft.rightsNote}
                        onChange={(event) => { setDraft((current) => ({ ...current, rightsNote: event.target.value })); markDirty(); }}
                      />
                    </label>
                    {draft.subdomain ? (
                      <div className={styles.subBlock}>
                        <b>{VISUAL_SUBDOMAIN_SPECS[draft.subdomain].label}专有信息</b>
                        {fields.map((field) => {
                          if (field.type === "one") {
                            const value = draft.metadata[field.key];
                            return (
                              <label className={report.field} key={field.key}>
                                <small>{field.label}</small>
                                <select value={typeof value === "string" ? value : ""} onChange={(event) => setMetaOne(field.key, event.target.value)}>
                                  <option value="">不填</option>
                                  {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                                </select>
                              </label>
                            );
                          }
                          if (field.type === "many") {
                            const selected = Array.isArray(draft.metadata[field.key]) ? draft.metadata[field.key] as string[] : [];
                            return (
                              <div className={report.field} key={field.key}>
                                <small>{field.label} <i>多选{field.tip ? `，${field.tip}` : ""}</i></small>
                                <div className={styles.checks}>
                                  {field.options.map((option) => (
                                    <button
                                      key={option}
                                      type="button"
                                      className={styles.check}
                                      aria-pressed={selected.includes(option)}
                                      onClick={() => toggleMetaMany(field.key, option)}
                                    >
                                      {option}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            );
                          }
                          const value = draft.metadata[field.key];
                          return (
                            <label className={report.field} key={field.key}>
                              <small>{field.label}</small>
                              <input
                                value={typeof value === "string" ? value : ""}
                                placeholder={field.placeholder ?? ""}
                                onChange={(event) => setMetaOne(field.key, event.target.value)}
                              />
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <p className={report.hint}>选了子领域之后，这里会多出该子领域的专有信息。</p>
                    )}
                  </>
                ) : null}

                {error ? <p className={report.formError} role="alert" ref={formErrorRef}>{error}</p> : null}
              </div>
              <div className={report.uploadFooter}>
                <button type="button" onClick={onClose}>取消</button>
                <button type="button" className={report.uploadGo} onClick={() => void handleSubmit()}>
                  {editing ? "保存修改" : "开始上传"}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

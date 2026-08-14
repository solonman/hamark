"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DraggableVideoPlayer from "@/app/components/DraggableVideoPlayer";
import {
  HOME_NAVIGATION_EVENT,
  type HomeNavigationEventDetail,
} from "@/app/components/GlobalHomeButton";
import { annotationFields } from "@/lib/annotation-fields";
import {
  interpretSaveResponse,
  rebaseOntoServerRevision,
  type SaveResponseBody,
} from "@/lib/annotation-sync";
import { validateAnnotation } from "@/lib/annotation-validation";
import { emptyCreativeStructure } from "@/lib/taxonomy-v0.3";
import type {
  AnnotationDraft,
  ShotDraft,
  ShotGroupDraft,
  TaxonomyVersion,
} from "@/lib/types";
import ShotGroupEditor from "./ShotGroupEditor";
import TaxonomyFieldEditor from "./TaxonomyFieldEditor";
import V03ShotGroupEditor from "./V03ShotGroupEditor";
import V03AnalysisEditor from "./V03AnalysisEditor";
import AuthorRevisionTasks from "./AuthorRevisionTasks";
import SubmittedAnalysisContent from "../SubmittedAnalysisContent";
import type { SubmittedAnalysis } from "@/lib/types";

type AnnotationResponse = {
  video?: { id: string; title: string; status: string };
  annotation?: AnnotationDraft;
  collaboration?: {
    streamId: string;
    roundId: string;
    roundNumber: number;
    roundStatus: string;
    sourceAuthorName: string;
    currentSnapshotId: string | null;
    activeReleaseNumber: number | null;
    lastEditorName: string | null;
    lastEditedAt: string | null;
  } | null;
  hasPublishedVersion?: boolean;
  publishedVersionCount?: number;
  seededFromV02?: boolean;
  pendingSharedBackfill?: boolean;
  logicalWorkspaceEmpty?: boolean;
  error?: string;
};

function newShot(orderIndex: number): ShotDraft {
  return {
    id: crypto.randomUUID(),
    orderIndex,
    groupName: "镜头组 1",
    shotNumber: String(orderIndex + 1),
    startTime: "",
    endTime: "",
    shotSize: "",
    cameraAngle: "",
    cameraMovement: "",
    visualContent: "",
    dialogue: "",
    voiceover: "",
    screenText: "",
    soundEffect: "",
    music: "",
    creativeComment: "",
  };
}

function ensureV03Worksheet(annotation: AnnotationDraft): AnnotationDraft {
  if (annotation.taxonomyVersion !== "V0.3-PILOT") return annotation;
  if (annotation.shotGroups?.length && annotation.shots.length) {
    return {
      ...annotation,
      creativeStructure: annotation.creativeStructure ?? emptyCreativeStructure(),
    };
  }
  const group: ShotGroupDraft = {
    id: crypto.randomUUID(),
    orderIndex: 0,
    title: "桥段 1",
    primaryRole: "",
    auxiliaryRoles: [],
    customRole: "",
    note: "",
  };
  return {
    ...annotation,
    shotGroups: [group],
    shots: [{ ...newShot(0), groupName: group.title, shotGroupId: group.id }],
    creativeStructure: annotation.creativeStructure ?? emptyCreativeStructure(),
  };
}

const coreFields = [
  {
    key: "commercialIntent",
    label: "商业意图",
    hint: "这支片最终要改变谁的什么认知或行为？",
    rows: 4,
  },
  {
    key: "creativeTheme",
    label: "创意母题",
    hint: "用一句话写出这支片最核心的创意命题。",
    rows: 4,
  },
  {
    key: "synopsis",
    label: "故事梗概",
    hint: "不评价，只把故事从起点到结尾准确说清。",
    rows: 5,
  },
  {
    key: "thinkingChain",
    label: "创意思维链",
    hint: "从商业问题到创意解法，中间经历了哪些关键推演？",
    rows: 7,
  },
  {
    key: "summary",
    label: "全篇创意总结",
    hint: "在完成逐镜点评和结构化判断后，综合说明创意、故事、文案、视听与商业目标如何共同成立。",
    rows: 7,
  },
] as const;

function redirectOnUnauthorized(response: Response) {
  if (response.status === 401) {
    window.location.assign(`/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    return true;
  }
  return false;
}

// 断网或休眠时 fetch 可以长时间挂着不返回。没有这个上限，那次保存永远不结束，
// saveInFlight 不会释放、saveState 停在 saving，自动保存就此彻底停摆，
// 而界面还一直显示"正在自动保存"。必须让它超时失败，好让重试跑起来。
const SAVE_TIMEOUT_MS = 15000;

function localDraftKey(videoId: string, taxonomyVersion: TaxonomyVersion) {
  return `hamark:practice-draft:${videoId}:${taxonomyVersion}`;
}

// 服务端存不进去时至少在本机留一份，避免整段内容只存在于页面内存里。
function writeLocalDraft(
  videoId: string,
  taxonomyVersion: TaxonomyVersion,
  draft: AnnotationDraft,
) {
  try {
    window.localStorage.setItem(
      localDraftKey(videoId, taxonomyVersion),
      JSON.stringify({ savedAt: new Date().toISOString(), draft }),
    );
  } catch {
    // 隐私模式或配额满，本地副本只是兜底，失败不影响正常保存。
  }
}

function readLocalDraft(videoId: string, taxonomyVersion: TaxonomyVersion) {
  try {
    const raw = window.localStorage.getItem(localDraftKey(videoId, taxonomyVersion));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: string; draft?: AnnotationDraft };
    if (!parsed?.draft) return null;
    return { savedAt: parsed.savedAt ?? "", draft: parsed.draft };
  } catch {
    return null;
  }
}

function clearLocalDraft(videoId: string, taxonomyVersion: TaxonomyVersion) {
  try {
    window.localStorage.removeItem(localDraftKey(videoId, taxonomyVersion));
  } catch {
    // 同上，忽略。
  }
}

export default function PracticeClient({
  videoId,
  taxonomyVersion,
}: {
  videoId: string;
  taxonomyVersion: TaxonomyVersion;
}) {
  const [videoTitle, setVideoTitle] = useState("");
  const [videoStatus, setVideoStatus] = useState("");
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [hasPublishedVersion, setHasPublishedVersion] = useState(false);
  const [publishedVersionCount, setPublishedVersionCount] = useState(0);
  const [seededFromV02, setSeededFromV02] = useState(false);
  const [collaboration, setCollaboration] = useState<NonNullable<AnnotationResponse["collaboration"]> | null>(null);
  const [logicalWorkspaceEmpty, setLogicalWorkspaceEmpty] = useState(false);
  const [pendingSharedBackfill, setPendingSharedBackfill] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<{ serverRevision: number } | null>(
    null,
  );
  const [missing, setMissing] = useState<string[]>([]);
  const [editVersion, setEditVersion] = useState(0);
  const editSequence = useRef(0);
  const draftRef = useRef<AnnotationDraft | null>(null);
  const dirtyRef = useRef(false);
  const saveStateRef = useRef<"idle" | "saving" | "saved" | "error">("idle");
  const submitPanelRef = useRef<HTMLElement | null>(null);
  const saveInFlight = useRef<Promise<AnnotationDraft | null> | null>(null);
  // 本机还留着副本，说明上一次保存自始至终没被服务端确认过。
  const [localRecovery, setLocalRecovery] = useState<{
    savedAt: string;
    draft: AnnotationDraft;
  } | null>(null);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);

  useEffect(() => {
    let active = true;
    fetch(`/api/videos/${videoId}/annotation?taxonomy=${encodeURIComponent(taxonomyVersion)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (redirectOnUnauthorized(response)) return;
        const data = (await response.json()) as AnnotationResponse;
        if (!response.ok || !data.video || !data.annotation) {
          throw new Error(data.error || "作业读取失败");
        }
        if (active) {
          setVideoTitle(data.video.title);
          setVideoStatus(data.video.status);
          setHasPublishedVersion(Boolean(data.hasPublishedVersion));
          setPublishedVersionCount(Number(data.publishedVersionCount ?? 0));
          setSeededFromV02(Boolean(data.seededFromV02));
          setCollaboration(data.collaboration ?? null);
          setLogicalWorkspaceEmpty(Boolean(data.logicalWorkspaceEmpty));
          setPendingSharedBackfill(Boolean(data.pendingSharedBackfill));
          setDraft(
            taxonomyVersion === "V0.3-PILOT"
              ? ensureV03Worksheet(data.annotation)
              : data.annotation.shots.length
                ? data.annotation
                : { ...data.annotation, shots: [newShot(0)] },
          );
          // 保存成功会清掉本机副本，所以这里还能读到就意味着上次有内容没落库。
          setLocalRecovery(readLocalDraft(videoId, taxonomyVersion));
        }
      })
      .catch((reason) => {
        if (active) {
          setNotice(reason instanceof Error ? reason.message : "作业读取失败");
          setSaveState("error");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [taxonomyVersion, videoId]);

  const markChanged = useCallback((next: AnnotationDraft) => {
    editSequence.current += 1;
    setEditVersion(editSequence.current);
    draftRef.current = next;
    setDraft(next);
    setDirty(true);
    dirtyRef.current = true;
    // A failed save or publish must survive the next keystroke, otherwise the only
    // trace of the failure disappears before the user can read it.
    if (saveStateRef.current !== "error") {
      if (!saveInFlight.current) setSaveState("idle");
      setNotice("");
    }
    setMissing([]);
  }, []);

  const saveDraft = useCallback(() => {
    if (saveInFlight.current) return saveInFlight.current;
    const current = draftRef.current;
    if (!current) return Promise.resolve(null);
    const sequenceAtStart = editSequence.current;
    const operation = (async () => {
      setSaveState("saving");
      setNotice("");
      // 网络断了也要把这一份留在本机，服务器这次存不存得进去都不影响。
      writeLocalDraft(videoId, taxonomyVersion, current);
      const abort = new AbortController();
      const timeoutId = window.setTimeout(() => abort.abort(), SAVE_TIMEOUT_MS);
      try {
      const response = await fetch(`/api/videos/${videoId}/annotation?taxonomy=${encodeURIComponent(taxonomyVersion)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(current),
        signal: abort.signal,
      });
      if (redirectOnUnauthorized(response)) return null;
      const data = (await response.json().catch(() => ({}))) as SaveResponseBody & {
        annotationId?: string;
        collaboration?: AnnotationResponse["collaboration"];
      };
      const outcome = interpretSaveResponse(
        response.status,
        data,
        data.annotationId,
      );
      if (outcome.kind === "conflict") {
        // Stop autosaving into a rejection loop and let the user decide which side wins.
        setConflict({ serverRevision: outcome.serverRevision });
        setSaveState("error");
        setNotice(outcome.message);
        return null;
      }
      if (outcome.kind === "failed") {
        throw new Error(outcome.message);
      }
      setConflict(null);
      if (data.collaboration) setCollaboration(data.collaboration);
      setLogicalWorkspaceEmpty(false);
      const saved = {
        ...current,
        id: outcome.id,
        revision: outcome.revision,
        status: "DRAFT" as const,
        updatedAt: outcome.updatedAt ?? new Date().toISOString(),
      };
      const latest = draftRef.current;
      const merged = latest
        ? {
            ...latest,
            id: saved.id,
            revision: saved.revision,
            status: saved.status,
            updatedAt: saved.updatedAt,
          }
        : saved;
      draftRef.current = merged;
      setDraft(merged);
      if (editSequence.current === sequenceAtStart) {
        setDirty(false);
        dirtyRef.current = false;
        setSaveState("saved");
        // 服务端已经收下这一版，本地兜底副本就没有存在意义了。
        clearLocalDraft(videoId, taxonomyVersion);
      } else {
        setSaveState("idle");
      }
      return merged;
      } catch (reason) {
        setSaveState("error");
        const aborted =
          reason instanceof DOMException && reason.name === "AbortError";
        setNotice(
          aborted
            ? "保存超时，可能是网络中断。内容已存在本机，恢复网络后会自动重试。"
            : reason instanceof Error
              ? reason.message
              : "保存失败",
        );
        return null;
      } finally {
        window.clearTimeout(timeoutId);
        saveInFlight.current = null;
      }
    })();
    saveInFlight.current = operation;
    return operation;
  }, [taxonomyVersion, videoId]);

  useEffect(() => {
    function handleHomeNavigation(rawEvent: Event) {
      if (!dirtyRef.current) return;
      const event = rawEvent as CustomEvent<HomeNavigationEventDetail>;
      event.preventDefault();
      void (async () => {
        let attempts = 0;
        while (dirtyRef.current && attempts < 3) {
          attempts += 1;
          const saved = await saveDraft();
          // Staying put is right — leaving would drop the unsaved work — but the
          // click must never look like it did nothing.
          if (!saved) {
            setNotice(
              "内容还没有保存成功，已经留在当前页面。请先处理上面的提示，再离开。",
            );
            return;
          }
        }
        if (dirtyRef.current) {
          setNotice("内容还在保存中，已经留在当前页面。稍等一下再点一次。");
          return;
        }
        event.detail.continueNavigation();
      })();
    }
    window.addEventListener(HOME_NAVIGATION_EVENT, handleHomeNavigation);
    return () =>
      window.removeEventListener(HOME_NAVIGATION_EVENT, handleHomeNavigation);
  }, [saveDraft]);

  useEffect(() => {
    // While a conflict is unresolved every save would be rejected again, so wait for
    // the user's choice instead of retrying every 2.5s forever.
    if (!dirty || saveState === "saving" || conflict) return;
    const timer = window.setTimeout(() => {
      void saveDraft();
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [conflict, dirty, editVersion, saveDraft, saveState]);

  useEffect(() => {
    // 关标签页、切后台、系统休眠都走不到自动保存的定时器。这里同步写一份本机副本，
    // 让"页面一关内容就只剩内存里那一份"不再成立。
    function persistLocally() {
      if (!dirtyRef.current) return;
      const current = draftRef.current;
      if (current) writeLocalDraft(videoId, taxonomyVersion, current);
    }
    window.addEventListener("pagehide", persistLocally);
    document.addEventListener("visibilitychange", persistLocally);
    return () => {
      window.removeEventListener("pagehide", persistLocally);
      document.removeEventListener("visibilitychange", persistLocally);
    };
  }, [taxonomyVersion, videoId]);

  const restoreLocalDraft = useCallback(() => {
    if (!localRecovery) return;
    const server = draftRef.current;
    // 内容用本机那份，身份和修订号跟着服务端走，否则下一次保存会撞上修订冲突。
    markChanged({
      ...localRecovery.draft,
      id: server?.id ?? localRecovery.draft.id,
      revision: server?.revision ?? localRecovery.draft.revision,
      status: server?.status ?? localRecovery.draft.status,
      reviewStatus: server?.reviewStatus ?? localRecovery.draft.reviewStatus,
      updatedAt: server?.updatedAt ?? localRecovery.draft.updatedAt,
    });
    setLocalRecovery(null);
  }, [localRecovery, markChanged]);

  const discardLocalDraft = useCallback(() => {
    clearLocalDraft(videoId, taxonomyVersion);
    setLocalRecovery(null);
  }, [taxonomyVersion, videoId]);

  const completion = useMemo(() => {
    if (!draft) return { done: 0, total: 24 };
    if (draft.taxonomyVersion === "V0.3-PILOT") {
      const structure = draft.creativeStructure ?? emptyCreativeStructure();
      const conditionalCount =
        Number(structure.conditionFlags.unconventionalWorld) +
        Number(structure.conditionFlags.audiovisualCarriesIdea) +
        Number(
          structure.primaryCreativePath === "INTERESTING" ||
            structure.conditionFlags.interestingLoadBearing,
        );
      const total = 23 + (draft.shotGroups?.length ?? 0) * 3 +
        structure.auxiliaryCreativePaths.length + conditionalCount;
      const blockers = validateAnnotation(draft).length;
      return { done: Math.max(0, total - blockers), total };
    }
    const coreDone = [
      draft.commercialIntent,
      draft.creativeTheme,
      draft.synopsis,
      draft.thinkingChain,
      draft.summary,
    ].filter((value) => value.trim()).length;
    const fieldsDone = draft.fields.filter((field) => field.answer.trim()).length;
    return { done: coreDone + fieldsDone, total: 24 };
  }, [draft]);

  // Same rule the submit route enforces, so the worksheet can name what is blocking
  // publication before the user clicks instead of only after the server rejects it.
  const publishBlockers = useMemo(
    () => (draft ? validateAnnotation(draft) : []),
    [draft],
  );

  function keepThisPageContent() {
    const current = draftRef.current;
    if (!conflict || !current) return;
    const rebased = rebaseOntoServerRevision(current, conflict.serverRevision);
    draftRef.current = rebased;
    setDraft(rebased);
    setConflict(null);
    setNotice("");
    setSaveState("idle");
    setDirty(true);
    dirtyRef.current = true;
    void saveDraft();
  }

  function revealSubmitFeedback() {
    submitPanelRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }

  async function submitAssignment() {
    setMissing([]);
    const current = draftRef.current;
    const saved = dirty || !current?.id ? await saveDraft() : current;
    // saveDraft already recorded why it failed; surface it where the button is.
    if (!saved) {
      revealSubmitFeedback();
      return;
    }
    setSaveState("saving");
    try {
      const response = await fetch(`/api/videos/${videoId}/annotation/submit?taxonomy=${encodeURIComponent(taxonomyVersion)}`, {
        method: "POST",
      });
      if (redirectOnUnauthorized(response)) return;
      const data = (await response.json()) as {
        error?: string;
        missing?: string[];
        versionNumber?: number;
      };
      if (!response.ok) {
        setMissing(data.missing ?? []);
        throw new Error(data.error || "提交失败");
      }
      setDraft((current) =>
        current
          ? {
              ...current,
              status: "SUBMITTED",
              reviewStatus: hasPublishedVersion
                ? "PENDING_REREVIEW"
                : "PENDING_REVIEW",
            }
          : current,
      );
      setHasPublishedVersion(true);
      setPublishedVersionCount(
        data.versionNumber ?? Math.max(1, publishedVersionCount + 1),
      );
      dirtyRef.current = false;
      setDirty(false);
      setSaveState("saved");
      setNotice(
        "当前公共工作稿已提交为专家定稿候选。所有成员仍可查看、批注；如继续修订，系统会保留本候选并以新修订号继续。",
      );
    } catch (reason) {
      setSaveState("error");
      setNotice(reason instanceof Error ? reason.message : "提交失败");
      revealSubmitFeedback();
    }
  }

  if (loading) {
    return <main className="detail-state">正在展开作业纸…</main>;
  }

  if (!draft) {
    return (
      <main className="detail-state">
        <p>{notice || "无法打开作业。"}</p>
        <Link className="text-button" href={`/videos/${videoId}`}>
          返回作品
        </Link>
      </main>
    );
  }

  if (taxonomyVersion === "V0.2") {
    return (
      <main className="detail-state v02-archive-state">
        <p className="eyebrow">历史体系 · V0.2</p>
        <h1>旧版作业已只读归档</h1>
        <p>
          已有 V0.2 作业、提交快照、评分、批注和修订记录完整保留，
          不再从这里创建或覆盖旧版内容。新作业统一使用当前逆向体系。
        </p>
        <div className="conflict-actions">
          <Link className="button button-accent" href={`/videos/${videoId}/practice?taxonomy=V0.3-PILOT`}>
            进入当前逆向体系
          </Link>
          <Link className="button button-ghost" href={`/videos/${videoId}`}>
            查看历史作业
          </Link>
        </div>
      </main>
    );
  }

  if (pendingSharedBackfill) {
    const readOnlyAnalysis: SubmittedAnalysis = {
      id: draft.id ?? `legacy-v03-${videoId}`,
      authorName: draft.authorName,
      taxonomyVersion: draft.taxonomyVersion,
      revision: draft.revision,
      versionNumber: 0,
      createdAt: draft.updatedAt ?? "",
      contentHash: "",
      payload: draft,
      versions: [],
      versionIdentity: "PUBLIC_SUBMISSION",
    };
    return (
      <main className="detail-shell">
        <header className="detail-header">
          <Link className="wordmark" href="/"><span className="wordmark-mark">R:</span><span>RE:VERSE</span><small>反写</small></Link>
          <Link className="button button-ghost" href={`/videos/${videoId}`}>返回作品</Link>
        </header>
        <section className="analysis-card reading-surface shared-v03-card">
          <div className="analysis-card-head">
            <span className="analysis-index">V03</span>
            <div>
              <p>既有 V0.3 · 待接入共享主线 · 只读</p>
              <h1>{draft.analysisTitle || videoTitle || "未命名公共分析"}</h1>
              <small>来源署名 {draft.authorName} · rev {draft.revision}</small>
            </div>
            <Link className="button button-ghost compact" href={`/videos/${videoId}`}>返回作品</Link>
          </div>
          <p className="review-notice">原有内容完整保留并可查看；完成受控接入前暂不允许编辑，也不会创建个人空白稿。</p>
          <SubmittedAnalysisContent analysis={readOnlyAnalysis} forceOpen />
        </section>
      </main>
    );
  }

  return (
    <main className="practice-shell">
      <header className="practice-topbar">
        <div className="practice-breadcrumb">
          <Link href="/">全部作品</Link>
          <span>/</span>
          <Link href={`/videos/${videoId}`}>← 返回作品</Link>
          <span>/</span>
          <strong>{videoTitle}</strong>
        </div>
        <div className="practice-status">
          <span className={`save-indicator ${saveState}`}>
            {saveState === "saving"
              ? "正在自动保存"
              : saveState === "error"
                ? "未保存，请重试"
                : dirty
                  ? "等待自动保存"
                  : draft.status === "SUBMITTED"
                    ? "已提交专家候选"
                    : hasPublishedVersion
                      ? "公共工作稿已保存"
                      : draft.updatedAt
                        ? "公共工作稿已自动保存"
                        : "共享主线"}
          </span>
          <span className={`version-pill ${taxonomyVersion === "V0.3-PILOT" ? "is-pilot" : ""}`}>
            体系 {taxonomyVersion}
          </span>
          <div className="taxonomy-switch" aria-label="标注体系切换">
            <Link
              className={taxonomyVersion === "V0.3-PILOT" ? "is-active" : ""}
              href={`/videos/${videoId}/practice?taxonomy=V0.3-PILOT`}
            >
              V0.3 试点
            </Link>
            <Link
              className=""
              href={`/videos/${videoId}/practice?taxonomy=V0.2`}
            >
              V0.2 原版
            </Link>
          </div>
          <div className="completion-pill">
            <span>{completion.done}</span> / {completion.total}
          </div>
          <span className="publish-state-copy">修改约3秒自动保存</span>
          <button
            className="button button-accent compact"
            onClick={() => void submitAssignment()}
            title={
              publishBlockers.length
                ? `还有 ${publishBlockers.length} 项未完成`
                : undefined
            }
            disabled={
              saveState === "saving" ||
              publishBlockers.length > 0 ||
              (draft.status === "SUBMITTED" && !dirty)
            }
          >
            {publishBlockers.length
              ? `还有 ${publishBlockers.length} 项未完成`
              : hasPublishedVersion
                ? "更新专家定稿候选"
                : "提交专家定稿候选"}
          </button>
        </div>
      </header>

      {hasPublishedVersion && !draft.baseReleaseId && !seededFromV02 ? (
        <div className="revision-context-banner">
          <strong>正在共同修订公共 V0.3</strong>
          <span>
            所有 ACTIVE 成员看到并编辑同一份工作稿；每次保存都会记录修订者、前后值和基础修订号。
          </span>
          <Link href={`/videos/${videoId}`}>查看共享修订与历史定稿 ↗</Link>
        </div>
      ) : null}

      {logicalWorkspaceEmpty ? (
        <div className="revision-context-banner">
          <strong>开始公共 V0.3 逆向工程</strong>
          <span>
            这是该作品唯一的团队工作区。打开页面不会写入数据；第一次实际保存时才建立公共工作稿，之后所有 ACTIVE 成员继续维护同一份内容。
          </span>
        </div>
      ) : null}

      {draft.baseReleaseNumber ? (
        <div className="revision-context-banner active-standard-baseline-banner">
          <strong>本轮基于活动标准版 R{draft.baseReleaseNumber} 创建</strong>
          <span>
            当前共享轮以该永久批准版为基线；后续保存只更新公共工作稿，R{draft.baseReleaseNumber} 保持不变。
          </span>
          <Link href={`/videos/${videoId}`}>查看活动标准版与来源 ↗</Link>
        </div>
      ) : null}

      {seededFromV02 ? (
        <div className="revision-context-banner pilot-seed-banner">
          <strong>本轮以 V0.2 源稿清洁重建</strong>
          <span>共通整体内容与逐镜脚本已迁入；原 19 项只保留为系统映射参考，V0.3 核心判断由你重新维护。现有活动标准版在新一轮获批前继续生效。</span>
        </div>
      ) : null}

      <div className="practice-layout">
        <DraggableVideoPlayer enabled>
          <aside className="practice-aside">
            <div className="practice-video">
              <span className="practice-video-label">对照视频 · 始终悬浮</span>
              {videoStatus === "READY" ? (
                <video
                  controls
                  playsInline
                  preload="metadata"
                  src={`/api/videos/${videoId}/stream`}
                />
              ) : (
                <div>视频暂不可播放</div>
              )}
            </div>
            <div className="practice-nav">
          <p className="eyebrow">SHARED WORKSPACE</p>
              <a href="#shots">01 逐镜脚本还原</a>
              {draft.taxonomyVersion === "V0.3-PILOT" ? (
                <>
                  <a href="#core">02 全片事实与核心判断</a>
                  <a href="#path">03 主导类型发生路径</a>
                  <a href="#grade">04 提交与 S/A/B/C 自评</a>
                </>
              ) : (
                <>
                  <a href="#core">02 整体判断与总结</a>
                  <a href="#creative">03 创意构成 9 项</a>
                  <a href="#story">04 故事组织 10 项</a>
                </>
              )}
            </div>
            <div className="practice-note">
              <strong>反写，不是仿写</strong>
              <p>
                先忠实还原成片，再判断创意为何成立。
                所有内容都绑定 {taxonomyVersion}。
              </p>
            </div>
          </aside>
        </DraggableVideoPlayer>

        <div className="worksheet">
          <div className="worksheet-title">
            <p className="eyebrow">CURRENT PUBLIC V0.3</p>
            <input
              value={draft.analysisTitle}
              onChange={(event) =>
                markChanged({ ...draft, analysisTitle: event.target.value })
              }
              placeholder="给这份分析起一个标题"
              aria-label="分析标题"
            />
            <p>
              来源署名：{collaboration?.sourceAuthorName ?? draft.authorName} ·{" "}
              {collaboration
                ? `共享修订轮 ${collaboration.roundNumber} · 工作稿 rev ${draft.revision}`
                : "尚未保存 · 首次保存时建立公共工作稿"}
            </p>
          </div>

          {draft.reviewStatus === "CHANGES_REQUESTED" && draft.activeBaseSnapshotId ? (
            <AuthorRevisionTasks snapshotId={draft.activeBaseSnapshotId} />
          ) : null}

          {conflict ? (
            <div className="conflict-panel" role="alert">
              <strong>这份作业在另一个页面被保存过</strong>
              <p>
                本页还没有写入的修改都还在。选择保留哪一份；
                如果你在两个页面分别写了内容，请先复制需要的部分再决定。
              </p>
              <div className="conflict-actions">
                <button
                  className="button button-accent"
                  type="button"
                  onClick={keepThisPageContent}
                >
                  保留本页内容并继续保存
                </button>
                <button
                  className="button button-ghost"
                  type="button"
                  onClick={() => window.location.reload()}
                >
                  放弃本页修改，载入另一份
                </button>
              </div>
            </div>
          ) : null}

          {localRecovery && !conflict ? (
            <div className="conflict-panel" role="alert">
              <strong>本机还留着一份没有存进服务器的内容</strong>
              <p>
                上次编辑（{localRecovery.savedAt
                  ? new Date(localRecovery.savedAt).toLocaleString("zh-CN")
                  : "时间未知"}
                ）有内容没能保存成功。可以把它恢复到本页，确认无误后会照常自动保存。
              </p>
              <div className="conflict-actions">
                <button
                  className="button button-accent"
                  type="button"
                  onClick={restoreLocalDraft}
                >
                  恢复本机内容
                </button>
                <button
                  className="button button-ghost"
                  type="button"
                  onClick={discardLocalDraft}
                >
                  丢弃，使用服务器版本
                </button>
              </div>
            </div>
          ) : null}

          {notice && !conflict ? (
            <div className={`notice ${saveState === "error" ? "error" : ""}`}>
              {notice}
            </div>
          ) : null}

          {missing.length ? (
            <div className="missing-panel">
              <strong>提交前还需完成：</strong>
              <p>{missing.join("、")}</p>
            </div>
          ) : null}

          <section className="worksheet-section" id="shots">
            <div className="worksheet-section-head">
              <span>01</span>
              <div>
                <p className="eyebrow">SHOT-BY-SHOT SCRIPT</p>
                <h2>逐镜脚本还原</h2>
              </div>
              <p>先按叙事段落切镜头组，再在组内逐镜还原；镜号由系统自动维护。</p>
            </div>
            {draft.taxonomyVersion === "V0.3-PILOT" ? (
              <V03ShotGroupEditor
                groups={draft.shotGroups ?? []}
                shots={draft.shots}
                onChange={(shotGroups, shots) =>
                  markChanged({ ...draft, shotGroups, shots })
                }
              />
            ) : (
              <ShotGroupEditor
                shots={draft.shots}
                onChange={(shots) => markChanged({ ...draft, shots })}
              />
            )}
          </section>

          {draft.taxonomyVersion === "V0.3-PILOT" ? (
            <V03AnalysisEditor draft={draft} onChange={markChanged} />
          ) : (
          <><section className="worksheet-section" id="core">
            <div className="worksheet-section-head">
              <span>02</span>
              <div>
                <p className="eyebrow">CORE JUDGEMENT</p>
                <h2>整体判断与总结</h2>
              </div>
              <p>完成逐镜还原和镜头创意点评后，再从证据中归纳整片结论。</p>
            </div>
            <div className="core-editor-grid">
              {coreFields.map((field) => (
                <label
                  key={field.key}
                  className={
                    field.key === "thinkingChain" || field.key === "summary"
                      ? "editor-wide"
                      : ""
                  }
                >
                  <span>{field.label}</span>
                  <small>{field.hint}</small>
                  <textarea
                    rows={field.rows}
                    value={
                      field.key === "summary"
                        ? draft.summary || draft.shotCommentary
                        : draft[field.key]
                    }
                    onChange={(event) =>
                      field.key === "summary"
                        ? markChanged({
                            ...draft,
                            summary: event.target.value,
                            shotCommentary: event.target.value,
                          })
                        : markChanged({
                            ...draft,
                            [field.key]: event.target.value,
                          })
                    }
                  />
                </label>
              ))}
            </div>
          </section>

          {[
            {
              id: "creative",
              number: "03",
              eyebrow: "CREATIVE COMPOSITION",
              title: "创意构成 9 项",
              intro: "保持 V0.2 定义原样；先写判断，标注依据可选。",
              fields: annotationFields.slice(0, 9),
            },
            {
              id: "story",
              number: "04",
              eyebrow: "STORY ORGANIZATION",
              title: "故事组织 10 项",
              intro: "不要为填满而猜测，答案应能回到成片验证。",
              fields: annotationFields.slice(9),
            },
          ].map((group) => (
            <section className="worksheet-section" id={group.id} key={group.id}>
              <div className="worksheet-section-head">
                <span>{group.number}</span>
                <div>
                  <p className="eyebrow">{group.eyebrow}</p>
                  <h2>{group.title}</h2>
                </div>
                <p>{group.intro}</p>
              </div>
              <div className="taxonomy-editor">
                {group.fields.map((field) => {
                  const fieldIndex = draft.fields.findIndex(
                    (item) => item.code === field.code,
                  );
                  const answer = draft.fields[fieldIndex];
                  return (
                    <TaxonomyFieldEditor
                      key={field.code}
                      field={field}
                      answer={answer?.answer ?? ""}
                      evidence={answer?.evidence ?? ""}
                      onAnswerChange={(value) => {
                        const fields = [...draft.fields];
                        fields[fieldIndex] = {
                          code: field.code,
                          answer: value,
                          evidence: answer?.evidence ?? "",
                        };
                        markChanged({ ...draft, fields });
                      }}
                      onEvidenceChange={(value) => {
                        const fields = [...draft.fields];
                        fields[fieldIndex] = {
                          code: field.code,
                          answer: answer?.answer ?? "",
                          evidence: value,
                        };
                        markChanged({ ...draft, fields });
                      }}
                    />
                  );
                })}
              </div>
            </section>
          ))}</>
          )}

          <section className="submit-panel" ref={submitPanelRef}>
            <div>
              <p className="eyebrow">READY FOR EXPERT FINALIZATION?</p>
              <h2>提交当前共享状态供专家定稿</h2>
              <p>
                每一处修改都已自动存入公共工作稿并保留修订事件；提交时生成不可覆盖的候选快照，
                专家定稿后形成永久批准版。
              </p>
              {publishBlockers.length ? (
                <div className="submit-blockers">
                  <strong>
                    还有 {publishBlockers.length} 项未完成，暂时不能发布：
                  </strong>
                  <p>{publishBlockers.join("、")}</p>
                </div>
              ) : null}
              {notice ? (
                <div
                  className={`submit-feedback ${saveState === "error" ? "error" : ""}`}
                  role="status"
                >
                  {notice}
                </div>
              ) : null}
            </div>
            <div>
              <span>
                已完成 {completion.done} / {completion.total}
              </span>
              <button
                className="button button-accent"
                onClick={() => void submitAssignment()}
                title={
                  publishBlockers.length
                    ? `还有 ${publishBlockers.length} 项未完成`
                    : undefined
                }
                disabled={
                  saveState === "saving" ||
                  publishBlockers.length > 0 ||
                  (draft.status === "SUBMITTED" && !dirty)
                }
              >
                {publishBlockers.length
                  ? `还有 ${publishBlockers.length} 项未完成`
                  : hasPublishedVersion
                    ? "更新专家定稿候选"
                    : "提交专家定稿候选"}
              </button>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

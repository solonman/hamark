"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { annotationFields } from "@/lib/annotation-fields";
import type { AnnotationDraft, ShotDraft } from "@/lib/types";
import ShotGroupEditor from "./ShotGroupEditor";
import TaxonomyFieldEditor from "./TaxonomyFieldEditor";

type AnnotationResponse = {
  video?: { id: string; title: string; status: string };
  annotation?: AnnotationDraft;
  hasPublishedVersion?: boolean;
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

export default function PracticeClient({ videoId }: { videoId: string }) {
  const [videoTitle, setVideoTitle] = useState("");
  const [videoStatus, setVideoStatus] = useState("");
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [hasPublishedVersion, setHasPublishedVersion] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [notice, setNotice] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [editVersion, setEditVersion] = useState(0);
  const editSequence = useRef(0);
  const draftRef = useRef<AnnotationDraft | null>(null);
  const saveInFlight = useRef<Promise<AnnotationDraft | null> | null>(null);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    let active = true;
    fetch(`/api/videos/${videoId}/annotation`, { cache: "no-store" })
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
          setDraft(
            data.annotation.shots.length
              ? data.annotation
              : { ...data.annotation, shots: [newShot(0)] },
          );
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
  }, [videoId]);

  const markChanged = useCallback((next: AnnotationDraft) => {
    editSequence.current += 1;
    setEditVersion(editSequence.current);
    draftRef.current = next;
    setDraft(next);
    setDirty(true);
    if (!saveInFlight.current) setSaveState("idle");
    setNotice("");
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
      try {
      const response = await fetch(`/api/videos/${videoId}/annotation`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(current),
      });
      if (redirectOnUnauthorized(response)) return null;
      const data = (await response.json()) as {
        error?: string;
        annotationId?: string;
        revision?: number;
        updatedAt?: string;
      };
      if (!response.ok || !data.annotationId || data.revision === undefined) {
        throw new Error(data.error || "保存失败");
      }
      const saved = {
        ...current,
        id: data.annotationId,
        revision: data.revision,
        status: "DRAFT" as const,
        updatedAt: data.updatedAt ?? new Date().toISOString(),
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
        setSaveState("saved");
      } else {
        setSaveState("idle");
      }
      return merged;
      } catch (reason) {
        setSaveState("error");
        setNotice(reason instanceof Error ? reason.message : "保存失败");
        return null;
      } finally {
        saveInFlight.current = null;
      }
    })();
    saveInFlight.current = operation;
    return operation;
  }, [videoId]);

  useEffect(() => {
    if (!dirty || saveState === "saving") return;
    const timer = window.setTimeout(() => {
      void saveDraft();
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [dirty, editVersion, saveDraft, saveState]);

  const completion = useMemo(() => {
    if (!draft) return { done: 0, total: 24 };
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

  async function submitAssignment() {
    setMissing([]);
    const current = draftRef.current;
    const saved = dirty || !current?.id ? await saveDraft() : current;
    if (!saved) return;
    setSaveState("saving");
    try {
      const response = await fetch(`/api/videos/${videoId}/annotation/submit`, {
        method: "POST",
      });
      if (redirectOnUnauthorized(response)) return;
      const data = (await response.json()) as {
        error?: string;
        missing?: string[];
      };
      if (!response.ok) {
        setMissing(data.missing ?? []);
        throw new Error(data.error || "提交失败");
      }
      setDraft((current) =>
        current ? { ...current, status: "SUBMITTED" } : current,
      );
      setHasPublishedVersion(true);
      setSaveState("saved");
      setNotice(
        hasPublishedVersion
          ? "本次修订已经发布，团队看到的公开版本已更新；你可以留在当前页面继续工作。"
          : "作业已经发布，其他同事现在可以看到这份分析；你可以留在当前页面继续工作。",
      );
    } catch (reason) {
      setSaveState("error");
      setNotice(reason instanceof Error ? reason.message : "提交失败");
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

  return (
    <main className="practice-shell">
      <header className="practice-topbar">
        <div className="practice-breadcrumb">
          <Link href={`/videos/${videoId}`}>← 返回作品</Link>
          <span>/</span>
          <strong>{videoTitle}</strong>
        </div>
        <div className="practice-status">
          <span className={`save-indicator ${saveState}`}>
            {saveState === "saving"
              ? "正在自动保存"
              : dirty
                ? "等待自动保存"
                : saveState === "error"
                  ? "自动保存失败"
                  : draft.status === "SUBMITTED"
                    ? "公开版已是最新"
                    : hasPublishedVersion
                      ? "修订草稿已保存"
                      : draft.updatedAt
                        ? "草稿已自动保存"
                        : "新作业"}
          </span>
          <span className="version-pill">体系 V0.2</span>
          <div className="completion-pill">
            <span>{completion.done}</span> / {completion.total}
          </div>
          <span className="publish-state-copy">修改约3秒自动保存</span>
          <button
            className="button button-accent compact"
            onClick={() => void submitAssignment()}
            disabled={
              saveState === "saving" || (draft.status === "SUBMITTED" && !dirty)
            }
          >
            {hasPublishedVersion ? "发布本次修订" : "发布作业"}
          </button>
        </div>
      </header>

      <div className="practice-layout">
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
            <p className="eyebrow">WORKSHEET</p>
            <a href="#shots">01 逐镜脚本还原</a>
            <a href="#core">02 整体判断与总结</a>
            <a href="#creative">03 创意构成 9 项</a>
            <a href="#story">04 故事组织 10 项</a>
          </div>
          <div className="practice-note">
            <strong>反写，不是仿写</strong>
            <p>先忠实还原成片，再判断创意为何成立。所有内容都绑定 V0.2。</p>
          </div>
        </aside>

        <div className="worksheet">
          <div className="worksheet-title">
            <p className="eyebrow">MY REVERSE-ENGINEERING NOTES</p>
            <input
              value={draft.analysisTitle}
              onChange={(event) =>
                markChanged({ ...draft, analysisTitle: event.target.value })
              }
              placeholder="给这份分析起一个标题"
              aria-label="分析标题"
            />
            <p>
              {draft.authorName} 的个人作业 · 修订 {draft.revision}
            </p>
          </div>

          {notice ? (
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
            <ShotGroupEditor
              shots={draft.shots}
              onChange={(shots) => markChanged({ ...draft, shots })}
            />
          </section>

          <section className="worksheet-section" id="core">
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
          ))}

          <section className="submit-panel">
            <div>
              <p className="eyebrow">READY TO SHARE?</p>
              <h2>把这份作业交给团队</h2>
              <p>
                每一处修改都会自动存入个人草稿；发布时生成不可覆盖的修订快照，
                不会改写之前的公开版本。
              </p>
            </div>
            <div>
              <span>
                已完成 {completion.done} / {completion.total}
              </span>
              <button
                className="button button-accent"
                onClick={() => void submitAssignment()}
                disabled={
                  saveState === "saving" ||
                  (draft.status === "SUBMITTED" && !dirty)
                }
              >
                {hasPublishedVersion ? "发布本次修订" : "发布并公开"}
              </button>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

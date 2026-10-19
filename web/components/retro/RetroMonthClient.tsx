"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import DeleteConfirmDialog from "@/components/shared/DeleteConfirmDialog";
import ThemeSwitcher from "@/components/shared/ThemeSwitcher";
import UserMenu, { type UserMenuUser } from "@/app/components/UserMenu";
import { LibraryToastStack, useLibraryToast } from "@/components/shared/LibraryToast";
import { V04UiApiError } from "@/lib/v04-ui-api-client";
import { isRetroConflict, retroApi, retroReasonText } from "@/lib/retro-client";
import {
  RETRO_DRAFT_SECTIONS,
  RETRO_LIMITS,
  formatRetroMonth,
  isRetroJobRunning,
  type RetroDraftPatchRequest,
  type RetroDraftSection,
  type RetroMonthView,
  type RetroPublicationView,
  type RetroRecordingView,
} from "@/lib/retro-model";
import {
  applyRetroDraftPatch,
  formatRetroTime,
  isRetroReviewing,
  nextRetroPartNo,
  parseRetroMonthJump,
  retroGenerateConfirmLines,
  retroLiveJob,
  retroMonthBadgeFromView,
  retroMonthBadgeLabel,
  retroMonthOverview,
  shouldApplyPoll,
  retroRegenerateGate,
  retroRecordingLabel,
  retroVersionOptions,
  type RetroSourceContext,
  type RetroSourceView,
} from "@/lib/retro-ui";
import RetroRecordingModule, { type RetroRecordingJump } from "./RetroRecordingModule";
import RetroRecordingUploadDialog from "./RetroRecordingUploadDialog";
import RetroSunPanel from "./RetroSunPanel";
import {
  RetroMethodsView,
  RetroMinutesView,
  retroDraftKey,
  type RetroCaseInfo,
  type RetroDraftController,
  type RetroDraftTarget,
  type RetroMethodFilters,
  type RetroMinutesCtx,
} from "./RetroMinutesParts";
import v04 from "../v04/V04Surface.module.css";
import styles from "./Retro.module.css";

const LIBRARY_HREF = "/?library=RETRO";
/** 有整理任务在跑或录音在转写时，月份页每 4 秒拉一次（规格 6.3、10.5）；GET 本身会推进任务。 */
const POLL_INTERVAL_MS = 4000;

type MonthTab = "CASES" | "MINUTES" | "METHODS";

type ConfirmState = {
  eyebrow: string;
  heading: string;
  question: string;
  lines: string[];
  confirmLabel: string;
  run: () => Promise<void>;
};

function nowHM() {
  const date = new Date();
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export default function RetroMonthClient({ monthKey, viewerName, user }: {
  monthKey: string;
  viewerName: string;
  user?: UserMenuUser;
}): JSX.Element {
  const [view, setView] = useState<RetroMonthView | null>(null);
  const viewRef = useRef<RetroMonthView | null>(null);
  const [notFoundState, setNotFoundState] = useState(false);
  const [loadError, setLoadError] = useState("");
  const { toasts, notify } = useLibraryToast();

  const [tab, setTab] = useState<MonthTab>("CASES");
  const [filters, setFilters] = useState<RetroMethodFilters>({ dimension: "ALL", kind: "ALL" });
  const [historyVersion, setHistoryVersion] = useState<number | null>(null);
  const [historyPub, setHistoryPub] = useState<RetroPublicationView | null>(null);

  const [summaryJump, setSummaryJump] = useState<RetroRecordingJump | null>(null);
  const [scrollNonce, setScrollNonce] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [recordingToRemove, setRecordingToRemove] = useState<RetroRecordingView | null>(null);
  const [recordingPending, setRecordingPending] = useState<string | null>(null);

  const [jobBusy, setJobBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState("");

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [adding, setAdding] = useState<RetroDraftSection | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState("");

  const jobStatuses = useRef(new Map<string, string>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const queued = useRef(0);
  /** 每发起一次保存就加一：轮询的响应回来时序号变了，说明期间有过保存，这次结果已经过时，丢掉。 */
  const mutationSeq = useRef(0);

  const applyView = useCallback((next: RetroMonthView, announce: boolean) => {
    viewRef.current = next;
    setView(next);
    const job = next.job;
    if (!job) return;
    const before = jobStatuses.current.get(job.id);
    jobStatuses.current.set(job.id, job.status);
    // 只在「看着它从整理中变成待审阅」这一刻弹一次；刷新页面时本来就待审阅的不再弹。
    if (announce && next.viewer.isReviewer && before && before !== "PENDING_REVIEW" && job.status === "PENDING_REVIEW") {
      notify("本月纪要草稿已生成，等你审阅");
    }
  }, [notify]);

  const reload = useCallback(async (announce = true) => {
    applyView(await retroApi.getMonth(monthKey), announce);
  }, [applyView, monthKey]);

  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    queued.current += 1;
    mutationSeq.current += 1;
    const run = queue.current.catch(() => undefined).then(job).finally(() => { queued.current -= 1; });
    queue.current = run;
    return run;
  }, []);

  // ---- 首次读取：地址栏的 ?tab=、?focus=summary&t= 只在这一刻读一次 ----
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    const controller = new AbortController();
    retroApi.getMonth(monthKey, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        const jump = parseRetroMonthJump(window.location.search);
        applyView(next, false);
        setLoadError("");
        setTab(jump.tab);
        if (jump.focusSummary) {
          setTab("CASES");
          if (jump.seconds !== null) setSummaryJump({ partNo: jump.partNo, ms: jump.seconds * 1000, nonce: Date.now() });
          setScrollNonce(Date.now());
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        if (reason instanceof V04UiApiError && reason.status === 404) setNotFoundState(true);
        else setLoadError(retroReasonText(reason, "月份读取失败。"));
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时读一次
  }, []);

  useEffect(() => {
    if (!scrollNonce) return;
    const frame = window.setTimeout(() => {
      const element = document.getElementById("summary");
      if (element) window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 84, behavior: "instant" });
    });
    return () => window.clearTimeout(frame);
  }, [scrollNonce]);

  const needsPoll = view !== null && (
    (view.job !== null && isRetroJobRunning(view.job.status))
    || view.summaryRecordings.some((recording) => recording.status === "UPLOADING" || recording.status === "TRANSCRIBING")
    || view.cases.some((row) => row.recording.state === "PROCESSING")
  );
  useEffect(() => {
    if (!needsPoll) return;
    const timer = setInterval(() => {
      if (document.hidden || queued.current > 0) return;
      const seq = mutationSeq.current;
      void retroApi.getMonth(monthKey)
        .then((next) => { if (shouldApplyPoll(seq, mutationSeq.current, queued.current)) applyView(next, true); })
        .catch(() => { /* 静默重试 */ });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [needsPoll, monthKey, applyView]);

  // ---------------------------------------------------------------------------
  // 页签、历史版本
  // ---------------------------------------------------------------------------

  function chooseTab(next: MonthTab) {
    setTab(next);
    setEditingKey(null);
    setAdding(null);
    try {
      const url = new URL(window.location.href);
      if (next === "CASES") url.searchParams.delete("tab"); else url.searchParams.set("tab", next);
      url.searchParams.delete("focus"); url.searchParams.delete("t"); url.searchParams.delete("p");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    } catch { /* 忽略 */ }
  }

  async function chooseVersion(version: number) {
    const latest = viewRef.current?.latestPublication?.versionNumber;
    if (version === latest) { setHistoryVersion(null); setHistoryPub(null); return; }
    try {
      const pub = await retroApi.getPublication(monthKey, version);
      setHistoryPub(pub);
      setHistoryVersion(version);
    } catch (reason) {
      notify(retroReasonText(reason, "历史版本读取失败。"), "warn");
    }
  }

  // ---------------------------------------------------------------------------
  // 录音
  // ---------------------------------------------------------------------------

  function openUpload() {
    const current = viewRef.current;
    if (!current) return;
    if (nextRetroPartNo(current.summaryRecordings) === null) { notify(`最多 ${RETRO_LIMITS.recordingPartsMax} 段录音：先移除一段才能再传`, "warn"); return; }
    setUploadOpen(true);
  }

  async function retryRecording(recording: RetroRecordingView) {
    setRecordingPending(recording.id);
    try {
      await retroApi.recordingAction(recording.id, "RETRY");
      notify("已重新提交转写");
      await reload(false);
    } catch (reason) { notify(retroReasonText(reason, "重试没有成功，请稍后再试。"), "warn"); }
    finally { setRecordingPending(null); }
  }

  async function removeRecording(recording: RetroRecordingView) {
    setRecordingPending(recording.id);
    try {
      await retroApi.recordingAction(recording.id, "REMOVE");
      setRecordingToRemove(null);
      notify(`已移除第 ${recording.partNo} 段录音`);
      await reload(false);
    } catch (reason) {
      setRecordingToRemove(null);
      notify(retroReasonText(reason, "移除没有成功，请稍后再试。"), "warn");
    } finally { setRecordingPending(null); }
  }

  // ---------------------------------------------------------------------------
  // 整理任务：生成、重试、放弃、发布、修订（规格 6.1–6.6）
  // ---------------------------------------------------------------------------

  /** 先弹确认，确认后才跑；确认框里出错留在框里，可以重试。 */
  function ask(state: ConfirmState) {
    setConfirmError("");
    setConfirm(state);
  }
  async function runConfirmed() {
    if (!confirm) return;
    setConfirmPending(true);
    setConfirmError("");
    try {
      await confirm.run();
      setConfirm(null);
    } catch (reason) {
      setConfirmError(retroReasonText(reason, "没有完成，请稍后重试。"));
    } finally {
      setConfirmPending(false);
    }
  }

  async function startGenerate(fromReview: boolean) {
    const current = viewRef.current;
    const draftJob = current?.job;
    // 待审阅时重新生成：一次调用，放弃旧任务和开新任务在服务端同一个事务里，失败整体回滚、草稿保留。
    await retroApi.startJob(monthKey, fromReview && draftJob ? { mode: "GENERATE", replaceJobId: draftJob.id } : { mode: "GENERATE" });
    setEditingKey(null);
    setAdding(null);
    await reload(false);
    notify("已开始整理：每一步做完自己接着推进，可以关掉页面");
  }

  function requestGenerate(fromReview: boolean) {
    const current = viewRef.current;
    if (!current) return;
    const gate = fromReview ? retroRegenerateGate(current.preconditions) : { ok: current.preconditions.canGenerate, reason: current.preconditions.blockedReason };
    if (!gate.ok) {
      notify(gate.reason ?? "还不能生成：有录音还在转写，或者当月还没有就绪的案例录音", "warn");
      return;
    }
    const lines = retroGenerateConfirmLines({
      fromReview,
      publishedVersion: current.latestPublication?.versionNumber ?? null,
      pre: current.preconditions,
    });
    const run = async () => { setJobBusy(true); try { await startGenerate(fromReview); } finally { setJobBusy(false); } };
    if (!lines.length) { void run().catch((reason) => notify(retroReasonText(reason, "没有开始整理，请稍后重试。"), "warn")); return; }
    ask({
      eyebrow: "GENERATE",
      heading: fromReview ? "重新生成" : "生成本月纪要与方法记录",
      question: fromReview ? "放弃当前草稿并重新生成？" : "继续生成？",
      lines,
      confirmLabel: fromReview ? "放弃草稿并重新生成" : "继续生成",
      run,
    });
  }

  async function retryJob() {
    const job = retroLiveJob(viewRef.current ?? { job: null });
    if (!job) return;
    setJobBusy(true);
    try {
      await retroApi.jobAction(monthKey, job.id, "RETRY");
      notify(job.failedStep === "EXTRACT" ? `从第 ${job.progress.done + 1} 个案例接着提炼` : "从失败的那一步接着做");
      await reload(false);
    } catch (reason) { notify(retroReasonText(reason, "重试没有成功，请稍后再试。"), "warn"); }
    finally { setJobBusy(false); }
  }

  function requestAbandon(what: "draft" | "job") {
    const job = retroLiveJob(viewRef.current ?? { job: null });
    if (!job) return;
    ask({
      eyebrow: "ABANDON",
      heading: what === "draft" ? "放弃草稿" : "放弃这次整理",
      question: what === "draft" ? "放弃当前草稿？" : "放弃这次整理？",
      lines: [what === "draft"
        ? "草稿和你在上面的修改都会丢掉；已发布的版本不受影响。"
        : "已经提炼的结果不会发布；下次生成时，输入没变的案例直接复用缓存。"],
      confirmLabel: "确认放弃",
      run: async () => {
        await retroApi.jobAction(monthKey, job.id, "ABANDON");
        setEditingKey(null);
        setAdding(null);
        await reload(false);
        notify(what === "draft" ? "已放弃草稿" : "已放弃这次整理");
      },
    });
  }

  function requestPublish() {
    const current = viewRef.current;
    const job = current?.job;
    if (!current || !job) return;
    const version = (current.latestPublication?.versionNumber ?? 0) + 1;
    ask({
      eyebrow: "PUBLISH",
      heading: `发布 v${version}`,
      question: `发布 ${formatRetroMonth(monthKey)}的教学纪要与方法提取记录？`,
      lines: [
        "发布后全员可见；方法候选逐条写进方法候选表，供二期方法库使用。",
        version > 1 ? `v${version - 1} 原样保留在历史版本里，可以切换查看、不能改。` : "以后发现错字，可以用「修订已发布内容」改完再发布成 v2。",
      ],
      confirmLabel: `发布 v${version}`,
      run: async () => {
        await retroApi.jobAction(monthKey, job.id, "PUBLISH");
        setEditingKey(null);
        setAdding(null);
        setHistoryVersion(null);
        setHistoryPub(null);
        await reload(false);
        notify(`已发布 v${viewRef.current?.latestPublication?.versionNumber ?? version}，全员可见`);
      },
    });
  }

  async function reviseFromPublished() {
    const latest = viewRef.current?.latestPublication;
    if (!latest) return;
    setJobBusy(true);
    try {
      await retroApi.startJob(monthKey, { mode: "REVISE_PUBLISHED" });
      await reload(false);
      notify(`已基于 v${latest.versionNumber} 复制出新草稿（不调模型），改完再发布成 v${latest.versionNumber + 1}`);
    } catch (reason) { notify(retroReasonText(reason, "没有复制出新草稿，请稍后再试。"), "warn"); }
    finally { setJobBusy(false); }
  }

  // ---------------------------------------------------------------------------
  // 草稿审阅：改、删、补（规格 6.6）。本地先改，请求排队一个一个发，回来再对齐 revision。
  // ---------------------------------------------------------------------------

  const sendDraft = useCallback((request: Omit<RetroDraftPatchRequest, "revision">, optimistic: boolean): Promise<string | null> => {
    const current = viewRef.current;
    const job = current?.job;
    if (!current || !job || !job.draft) return Promise.resolve("没有可改的草稿。");
    if (optimistic) {
      applyView({ ...current, job: { ...job, draft: { ...job.draft, ...applyRetroDraftPatch(job.draft, request) } } }, false);
    }
    return enqueue(async () => {
      try {
        const revision = viewRef.current?.job?.draft?.revision ?? job.draft!.revision;
        await retroApi.patchDraft(monthKey, job.id, { ...request, revision });
        await reload(false);
        setDraftSavedAt(nowHM());
        return null;
      } catch (reason) {
        const message = isRetroConflict(reason)
          ? "草稿刚被改动过，已刷新成最新内容，请再改一次。"
          : retroReasonText(reason, "没有保存成功，已恢复原来的内容。");
        try { await reload(false); } catch { /* 刷新失败就保持现状 */ }
        return message;
      }
    });
  }, [applyView, enqueue, monthKey, reload]);

  const reportDraftError = useCallback((message: string | null) => { if (message) notify(message, "warn"); }, [notify]);

  const draftController: RetroDraftController | null = (() => {
    if (!view || !isRetroReviewing(view) || !view.job?.draft) return null;
    const draft = view.job.draft;
    const findText = (target: RetroDraftTarget): { text: string; manual: boolean } | null => {
      if (target.section === "case.process") {
        const review = draft.minutes.cases.find((item) => item.caseId === target.caseId);
        return review ? { text: review.process, manual: false } : null;
      }
      if (target.section === "insights" || target.section === "actions") {
        const item = draft.minutes[target.section].find((entry) => entry.id === target.itemId);
        return item ? { text: item.text, manual: item.origin === "MANUAL" } : null;
      }
      if (target.section === "observations") {
        const item = draft.methods.observations.find((entry) => entry.id === target.itemId);
        return item ? { text: item.text, manual: item.origin === "MANUAL" } : null;
      }
      if (target.section === "candidates") return null;
      const field = target.section.slice("case.".length) as "disputes" | "founderPoints" | "suggestions";
      const review = draft.minutes.cases.find((item) => item.caseId === target.caseId);
      const item = review?.[field].find((entry) => entry.id === target.itemId);
      return item ? { text: item.text, manual: item.origin === "MANUAL" } : null;
    };
    return {
      editingKey,
      adding,
      defaultCandidate: {
        dimension: filters.dimension === "ALL" ? "ENTRY" : filters.dimension,
        kind: filters.kind === "ALL" ? "METHOD" : filters.kind,
      },
      startEdit: (target) => { setAdding(null); setEditingKey(retroDraftKey(target)); },
      cancelEdit: () => setEditingKey(null),
      commitText: (target, text) => {
        setEditingKey(null);
        const previous = findText(target);
        if (!previous) return;
        if (!text) {
          // 老孙自己补的条目写空了就是不要了；AI 的条目不能悄悄变空，要删请点「删」。
          if (previous.manual) void sendDraft({ section: target.section, caseId: target.caseId, itemId: target.itemId, op: "DELETE" }, true).then(reportDraftError);
          else notify("内容不能为空，已恢复原文；不要这一条就点「删」", "warn");
          return;
        }
        if (text === previous.text) return;
        void sendDraft({ section: target.section, caseId: target.caseId, itemId: target.itemId, op: "UPDATE", value: { text } }, true).then(reportDraftError);
      },
      remove: (target) => {
        if (!RETRO_DRAFT_SECTIONS[target.section].remove) return;
        if (editingKey === retroDraftKey(target)) setEditingKey(null);
        void sendDraft({ section: target.section, caseId: target.caseId, itemId: target.itemId, op: "DELETE" }, true).then((message) => {
          if (message) notify(message, "warn"); else notify("已删除这一条");
        });
      },
      startAdd: (section) => { setEditingKey(null); setAdding(section); },
      cancelAdd: () => setAdding(null),
      commitAddText: (section, text) => {
        setAdding(null);
        if (!text) return;
        void sendDraft({ section, op: "ADD", value: { text } }, false).then(reportDraftError);
      },
      commitAddCandidate: (value) => {
        setAdding(null);
        void sendDraft({ section: "candidates", op: "ADD", value }, false).then((message) => {
          if (message) notify(message, "warn"); else notify("已补充一条方法候选（标「老孙补充」）");
        });
      },
      patchCandidate: (target, value) => sendDraft({ section: "candidates", itemId: target.itemId, op: "UPDATE", value }, true),
      finishCandidate: () => setEditingKey(null),
    };
  })();

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  const caseRows = view?.cases;
  const listenHere = useCallback((source: RetroSourceView): boolean => {
    // 整场总结的出处在本页的「案例」页签里：本页自己跳，不整页刷新。
    if (source.kind !== "REVIEW" || source.caseId !== null) return false;
    setTab("CASES");
    setSummaryJump({ partNo: source.partNo, ms: source.startMs, nonce: Date.now() });
    setScrollNonce(Date.now());
    return true;
  }, []);

  const caseInfoFor = useCallback((numbers: Record<string, number>): ((caseId: string) => RetroCaseInfo | null) => (caseId) => {
    const row = caseRows?.find((item) => item.id === caseId);
    if (row) return { number: row.number, client: row.clientName, title: row.title, department: row.department, deleted: false };
    const number = numbers[caseId];
    return number ? { number, client: "", title: "（案例已移入回收站）", department: "", deleted: true } : null;
  }, [caseRows]);

  const caseLabels = useMemo(
    () => Object.fromEntries((caseRows ?? []).map((row) => [row.id, { client: row.clientName, title: row.title }])),
    [caseRows],
  );
  const rowNumbers = useMemo(
    () => Object.fromEntries((caseRows ?? []).map((row) => [row.id, row.number])),
    [caseRows],
  );

  if (notFoundState) {
    return (
      <main className={`${v04.surface} ${styles.root}`} data-v04-page="detail">
        <section className={v04.emptyState}>
          <h2>{formatRetroMonth(monthKey)}还没有案例</h2>
          <p>先在客户需求复盘库里新建这个月的案例，再回来整理。</p>
          <Link href={LIBRARY_HREF}>返回客户需求复盘库</Link>
        </section>
      </main>
    );
  }
  if (loadError) {
    return (
      <main className={`${v04.surface} ${styles.root}`} data-v04-page="detail">
        <section className={v04.emptyState}><h2>月份读取失败</h2><p>{loadError}</p></section>
      </main>
    );
  }
  if (!view) {
    return (
      <main className={`${v04.surface} ${styles.root}`} data-v04-page="detail">
        <section className={v04.emptyState}><h2>正在读取{formatRetroMonth(monthKey)}…</h2></section>
      </main>
    );
  }

  const isReviewer = view.viewer.isReviewer;
  const liveJob = retroLiveJob(view);
  const reviewing = isRetroReviewing(view);
  const status = retroMonthBadgeLabel(retroMonthBadgeFromView(view));
  const latest = view.latestPublication;
  const shownPub = historyVersion !== null && historyPub?.versionNumber === historyVersion ? historyPub : latest;
  const tabs: Array<[MonthTab, string]> = [["CASES", `案例（${view.cases.length}）`], ["MINUTES", "教学纪要"], ["METHODS", "方法提取记录"]];
  const regenerateGate = retroRegenerateGate(view.preconditions);
  const summaryNextPart = nextRetroPartNo(view.summaryRecordings) ?? 1;

  const publicationCtx = (pub: RetroPublicationView): RetroMinutesCtx => {
    const source: RetroSourceContext = {
      monthKey,
      quotedSegments: pub.quotedSegments,
      recordingRefs: pub.recordingRefs,
      caseNumbers: pub.caseNumbers,
      roundRefs: pub.roundRefs,
      caseLabels,
    };
    return { source, caseInfo: caseInfoFor(pub.caseNumbers), onListen: listenHere };
  };
  const draftCtx = (): RetroMinutesCtx => {
    const draft = view.job!.draft!;
    const source: RetroSourceContext = {
      monthKey,
      quotedSegments: draft.quotedSegments,
      recordingRefs: draft.recordingRefs,
      caseNumbers: { ...rowNumbers, ...draft.caseNumbers },
      roundRefs: draft.roundRefs,
      caseLabels,
    };
    return { source, caseInfo: caseInfoFor(rowNumbers), onListen: listenHere, draft: draftController };
  };

  function outputContent(which: "MINUTES" | "METHODS"): JSX.Element {
    if (reviewing && view!.job?.draft) {
      const draft = view!.job.draft;
      const ctx = draftCtx();
      return (
        <>
          <div className={styles.draftNote}>
            <b>草稿 · 只有你看得到</b>
            <span>
              {view!.job.revisingFromVersion ? `复制自已发布的 v${view!.job.revisingFromVersion}，没有调模型。` : "AI 生成的草稿，每一条都带录音出处。"}
              悬停一条可以「改」「删」；改动失焦自动保存。
            </span>
          </div>
          {which === "MINUTES"
            ? <RetroMinutesView minutes={draft.minutes} ctx={ctx} />
            : <RetroMethodsView methods={draft.methods} ctx={ctx} filters={filters} onFilters={setFilters} />}
        </>
      );
    }
    if (shownPub) {
      const options = retroVersionOptions(view!.publicationVersions.length ? view!.publicationVersions : [shownPub.versionNumber]);
      const ctx = publicationCtx(shownPub);
      return (
        <>
          <div className={styles.tabHead}>
            <span className={styles.monthStatus} data-tone="published"><i />已发布 v{shownPub.versionNumber}</span>
            <span>{formatRetroTime(shownPub.publishedAt)} · {shownPub.publishedByName}发布 · 全员可见</span>
            <span className={styles.grow} />
            {options.length > 1 ? (
              <label className={styles.historyLabel}>
                历史版本
                <select
                  className={styles.historySelect}
                  aria-label="历史版本"
                  value={shownPub.versionNumber}
                  onChange={(event) => void chooseVersion(Number(event.target.value))}
                >
                  {options.map((option) => <option key={option.version} value={option.version}>{option.label}</option>)}
                </select>
              </label>
            ) : null}
          </div>
          {latest && shownPub.versionNumber < latest.versionNumber ? (
            <p className={styles.histNote}>这是历史版本 v{shownPub.versionNumber}，只能查看，不能改。当前发布的是 v{latest.versionNumber}。</p>
          ) : null}
          {isReviewer && liveJob && latest ? (
            <p className={styles.histNote}>正在{liveJob.status === "PENDING_REVIEW" ? "准备新草稿" : "重新生成"}；完成并发布前，大家看到的仍是 v{latest.versionNumber}。</p>
          ) : null}
          {which === "MINUTES"
            ? <RetroMinutesView minutes={shownPub.minutes} ctx={ctx} />
            : <RetroMethodsView methods={shownPub.methods} ctx={ctx} filters={filters} onFilters={setFilters} />}
        </>
      );
    }
    if (isReviewer) {
      const failed = liveJob?.status === "FAILED";
      return (
        <section className={v04.emptyState}>
          <span>{liveJob ? "…" : "＋"}</span>
          <h2>{liveJob ? (failed ? "整理失败" : "正在整理") : "还没有整理"}</h2>
          <p>{liveJob ? "整理完会弹出提示，草稿出现在这里，只有你看得到。" : "在上方操作区点「生成本月纪要与方法记录」。"}</p>
        </section>
      );
    }
    return (
      <section className={v04.emptyState}>
        <span>…</span>
        <h2>老孙整理确认后在这里发布</h2>
        <p>{liveJob ? "正在整理。" : "这个月还没有整理。"}案例、录音和文字稿现在就能看，在「案例」页签里。</p>
      </section>
    );
  }

  return (
    <main className={`${v04.surface} ${styles.root}`} data-v04-page="detail">
      <header className={v04.siteHeader}>
        <Link href={LIBRARY_HREF} className={v04.brandWordmark}><b>R:</b><span>RE:VERSE</span><small>反写</small></Link>
        <nav className={v04.siteNav} aria-label="站点导航">
          <span className={v04.headerCaseTitle} title={`${formatRetroMonth(monthKey)}复盘`}>{formatRetroMonth(monthKey)}复盘</span>
          <Link href={LIBRARY_HREF}>客户需求复盘库</Link>
        </nav>
        <div className={v04.siteUtilities}>
          <ThemeSwitcher />
          {user ? <UserMenu user={user} /> : <span>{viewerName}</span>}
        </div>
      </header>

      <section className={`${v04.detailHero} ${styles.monthHero} ${isReviewer ? "" : styles.solo}`.trim()}>
        <div>
          <p className={v04.breadcrumb}><Link href={LIBRARY_HREF}>客户需求复盘库</Link><span>/</span><b>{formatRetroMonth(monthKey)}</b></p>
          <p className={v04.detailEyebrow}>MONTHLY RETRO · {monthKey}</p>
          <h1>{formatRetroMonth(monthKey)}客户需求复盘</h1>
          <p className={v04.detailSummary}>{retroMonthOverview(view)}</p>
          <div className={v04.detailTags}><span className={styles.monthStatus} data-tone={status.tone}><i />{status.label}</span></div>
        </div>
        {isReviewer ? (
          <RetroSunPanel
            view={view}
            busy={jobBusy}
            draftSavedAt={draftSavedAt}
            onGenerate={() => requestGenerate(false)}
            onRetry={() => void retryJob()}
            onAbandonJob={() => requestAbandon("job")}
            onRevise={() => void reviseFromPublished()}
          />
        ) : null}
      </section>

      <nav className={styles.monthTabs} role="tablist" aria-label="本月内容">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => chooseTab(key)}>
            {label}{reviewing && key !== "CASES" ? <span className={styles.draftBadge}>草稿</span> : null}
          </button>
        ))}
      </nav>

      <div className={`${v04.readingBody} ${reviewing ? `${styles.isDraft} ${styles.monthBodyDraft}` : ""}`.trim()}>
        {tab === "CASES" ? (
          <>
            <section className={v04.readingModule}>
              <header>
                <div><small>CASES</small><h2>本月案例</h2></div>
                <span className={styles.recMeta}>按上传先后编号；点一行进入案例</span>
              </header>
              <div className={styles.caseRows}>
                {view.cases.length ? (
                  <>
                    <div className={`${styles.caseRow} ${styles.caseRowHead}`} aria-hidden="true">
                      <span>序号</span><span className={styles.d}>部门</span><span className={styles.c}>客户</span><span>标题</span><span className={styles.r}>回合</span><span>录音</span>
                    </div>
                    {view.cases.map((row) => {
                      const rec = retroRecordingLabel(row.recording);
                      return (
                        <Link key={row.id} className={styles.caseRow} href={`/retro/${encodeURIComponent(row.id)}`}>
                          <span className={styles.n}>案例 {row.number}</span>
                          <span className={styles.d}>{row.department}</span>
                          <span className={styles.c}>{row.clientName}</span>
                          <span className={styles.t}>{row.title}</span>
                          <span className={`${styles.r} ${styles.m}`}>{row.roundCount} 回合</span>
                          <span className={styles.s}>
                            <span className={styles.recState} data-rec={rec.tone}>
                              {rec.tone === "busy" ? <span className={v04.reviewSpin} aria-hidden="true" /> : null}
                              {rec.label}
                            </span>
                          </span>
                        </Link>
                      );
                    })}
                  </>
                ) : <p className={styles.roundEmpty}>这个月还没有案例。</p>}
              </div>
            </section>
            <section className={v04.readingModule} id="summary">
              <header>
                <div><small>SUMMARY RECORDING</small><h2>整场总结</h2></div>
                <span className={styles.recMeta}>老孙最后单独录的一段；任何人都能上传</span>
              </header>
              <div className={styles.recBody}>
                <RetroRecordingModule
                  recordings={view.summaryRecordings}
                  emptyTitle="还没有整场总结录音"
                  emptySub="上传老孙的整场总结（单独录的那一段）"
                  jump={summaryJump}
                  busyAction={recordingPending}
                  onUpload={openUpload}
                  onRetry={(recording) => { void retryRecording(recording); }}
                  onRemove={setRecordingToRemove}
                />
              </div>
            </section>
          </>
        ) : outputContent(tab)}
      </div>

      {reviewing && view.job ? (
        <div className={styles.draftBar} role="region" aria-label="草稿操作">
          <span><b>草稿</b> · 只有你看得到{draftSavedAt ? ` · 已保存 ${draftSavedAt}` : ""}</span>
          <button type="button" className={`${v04.reviewGhostButton} ${v04.reviewDangerButton}`} onClick={() => requestAbandon("draft")}>放弃草稿</button>
          <button
            type="button"
            className={v04.reviewGhostButton}
            disabled={jobBusy || !regenerateGate.ok}
            title={regenerateGate.reason ?? undefined}
            onClick={() => requestGenerate(true)}
          >
            重新生成
          </button>
          <button type="button" className={v04.reviewPrimaryButton} onClick={requestPublish}>发布 v{(latest?.versionNumber ?? 0) + 1}</button>
        </div>
      ) : null}

      <DeleteConfirmDialog
        open={confirm !== null}
        eyebrow={confirm?.eyebrow}
        heading={confirm?.heading ?? ""}
        title=""
        question={confirm?.question}
        lines={confirm?.lines ?? []}
        error={confirmError}
        pending={confirmPending}
        confirmLabel={confirm?.confirmLabel}
        pendingLabel="正在处理…"
        onConfirm={() => void runConfirmed()}
        onCancel={() => setConfirm(null)}
      />
      <DeleteConfirmDialog
        open={recordingToRemove !== null}
        eyebrow="REMOVE"
        heading="移除这一段录音"
        title={recordingToRemove?.fileName ?? ""}
        question={recordingToRemove ? `移除第 ${recordingToRemove.partNo} 段录音「${recordingToRemove.fileName}」？` : undefined}
        lines={["移除是软删除：录音文件和文字稿都保留，已发布成果里引用它的片段仍然能打开、能播放。", "移除后可以重新上传。"]}
        pending={recordingPending !== null && recordingToRemove?.id === recordingPending}
        confirmLabel="确认移除"
        pendingLabel="正在移除…"
        onConfirm={() => { if (recordingToRemove) void removeRecording(recordingToRemove); }}
        onCancel={() => setRecordingToRemove(null)}
      />
      {uploadOpen ? (
        <RetroRecordingUploadDialog
          monthKey={monthKey}
          caseId={null}
          nextPart={summaryNextPart}
          onClose={() => setUploadOpen(false)}
          onKept={() => { void reload(false).catch(() => undefined); }}
          onUploaded={() => {
            setUploadOpen(false);
            notify("总结录音已上传，正在转写；转写完成后全员可见");
            void reload(false).catch(() => undefined);
          }}
        />
      ) : null}
      <LibraryToastStack toasts={toasts} />
    </main>
  );
}

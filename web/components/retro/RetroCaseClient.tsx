"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DeleteConfirmDialog from "@/components/shared/DeleteConfirmDialog";
import ThemeSwitcher from "@/components/shared/ThemeSwitcher";
import UserMenu, { type UserMenuUser } from "@/app/components/UserMenu";
import { LibraryToastStack, useLibraryToast } from "@/components/shared/LibraryToast";
import { V04UiApiError } from "@/lib/v04-ui-api-client";
import { isRetroConflict, retroApi, retroReasonText } from "@/lib/retro-client";
import {
  RETRO_LIMITS,
  formatRetroMonth,
  type RetroAssetView,
  type RetroCaseDetail,
  type RetroLinkKind,
  type RetroPatchCaseRequest,
  type RetroPatchRoundRequest,
  type RetroRecordingView,
  type RetroRoundView,
} from "@/lib/retro-model";
import {
  RETRO_CASE_FIELD_LIMITS,
  RETRO_FLASH_KEY,
  RETRO_ROUND_FIELD_LIMITS,
  formatRetroTime,
  hasPendingCaseWork,
  nextRetroPartNo,
  parseRetroCaseJump,
  shouldApplyPoll,
  retroBasicsFromDetail,
  retroRoundHasContent,
  type RetroRoundMark,
  type RetroSourceView,
} from "@/lib/retro-ui";
import V19EditableValue from "../v04/V19EditableValue";
import RetroCaseDialog from "./RetroCaseDialog";
import RetroInMinutes from "./RetroInMinutes";
import RetroLinkPicker from "./RetroLinkPicker";
import RetroRecordingModule, { type RetroRecordingJump } from "./RetroRecordingModule";
import RetroRecordingUploadDialog from "./RetroRecordingUploadDialog";
import RetroRoundCard, { type RetroAssetHost, type RetroRoundTextField } from "./RetroRoundCard";
import RetroAssetBlock from "./RetroAssetBlock";
import RetroAssetViewer from "./RetroAssetViewer";
import type { RetroAudioSeekRequest } from "./RetroAudioPanel";
import v04 from "../v04/V04Surface.module.css";
import styles from "./Retro.module.css";

const LIBRARY_HREF = "/?library=RETRO";
/** 案例页可见时，录音还在转写就每 4 秒拉一次（规格 5.2）。 */
const POLL_INTERVAL_MS = 4000;

type CaseField = "background" | "outcome" | "turningPoints" | "discussionQuestions";
type ScrollTarget = { kind: "recording" | "round"; id: string; nonce: number };
/** 详情里的签名地址（文档页图 15 分钟）快过期时，打开弹层前先悄悄刷新一次。 */
const DETAIL_STALE_MS = 10 * 60 * 1000;

/** 附件所在那一处（需求凭证或某一回合）已传完的附件，按位置排好：弹层的翻页范围。 */
function findAssetGroup(detail: RetroCaseDetail | null, assetId: string | null): RetroAssetView[] | null {
  if (!detail || !assetId) return null;
  for (const owner of [detail.needAssets, ...detail.rounds.map((round) => round.assets)]) {
    if (owner.some((asset) => asset.id === assetId)) {
      return owner.filter((asset) => asset.uploadStatus === "READY").sort((a, b) => a.position - b.position);
    }
  }
  return null;
}

function stripQuery(names: string[]) {
  try {
    const url = new URL(window.location.href);
    for (const name of names) url.searchParams.delete(name);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch { /* 地址栏改不了就算了 */ }
}

export default function RetroCaseClient({ caseId, viewerName, user }: {
  caseId: string;
  viewerName: string;
  user?: UserMenuUser;
}) {
  const [detail, setDetail] = useState<RetroCaseDetail | null>(null);
  const detailRef = useRef<RetroCaseDetail | null>(null);
  const [notFoundState, setNotFoundState] = useState(false);
  const [loadError, setLoadError] = useState("");
  const { toasts, notify } = useLibraryToast();

  // 弹层与对话框
  const [editBasicsOpen, setEditBasicsOpen] = useState(false);
  const [departments, setDepartments] = useState<string[]>([]);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [trashPending, setTrashPending] = useState(false);
  const [trashError, setTrashError] = useState("");
  const [linkRoundId, setLinkRoundId] = useState<string | null>(null);
  const [roundToDelete, setRoundToDelete] = useState<RetroRoundView | null>(null);
  const [roundDeletePending, setRoundDeletePending] = useState(false);
  const [recordingUploadOpen, setRecordingUploadOpen] = useState(false);
  const [recordingToRemove, setRecordingToRemove] = useState<RetroRecordingView | null>(null);
  const [recordingActionPending, setRecordingActionPending] = useState<string | null>(null);
  /** 站内弹层正在看的附件（规格 4.3）：只存 id，内容每次从最新的详情里取，轮询收口后弹层跟着更新。 */
  const [viewerId, setViewerId] = useState<string | null>(null);
  const loadedAt = useRef(0);

  // 跳转与播放（?t=、?audio=、?round=、「去听原声」）
  const [recJump, setRecJump] = useState<RetroRecordingJump | null>(null);
  const [audioSeek, setAudioSeek] = useState<RetroAudioSeekRequest | null>(null);
  const [scrollTarget, setScrollTarget] = useState<ScrollTarget | null>(null);
  const pendingFocus = useRef<string | null>(null);

  const [savedKey, setSavedKey] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const queued = useRef(0);
  /** 每发起一次保存就加一：轮询的响应回来时序号变了，说明期间有过保存，这次结果已经过时，丢掉。 */
  const mutationSeq = useRef(0);

  const applyDetail = useCallback((next: RetroCaseDetail) => {
    detailRef.current = next;
    loadedAt.current = Date.now();
    setDetail(next);
  }, []);

  const reload = useCallback(async () => {
    applyDetail(await retroApi.getCase(caseId));
  }, [applyDetail, caseId]);

  /** 保存请求排队一个一个发：后一个要用前一个返回后的最新 revision，不然会自己和自己 409。 */
  const enqueue = useCallback((job: () => Promise<void>): Promise<void> => {
    queued.current += 1;
    mutationSeq.current += 1;
    const run = queue.current.catch(() => undefined).then(job).finally(() => { queued.current -= 1; });
    queue.current = run;
    return run;
  }, []);

  const flashSaved = useCallback((key: string) => {
    setSavedKey(key);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedKey(null), 1900);
  }, []);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  const onMutationError = useCallback(async (reason: unknown) => {
    if (isRetroConflict(reason)) notify("这个案例刚被别人改过，已刷新成最新内容，请再改一次。", "warn");
    else notify(retroReasonText(reason, "没有保存成功，已恢复原来的内容。"), "warn");
    try { await reload(); } catch { /* 刷新失败就保持现状 */ }
  }, [notify, reload]);

  // ---- 首次读取：地址栏的跳转参数只在这一刻读一次 ----
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    const controller = new AbortController();
    retroApi.getCase(caseId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        const jump = parseRetroCaseJump(window.location.search, window.location.hash);
        const nonce = Date.now();
        if (jump.created) pendingFocus.current = "background";
        applyDetail(next);
        setLoadError("");
        if (jump.created) {
          notify("案例已创建，接着把需求和过程填上");
          stripQuery(["created"]);
        } else if (jump.audioAssetId) {
          // 客户录音在站内弹层里播放：找到就打开并跳到时间点，找不到（已移除）给一句提示。
          if (findAssetGroup(next, jump.audioAssetId)) {
            setViewerId(jump.audioAssetId);
            setAudioSeek({ ownerId: jump.audioAssetId, ms: (jump.seconds ?? 0) * 1000, nonce });
          } else {
            notify("这段客户录音已被移除；已发布纪要里的原文来自发布时的快照", "warn");
          }
        } else if (jump.seconds !== null) {
          setRecJump({ partNo: jump.partNo, ms: jump.seconds * 1000, nonce });
          setScrollTarget({ kind: "recording", id: "recording", nonce });
        } else if (jump.roundId) {
          setScrollTarget({ kind: "round", id: jump.roundId, nonce });
        } else if (jump.toRecording) {
          setScrollTarget({ kind: "recording", id: "recording", nonce });
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        if (reason instanceof V04UiApiError && reason.status === 404) setNotFoundState(true);
        else setLoadError(retroReasonText(reason, "案例详情读取失败。"));
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时读一次
  }, []);

  // 新建后光标落在「任务与最初需求」；新添的回合光标落在「我们交了什么」。
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target || !detail) return;
    const id = target === "background" ? "retro-background" : target;
    const element = document.getElementById(id);
    if (!element) return;
    pendingFocus.current = null;
    if (target !== "background") element.scrollIntoView({ block: "center", behavior: "instant" });
    element.click();
  }, [detail]);

  // 滚动到点评录音或回合。
  useEffect(() => {
    if (!scrollTarget || !detail) return;
    // 用 setTimeout 而不是 requestAnimationFrame、用 instant 而不是 auto：后台标签页里 rAF 不触发；全站 html 开了
    // scroll-behavior: smooth，auto 会变成平滑滚动、要逐帧渲染才走得动。「去听原声」打开的页面要直接定位到录音。
    const frame = window.setTimeout(() => {
      if (scrollTarget.kind === "round") {
        const element = document.getElementById(`round-${scrollTarget.id}`);
        if (!element) { notify("这一回合已被删除；已发布纪要里的标记仍然保留", "warn"); return; }
        element.scrollIntoView({ block: "center", behavior: "instant" });
        element.classList.remove(styles.flash);
        void element.offsetWidth;
        element.classList.add(styles.flash);
      } else {
        const element = document.getElementById("recording");
        if (element) window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 84, behavior: "instant" });
      }
    });
    return () => window.clearTimeout(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 nonce 变化时滚一次
  }, [scrollTarget?.nonce]);

  // 录音或客户录音转写还没到终态、文档还在生成预览：可见时每 4 秒悄悄拉一次；有保存请求在途时跳过，免得把还没落库的改动盖掉。
  const pending = detail ? hasPendingCaseWork(detail) : false;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      if (document.hidden || queued.current > 0) return;
      const seq = mutationSeq.current;
      void retroApi.getCase(caseId)
        .then((next) => { if (shouldApplyPoll(seq, mutationSeq.current, queued.current)) applyDetail(next); })
        .catch(() => { /* 静默重试 */ });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pending, caseId, applyDetail]);

  // 编辑基本信息时才需要部门提示。
  useEffect(() => {
    if (!editBasicsOpen) return;
    let cancelled = false;
    void retroApi.listCases().then((library) => {
      if (!cancelled) setDepartments([...new Set((library.cases ?? []).map((card) => card.department).filter(Boolean))]);
    }).catch(() => { /* 没有提示也能填 */ });
    return () => { cancelled = true; };
  }, [editBasicsOpen]);

  // 弹层的翻页范围；看着的附件被删掉（或刷新后不见了）时取不到，弹层自己不渲染。
  const viewerGroup = useMemo(() => findAssetGroup(detail, viewerId), [detail, viewerId]);

  // ---------------------------------------------------------------------------
  // 原位编辑
  // ---------------------------------------------------------------------------

  const saveCaseField = useCallback((field: CaseField, value: string) => {
    const current = detailRef.current;
    if (!current) return;
    if (value.length > RETRO_CASE_FIELD_LIMITS[field]) {
      notify(`这一项最多 ${RETRO_CASE_FIELD_LIMITS[field]} 字，这次没有保存。`, "warn");
      return;
    }
    applyDetail({ ...current, [field]: value });
    void enqueue(async () => {
      try {
        const saved = await retroApi.patchCase(caseId, { [field]: value, revision: detailRef.current?.revision ?? current.revision } as RetroPatchCaseRequest);
        // 只并 revision、updatedAt 和这一项归一后的值：整份覆盖会冲掉别的字段里还没提交的输入。
        const latest = detailRef.current;
        if (latest) applyDetail({ ...latest, revision: saved.revision, updatedAt: saved.updatedAt, [field]: saved[field] });
        flashSaved(`case:${field}`);
      } catch (reason) { await onMutationError(reason); }
    });
  }, [applyDetail, caseId, enqueue, flashSaved, notify, onMutationError]);

  const saveRoundField = useCallback((round: RetroRoundView, field: RetroRoundTextField, value: string) => {
    const current = detailRef.current;
    if (!current) return;
    if (field === "title" && !value.trim()) { notify("回合标题不能为空，已恢复原来的内容", "warn"); return; }
    if (value.length > RETRO_ROUND_FIELD_LIMITS[field]) {
      notify(`这一项最多 ${RETRO_ROUND_FIELD_LIMITS[field]} 字，这次没有保存。`, "warn");
      return;
    }
    applyDetail({ ...current, rounds: current.rounds.map((item) => (item.id === round.id ? { ...item, [field]: value } : item)) });
    void enqueue(async () => {
      try {
        const latest = detailRef.current?.rounds.find((item) => item.id === round.id) ?? round;
        const body = { [field]: value, revision: latest.revision } as RetroPatchRoundRequest;
        const saved = await retroApi.patchRound(caseId, round.id, body);
        const latestDetail = detailRef.current;
        if (latestDetail && saved?.round) {
          applyDetail({
            ...latestDetail,
            rounds: latestDetail.rounds.map((item) => (item.id === round.id ? { ...item, revision: saved.round.revision, [field]: saved.round[field] } : item)),
          });
        }
        flashSaved(`${round.id}:${field}`);
      } catch (reason) { await onMutationError(reason); }
    });
  }, [applyDetail, caseId, enqueue, flashSaved, notify, onMutationError]);

  const addRound = useCallback(() => {
    void enqueue(async () => {
      try {
        const created = (await retroApi.createRound(caseId)).round;
        const latest = detailRef.current;
        if (!latest) return;
        // 新回合的光标落在「我们交了什么」：先记下要聚焦的字段，再 setDetail，渲染后由上面的 effect 点开它。
        pendingFocus.current = `retro-round-${created.id}-deliveryText`;
        applyDetail({ ...latest, rounds: [...latest.rounds, created] });
      } catch (reason) { await onMutationError(reason); }
    });
  }, [applyDetail, caseId, enqueue, onMutationError]);

  const moveRound = useCallback((round: RetroRoundView, step: -1 | 1) => {
    const current = detailRef.current;
    if (!current) return;
    const rounds = [...current.rounds];
    const from = rounds.findIndex((item) => item.id === round.id);
    const to = from + step;
    if (from < 0 || to < 0 || to >= rounds.length) return;
    [rounds[from], rounds[to]] = [rounds[to], rounds[from]];
    applyDetail({ ...current, rounds });
    void enqueue(async () => {
      try {
        await retroApi.orderRounds(caseId, rounds.map((item) => item.id));
        await reload();
        // 点完 ↑↓ 焦点还留在这个回合的同一个按钮上，连点几次不用重新找。
        requestAnimationFrame(() => {
          const label = step === -1 ? "上移" : "下移";
          document.querySelector<HTMLButtonElement>(`#round-${CSS.escape(round.id)} button[aria-label="${label}"]:not(:disabled)`)?.focus({ preventScroll: true });
        });
      } catch (reason) { await onMutationError(reason); }
    });
  }, [applyDetail, caseId, enqueue, onMutationError, reload]);

  const deleteRound = useCallback(async (round: RetroRoundView) => {
    await enqueue(async () => {
      try {
        await retroApi.deleteRound(caseId, round.id);
        await reload();
        notify(`已删除「${round.title}」`);
      } catch (reason) { await onMutationError(reason); }
    });
  }, [caseId, enqueue, notify, onMutationError, reload]);

  function requestDeleteRound(round: RetroRoundView) {
    // 空回合直接删；除标题外填过文字、传过附件、关联过作品的，先确认（规格 10.3）。
    if (!retroRoundHasContent(round)) { void deleteRound(round); return; }
    setRoundToDelete(round);
  }

  const saveLinks = useCallback(async (roundId: string, links: { kind: RetroLinkKind; targetId: string }[]) => {
    await retroApi.putLinks(caseId, roundId, links);
    await reload();
    setLinkRoundId(null);
    notify(`已关联 ${links.length} 个作品`);
  }, [caseId, notify, reload]);

  const removeLink = useCallback((round: RetroRoundView, linkIndex: number) => {
    const links = round.links.filter((_, index) => index !== linkIndex).map((link) => ({ kind: link.kind, targetId: link.targetId }));
    void enqueue(async () => {
      try {
        await retroApi.putLinks(caseId, round.id, links);
        await reload();
      } catch (reason) { await onMutationError(reason); }
    });
  }, [caseId, enqueue, onMutationError, reload]);

  // ---------------------------------------------------------------------------
  // 录音、客户录音、删除案例
  // ---------------------------------------------------------------------------

  function openRecordingUpload() {
    if (!detail) return;
    if (nextRetroPartNo(detail.recordings) === null) { notify(`最多 ${RETRO_LIMITS.recordingPartsMax} 段录音：先移除一段才能再传`, "warn"); return; }
    setRecordingUploadOpen(true);
  }

  async function retryRecording(recording: RetroRecordingView) {
    setRecordingActionPending(recording.id);
    try {
      await retroApi.recordingAction(recording.id, "RETRY");
      notify("已重新提交转写");
      await reload();
    } catch (reason) { notify(retroReasonText(reason, "重试没有成功，请稍后再试。"), "warn"); }
    finally { setRecordingActionPending(null); }
  }

  async function removeRecording(recording: RetroRecordingView) {
    setRecordingActionPending(recording.id);
    try {
      await retroApi.recordingAction(recording.id, "REMOVE");
      setRecordingToRemove(null);
      notify(`已移除第 ${recording.partNo} 段录音`);
      await reload();
    } catch (reason) {
      setRecordingToRemove(null);
      notify(retroReasonText(reason, "移除没有成功，请稍后再试。"), "warn");
    } finally { setRecordingActionPending(null); }
  }

  const retryAssetTranscript = useCallback(async (asset: RetroAssetView) => {
    try {
      await retroApi.retryAssetTranscript(caseId, asset.id);
      notify("已重新提交转写");
      await reload();
    } catch (reason) { notify(retroReasonText(reason, "重试没有成功，请稍后再试。"), "warn"); }
  }, [caseId, notify, reload]);

  async function trashCase() {
    setTrashPending(true);
    setTrashError("");
    try {
      await retroApi.trashCase(caseId);
      try { sessionStorage.setItem(RETRO_FLASH_KEY, `《${detail?.title ?? "案例"}》已移入回收站`); } catch { /* 存不了就不提示 */ }
      window.location.assign(LIBRARY_HREF);
    } catch (reason) {
      setTrashError(retroReasonText(reason, "删除未完成，案例未发生变化，可重试。"));
      setTrashPending(false);
    }
  }

  /** 点任何附件格：打开站内弹层。详情拿到太久了（页图签名快过期）就顺手刷新一次，不挡着打开。 */
  const openAsset = useCallback((asset: RetroAssetView) => {
    setAudioSeek(null);
    setViewerId(asset.id);
    if (Date.now() - loadedAt.current > DETAIL_STALE_MS && queued.current === 0) {
      const seq = mutationSeq.current;
      void retroApi.getCase(caseId)
        .then((next) => { if (shouldApplyPoll(seq, mutationSeq.current, queued.current)) applyDetail(next); })
        .catch(() => { /* 刷新失败就用手上的 */ });
    }
  }, [caseId, applyDetail]);

  // 同一页上的「去听原声」：本页自己处理，不整页跳转。
  const listenHere = useCallback((view: RetroSourceView): boolean => {
    const current = detailRef.current;
    if (!current || view.caseId !== current.id) return false;
    const nonce = Date.now();
    if (view.kind === "CLIENT" && view.assetId) {
      if (!findAssetGroup(current, view.assetId)) {
        notify("这段客户录音已被移除；已发布纪要里的原文来自发布时的快照", "warn");
        return true;
      }
      setViewerId(view.assetId);
      setAudioSeek({ ownerId: view.assetId, ms: view.startMs, nonce });
      return true;
    }
    setRecJump({ partNo: view.partNo, ms: view.startMs, nonce });
    setScrollTarget({ kind: "recording", id: "recording", nonce });
    return true;
  }, [notify]);
  const roundJumpHere = useCallback((mark: RetroRoundMark): boolean => {
    const current = detailRef.current;
    if (!current || mark.caseId !== current.id) return false;
    setScrollTarget({ kind: "round", id: mark.roundId, nonce: Date.now() });
    return true;
  }, []);

  const assetHost = useMemo<RetroAssetHost>(() => ({
    caseId,
    notify,
    refresh: reload,
    onOpen: openAsset,
    onRetryTranscript: (asset) => { void retryAssetTranscript(asset); },
  }), [caseId, notify, reload, openAsset, retryAssetTranscript]);

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  if (notFoundState) {
    return (
      <main className={`${v04.surface} ${styles.root}`} data-v04-page="detail">
        <section className={v04.emptyState}>
          <h2>案例不存在或已移入回收站</h2>
          <p>回收站里的案例由上传者或系统管理员恢复。</p>
          <Link href={LIBRARY_HREF}>返回客户需求复盘库</Link>
        </section>
      </main>
    );
  }
  if (loadError) {
    return (
      <main className={`${v04.surface} ${styles.root}`} data-v04-page="detail">
        <section className={v04.emptyState}><h2>案例详情读取失败</h2><p>{loadError}</p></section>
      </main>
    );
  }
  if (!detail) {
    return (
      <main className={`${v04.surface} ${styles.root}`} data-v04-page="detail">
        <section className={v04.emptyState}><h2>正在读取案例…</h2></section>
      </main>
    );
  }

  const canEdit = detail.viewerCapabilities.canEdit;
  const monthHref = `/retro/months/${encodeURIComponent(detail.monthKey)}`;
  const activeRecordings = detail.recordings.filter((recording) => recording.status !== "REMOVED");
  const linkRound = linkRoundId ? detail.rounds.find((round) => round.id === linkRoundId) : undefined;
  const nextPart = nextRetroPartNo(detail.recordings) ?? 1;
  const savedFlash = (key: string) => (savedKey === key ? <span className={styles.savedFlash} aria-live="polite">已保存</span> : null);

  const closing: Array<{ label: string; field: "outcome" | "turningPoints" | "discussionQuestions"; placeholder: string }> = [
    { label: "结果", field: "outcome", placeholder: "点击填写结果：如「客户接受第三版，开盘物料晚一周进场」「仍在进行」" },
    { label: "关键转折", field: "turningPoints", placeholder: "点击填写关键转折：你自己认为的转折点" },
    { label: "希望讨论的问题", field: "discussionQuestions", placeholder: "点击填写希望讨论的问题：想请老孙和大家一起看的问题" },
  ];
  const shownClosing = canEdit ? closing : closing.filter((item) => detail[item.field].trim() !== "");

  return (
    <main className={`${v04.surface} ${styles.root}`} data-v04-page="detail">
      <header className={v04.siteHeader}>
        <Link href={LIBRARY_HREF} className={v04.brandWordmark}><b>R:</b><span>RE:VERSE</span><small>反写</small></Link>
        <nav className={v04.siteNav} aria-label="站点导航">
          <span className={v04.headerCaseTitle} title={detail.title}>{detail.title}</span>
          <Link href={LIBRARY_HREF}>客户需求复盘库</Link>
        </nav>
        <div className={v04.siteUtilities}>
          <ThemeSwitcher />
          {user ? <UserMenu user={user} /> : <span>{viewerName}</span>}
        </div>
      </header>

      <section className={v04.detailHero}>
        <p className={v04.breadcrumb}>
          <Link href={LIBRARY_HREF}>客户需求复盘库</Link><span>/</span>
          <Link href={monthHref}>{formatRetroMonth(detail.monthKey)}</Link><span>/</span>
          <b>案例{detail.caseNumber ? ` ${detail.caseNumber}` : ""}</b>
        </p>
        <p className={v04.detailEyebrow}>{detail.department} · {detail.clientName} · {formatRetroMonth(detail.monthKey)}复盘</p>
        <h1>{detail.title}</h1>
        <div className={v04.detailTags}>
          {detail.sceneTags.map((tag) => <span key={tag}>#{tag}</span>)}
          <span>上传者 {detail.createdByName || "未知"} · {formatRetroTime(detail.createdAt)}</span>
          <span>{detail.rounds.length} 回合</span>
        </div>
        {canEdit || detail.viewerCapabilities.canTrash ? (
          <div className={styles.detailActions}>
            {canEdit ? <button type="button" className={styles.toolButton} onClick={() => setEditBasicsOpen(true)}>编辑基本信息</button> : null}
            {detail.viewerCapabilities.canTrash ? (
              <button type="button" className={`${styles.toolButton} ${styles.toolButtonDanger}`} onClick={() => { setTrashError(""); setConfirmTrash(true); }}>删除案例</button>
            ) : null}
          </div>
        ) : null}
      </section>

      <div className={v04.readingBody}>
        <section className={v04.readingModule} id="brief">
          <header><div><small>BRIEF</small><h2>任务与最初需求</h2></div></header>
          {canEdit ? (
            <div className={`${styles.prose} ${styles.proseEdit}`}>
              <V19EditableValue
                id="retro-background"
                kind="textarea"
                block
                value={detail.background}
                placeholder="点击填写任务与最初需求：客户最开始要什么，当时的背景和约束"
                ariaLabel="任务与最初需求"
                onCommit={(value) => saveCaseField("background", value)}
              />
              {savedFlash("case:background")}
            </div>
          ) : detail.background.trim()
            ? <p className={styles.prose}>{detail.background}</p>
            : <p className={`${styles.readingNote} ${styles.briefEmpty}`}>还没有填写任务与最初需求</p>}
          <RetroAssetBlock
            caseId={caseId}
            roundId={null}
            assets={detail.needAssets}
            editable={canEdit}
            variant="need"
            notify={notify}
            refresh={reload}
            onOpen={openAsset}
            onRetryTranscript={(asset) => { void retryAssetTranscript(asset); }}
          />
        </section>

        <section className={v04.readingModule}>
          <header>
            <div><small>PROCESS · {detail.rounds.length} 回合</small><h2>过程</h2></div>
            <span className={styles.moduleHeadTip}>每一回合：我们交了什么 → 客户怎么反馈 → 我们怎么应对</span>
          </header>
          {detail.rounds.length ? (
            <ol className={styles.timeline}>
              {detail.rounds.map((round, index) => (
                <RetroRoundCard
                  key={round.id}
                  round={round}
                  index={index}
                  total={detail.rounds.length}
                  editable={canEdit}
                  savedField={savedKey}
                  assetHost={assetHost}
                  onCommit={saveRoundField}
                  onMove={moveRound}
                  onDelete={requestDeleteRound}
                  onOpenLinks={(target) => setLinkRoundId(target.id)}
                  onRemoveLink={removeLink}
                />
              ))}
            </ol>
          ) : <p className={styles.roundEmpty}>还没有填过程。</p>}
          {canEdit ? (
            <div className={styles.addRoundRow}>
              {detail.rounds.length < RETRO_LIMITS.roundsMax
                ? <button type="button" className={styles.addRound} onClick={addRound}>＋ 添加一回合</button>
                : <p className={styles.recNote}>最多 {RETRO_LIMITS.roundsMax} 个回合。</p>}
            </div>
          ) : null}
        </section>

        {shownClosing.length ? (
          <section className={v04.readingModule}>
            <header><div><small>OUTCOME</small><h2>结果与讨论</h2></div></header>
            <div className={v04.readingCore}>
              {shownClosing.map((item, index) => (
                <div key={item.field} style={canEdit && index === 2 ? { gridColumn: "1 / -1", borderLeft: 0 } : undefined}>
                  <small>{item.label}</small>
                  {canEdit ? (
                    <div className={styles.coreText}>
                      <V19EditableValue
                        kind="textarea"
                        block
                        value={detail[item.field]}
                        placeholder={item.placeholder}
                        ariaLabel={item.label}
                        onCommit={(value) => saveCaseField(item.field, value)}
                      />
                      {savedFlash(`case:${item.field}`)}
                    </div>
                  ) : <p>{detail[item.field]}</p>}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <div id="recording" className={styles.recAnchor}>
          {activeRecordings.length ? (
            <section className={v04.readingModule}>
              <header>
                <div><small>RECORDING</small><h2>点评录音</h2></div>
                <span className={styles.recMeta}>任何人都能传；转写完全员可见</span>
              </header>
              <div className={styles.recBody}>
                <RetroRecordingModule
                  recordings={detail.recordings}
                  emptyTitle="还没有点评录音"
                  emptySub="上传本案例点评录音"
                  jump={recJump}
                  busyAction={recordingActionPending}
                  onUpload={openRecordingUpload}
                  onRetry={(recording) => { void retryRecording(recording); }}
                  onRemove={setRecordingToRemove}
                />
              </div>
            </section>
          ) : (
            <section className={styles.recStrip} aria-label="点评录音">
              <span><b>点评录音</b> · 开完复盘会后，把这个案例的点评录音传到这里</span>
              {detail.viewerCapabilities.canUploadRecording ? (
                <button type="button" className={v04.reviewGhostButton} onClick={openRecordingUpload}>上传</button>
              ) : null}
            </section>
          )}
        </div>

        <RetroInMinutes detail={detail} onListen={listenHere} onRoundJump={roundJumpHere} />
      </div>

      <DeleteConfirmDialog
        open={confirmTrash}
        heading="删除案例"
        title={detail.title}
        lines={[
          "案例会从客户需求复盘库中移除，可由上传者或系统管理员恢复；附件和录音文件不会被清理。",
          "已发布纪要里引用这个案例的出处仍然保留。",
        ]}
        error={trashError}
        pending={trashPending}
        onConfirm={() => void trashCase()}
        onCancel={() => setConfirmTrash(false)}
      />
      <DeleteConfirmDialog
        open={roundToDelete !== null}
        heading="删除这一回合"
        title={roundToDelete?.title ?? ""}
        question={roundToDelete ? `删除「${roundToDelete.title}」？` : undefined}
        lines={roundToDelete ? [`回合里填的内容会一起移除。已发布纪要里引用它的「${roundToDelete.title}」标记仍然能打开。`] : []}
        pending={roundDeletePending}
        confirmLabel="确认删除"
        pendingLabel="正在删除…"
        onConfirm={() => {
          const round = roundToDelete;
          if (!round) return;
          setRoundDeletePending(true);
          void deleteRound(round).finally(() => { setRoundDeletePending(false); setRoundToDelete(null); });
        }}
        onCancel={() => setRoundToDelete(null)}
      />
      <DeleteConfirmDialog
        open={recordingToRemove !== null}
        eyebrow="REMOVE"
        heading="移除这一段录音"
        title={recordingToRemove?.fileName ?? ""}
        question={recordingToRemove ? `移除第 ${recordingToRemove.partNo} 段录音「${recordingToRemove.fileName}」？` : undefined}
        lines={["移除是软删除：录音文件和文字稿都保留，已发布成果里引用它的片段仍然能打开、能播放。", "移除后可以重新上传。"]}
        pending={recordingActionPending !== null && recordingToRemove?.id === recordingActionPending}
        confirmLabel="确认移除"
        pendingLabel="正在移除…"
        onConfirm={() => { if (recordingToRemove) void removeRecording(recordingToRemove); }}
        onCancel={() => setRecordingToRemove(null)}
      />

      {editBasicsOpen ? (
        <RetroCaseDialog
          mode="edit"
          caseId={caseId}
          revision={detail.revision}
          initial={retroBasicsFromDetail(detail)}
          departments={departments}
          onClose={() => setEditBasicsOpen(false)}
          onCreated={() => setEditBasicsOpen(false)}
          onSaved={() => {
            setEditBasicsOpen(false);
            notify("已保存");
            void reload().catch(() => undefined);
          }}
        />
      ) : null}
      {linkRound ? (
        <RetroLinkPicker
          currentLinks={linkRound.links}
          notify={notify}
          onClose={() => setLinkRoundId(null)}
          onSave={(links) => saveLinks(linkRound.id, links)}
        />
      ) : null}
      {recordingUploadOpen ? (
        <RetroRecordingUploadDialog
          monthKey={detail.monthKey}
          caseId={detail.id}
          caseTitle={detail.title}
          nextPart={nextPart}
          onClose={() => setRecordingUploadOpen(false)}
          onKept={() => { void reload().catch(() => undefined); }}
          onUploaded={() => {
            setRecordingUploadOpen(false);
            notify("录音已上传，正在转写；转写完成后全员可见");
            void reload().catch(() => undefined);
          }}
        />
      ) : null}

      <RetroAssetViewer
        group={viewerGroup}
        assetId={viewerId}
        canEdit={canEdit}
        audioSeek={audioSeek}
        onNavigate={(assetId) => { setAudioSeek(null); setViewerId(assetId); }}
        onClose={() => { setViewerId(null); setAudioSeek(null); }}
        onRetryTranscript={(asset) => { void retryAssetTranscript(asset); }}
      />

      <LibraryToastStack toasts={toasts} />
    </main>
  );
}

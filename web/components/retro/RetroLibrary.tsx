"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { libraryCountLabel } from "@/lib/library-count";
import { retroApi, retroReasonText } from "@/lib/retro-client";
import { formatRetroMonth, type RetroLibraryResponse } from "@/lib/retro-model";
import {
  RETRO_FLASH_KEY,
  buildRetroCaseNumberMap,
  filterRetroCards,
  groupRetroCardsByMonth,
  hasPendingRetroWork,
  retroDepartments,
  retroMonthBadgeLabel,
} from "@/lib/retro-ui";
import { LibraryToastStack, useLibraryToast } from "@/components/shared/LibraryToast";
import v04 from "../v04/V04Surface.module.css";
import RetroCard from "./RetroCard";
import RetroCaseDialog from "./RetroCaseDialog";
import RetroRecordingUploadDialog from "./RetroRecordingUploadDialog";
import styles from "./Retro.module.css";

/** 与报告库、公共视觉库同一节奏：有录音还在转写时才轮询，标签页在后台时跳过（规格 10.1）。 */
const POLL_INTERVAL_MS = 10_000;

/**
 * 「客户需求复盘库」页签的内容（规格 10.1）：hero、工具栏（部门下拉、搜索）、按月分组的案例卡片。
 * 「新建案例」按钮在顶栏（V04LibraryClient 的 siteUtilities），这里只接它的开关；新建对话框也在这里，因为部门提示要用这里的数据。
 */
export default function RetroLibrary({
  refreshToken,
  newCaseOpen,
  onNewCaseClose,
  onRequestNew,
}: {
  /** 每次变化都触发一次完整重新加载。 */
  refreshToken: number;
  newCaseOpen: boolean;
  onNewCaseClose: () => void;
  /** 空状态里的「新建案例」：和顶栏按钮是同一个入口。 */
  onRequestNew: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<RetroLibraryResponse>({ cases: [], months: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const [committedQuery, setCommittedQuery] = useState("");
  const [department, setDepartment] = useState("ALL");
  const [recordingFor, setRecordingFor] = useState<string | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  const { toasts, notify } = useLibraryToast();

  // 别的页面（比如删除案例后）带过来的一句提示：读一次就清。
  useEffect(() => {
    try {
      const message = sessionStorage.getItem(RETRO_FLASH_KEY);
      if (!message) return;
      sessionStorage.removeItem(RETRO_FLASH_KEY);
      notify(message);
    } catch { /* 读不到就不提示 */ }
  }, [notify]);

  useEffect(() => {
    const controller = new AbortController();
    retroApi.listCases(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setData({ cases: next.cases ?? [], months: next.months ?? [] });
        setLoadError("");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(retroReasonText(reason, "客户需求复盘库暂时无法读取，请稍后重试。"));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refreshToken, localRefresh]);

  // 有录音还在上传／转写：每 10 秒悄悄拉一次；标签页在后台时跳过；失败静默重试，不打断已经展示的列表。
  const pending = hasPendingRetroWork(data.cases);
  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (document.hidden) return;
      void retroApi.listCases(controller.signal)
        .then((next) => { if (!controller.signal.aborted) setData({ cases: next.cases ?? [], months: next.months ?? [] }); })
        .catch(() => { /* 轮询失败静默重试 */ });
    }, POLL_INTERVAL_MS);
    return () => { clearInterval(timer); controller.abort(); };
  }, [pending]);

  const effectiveQuery = composing ? committedQuery : query;
  const departments = useMemo(() => retroDepartments(data.cases), [data.cases]);
  const numbers = useMemo(() => buildRetroCaseNumberMap(data.cases), [data.cases]);
  const visible = useMemo(
    () => filterRetroCards(data.cases, { department, query: effectiveQuery }),
    [data.cases, department, effectiveQuery],
  );
  const sections = useMemo(
    () => groupRetroCardsByMonth(visible, data.cases, data.months),
    [visible, data.cases, data.months],
  );
  const filtering = department !== "ALL" || effectiveQuery.trim() !== "";
  const clearFilters = useCallback(() => { setDepartment("ALL"); setQuery(""); setCommittedQuery(""); }, []);

  const recordingCase = recordingFor ? data.cases.find((card) => card.id === recordingFor) : undefined;

  return (
    <div className={styles.root}>
      <section className={v04.libraryHero}>
        <p>CLIENT NEEDS REVIEW LIBRARY</p>
        <h1>把每一次客户需求，<br />复盘成能传下去的判断。</h1>
        <span>真实案例 · 现场带教 · 方法积累</span>
      </section>
      <section className={v04.libraryToolbar}>
        <div className={styles.toolbarTitle}>
          <p>RETRO LIBRARY{loading || loadError ? null : (
            <span className={v04.libraryCount}> · {libraryCountLabel(visible.length, data.cases.length, "个案例")}</span>
          )}</p>
          <h2>客户需求复盘库</h2>
        </div>
        <div className={`${v04.libraryToolbarControls} ${styles.toolbarControls}`}>
          <select
            className={styles.deptSelect}
            aria-label="按部门筛选"
            value={department}
            disabled={loading}
            onChange={(event) => setDepartment(event.target.value)}
          >
            <option value="ALL">全部部门</option>
            {departments.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <label className={`${v04.librarySearch} ${styles.toolbarSearch}`}>
            <span aria-hidden><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="7.2" cy="7.2" r="4.6"/><path d="M10.6 10.6 14 14"/></svg></span>
            <input
              aria-label="搜索案例"
              value={query}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={(event) => {
                setComposing(false);
                setQuery(event.currentTarget.value);
                setCommittedQuery(event.currentTarget.value);
              }}
              onChange={(event) => {
                setQuery(event.target.value);
                if (!composing) setCommittedQuery(event.target.value);
              }}
              placeholder="搜索客户、项目、标题、部门或场景"
            />
          </label>
        </div>
      </section>

      {loading ? (
        <section className={v04.emptyState}><h2>正在读取客户需求复盘库…</h2></section>
      ) : loadError ? (
        <section className={v04.emptyState}><h2>客户需求复盘库读取失败</h2><p>{loadError}</p></section>
      ) : !visible.length ? (
        filtering ? (
          <section className={v04.emptyState}>
            <span>⌕</span>
            <h2>没有找到对应案例</h2>
            <p>换一个客户、标题、部门或场景，或者清掉部门筛选。</p>
            <button type="button" onClick={clearFilters}>清空搜索和筛选</button>
          </section>
        ) : (
          <section className={v04.emptyState}>
            <span>＋</span>
            <h2>还没有案例</h2>
            <p>会前把案例的来龙去脉填好，现场可以直接打开案例页投屏讲。</p>
            <button type="button" onClick={onRequestNew}>新建案例</button>
          </section>
        )
      ) : (
        sections.map((section) => {
          const status = retroMonthBadgeLabel(section.badge);
          return (
            <section className={v04.weekSection} key={section.monthKey} aria-label={`${formatRetroMonth(section.monthKey)}的案例`}>
              <div className={v04.weekHeading}>
                <h3>{formatRetroMonth(section.monthKey)}</h3>
                <span>{libraryCountLabel(section.items.length, section.total, "个案例")} · 录音 {section.recordedCaseCount} / {section.total}</span>
                <div className={styles.monthHeadRight}>
                  <span className={styles.monthStatus} data-tone={status.tone}><i />{status.label}</span>
                  <Link className={styles.monthEnter} href={`/retro/months/${encodeURIComponent(section.monthKey)}`}>进入本月 →</Link>
                </div>
              </div>
              <div className={v04.caseGrid}>
                {section.items.map((card) => (
                  <RetroCard key={card.id} card={card} caseNumber={numbers.get(card.id) ?? 0} onRecord={setRecordingFor} />
                ))}
              </div>
            </section>
          );
        })
      )}

      <LibraryToastStack toasts={toasts} />
      {newCaseOpen ? (
        <RetroCaseDialog
          mode="create"
          departments={departments}
          onClose={onNewCaseClose}
          onCreated={(caseId) => {
            onNewCaseClose();
            router.push(`/retro/${encodeURIComponent(caseId)}?created=1`);
          }}
          onSaved={onNewCaseClose}
        />
      ) : null}
      {recordingFor && recordingCase ? (
        <RetroRecordingUploadDialog
          monthKey={recordingCase.monthKey}
          caseId={recordingCase.id}
          caseTitle={recordingCase.title}
          nextPart={1}
          onClose={() => setRecordingFor(null)}
          onKept={() => setLocalRefresh((token) => token + 1)}
          onUploaded={() => {
            setRecordingFor(null);
            notify("录音已上传，正在转写；转写完成后全员可见");
            setLocalRefresh((token) => token + 1);
          }}
        />
      ) : null}
    </div>
  );
}

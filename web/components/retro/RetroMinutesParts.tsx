"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type JSX } from "react";
import {
  RETRO_DIMENSION_LABELS,
  RETRO_KIND_LABELS,
  RETRO_LIMITS,
  RETRO_METHOD_DIMENSION_LIST,
  RETRO_METHOD_KIND_LIST,
  RETRO_METHOD_TRANSFER_LIST,
  RETRO_TRANSFER_LABELS,
  type RetroCaseReview,
  type RetroDraftSection,
  type RetroItem,
  type RetroMethodCandidate,
  type RetroMethodDimension,
  type RetroMethodKind,
  type RetroMethods,
  type RetroMinutes,
  type RetroMethodTransfer,
  type RetroSource,
} from "@/lib/retro-model";
import type { RetroSourceContext } from "@/lib/retro-ui";
import { RetroSourceMarks, type RetroListenHandler, type RetroRoundJumpHandler } from "./RetroSourceMarks";
import v04 from "../v04/V04Surface.module.css";
import styles from "./Retro.module.css";

/** 草稿里一条内容的定位：哪一节、（案例节）哪个案例、哪一条。 */
export type RetroDraftTarget = { section: RetroDraftSection; caseId?: string; itemId: string };
export const retroDraftKey = (target: RetroDraftTarget) => `${target.section}|${target.caseId ?? ""}|${target.itemId}`;

export type RetroCandidateValue = {
  title: string;
  description: string;
  dimension: RetroMethodDimension;
  kind: RetroMethodKind;
  situation: string;
  transfer: RetroMethodTransfer;
  transferNote: string;
};

/** 老孙审阅草稿时的操作（规格 6.6）；只读视图（已发布版本、案例页的「在本月纪要里」）不传这个。 */
export type RetroDraftController = {
  editingKey: string | null;
  /** 正在补充的一条（还没发给服务端：写完离开输入框才发）。 */
  adding: RetroDraftSection | null;
  defaultCandidate: Pick<RetroCandidateValue, "dimension" | "kind">;
  startEdit: (target: RetroDraftTarget) => void;
  commitText: (target: RetroDraftTarget, text: string) => void;
  cancelEdit: () => void;
  remove: (target: RetroDraftTarget) => void;
  startAdd: (section: RetroDraftSection) => void;
  commitAddText: (section: RetroDraftSection, text: string) => void;
  commitAddCandidate: (value: RetroCandidateValue) => void;
  cancelAdd: () => void;
  /** 方法候选的字段改动：随时保存，返回错误文字（没有就是 null）。 */
  patchCandidate: (target: RetroDraftTarget, value: Partial<RetroCandidateValue>) => Promise<string | null>;
  finishCandidate: () => void;
};

export type RetroCaseInfo = { number: number | null; client: string; title: string; department: string; deleted: boolean };

export type RetroMinutesCtx = {
  source: RetroSourceContext;
  caseInfo: (caseId: string) => RetroCaseInfo | null;
  onListen?: RetroListenHandler;
  onRoundJump?: RetroRoundJumpHandler;
  draft?: RetroDraftController | null;
};

// ---------------------------------------------------------------------------
// 一条内容：文字 + 老孙补充／已改标签 + 出处标记 + （草稿）悬停的「改」「删」
// ---------------------------------------------------------------------------

function TextEditor({ initial, hint, maxLength, onCommit, onCancel }: {
  initial: string;
  hint: string;
  maxLength: number;
  onCommit: (text: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initial);
  const cancelled = useRef(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);
  return (
    <div className={styles.itemEditor}>
      <textarea
        ref={ref}
        className={styles.eArea}
        value={value}
        maxLength={maxLength}
        placeholder="写下这一条…"
        aria-label="编辑这一条"
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => { if (!cancelled.current) onCommit(value.trim()); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); cancelled.current = true; onCancel(); }
        }}
      />
      <div className={styles.editorRow}><span>{hint}</span></div>
    </div>
  );
}

function ItemContent({ item, target, ctx, allowDelete = true }: {
  item: RetroItem;
  target: RetroDraftTarget;
  ctx: RetroMinutesCtx;
  allowDelete?: boolean;
}): JSX.Element {
  const draft = ctx.draft;
  if (draft && draft.editingKey === retroDraftKey(target)) {
    return (
      <TextEditor
        initial={item.text}
        maxLength={RETRO_LIMITS.draftTextMax}
        hint={`离开输入框自动保存${item.origin === "MANUAL" ? " · 老孙补充，可以不带出处" : ""} · Esc 放弃`}
        onCommit={(text) => draft.commitText(target, text)}
        onCancel={draft.cancelEdit}
      />
    );
  }
  return (
    <>
      <span className={styles.itemText}>{item.text}</span>
      {item.origin === "MANUAL" ? <span className={styles.manualTag}>老孙补充</span> : null}
      {draft && item.edited && item.origin !== "MANUAL" ? <span className={styles.editedTag}>已改</span> : null}
      <RetroSourceMarks sources={item.sources} ctx={ctx.source} onListen={ctx.onListen} onRoundJump={ctx.onRoundJump} />
      {draft ? (
        <span className={styles.itemActs}>
          <button type="button" onClick={() => draft.startEdit(target)}>改</button>
          {allowDelete ? <button type="button" className={styles.danger} onClick={() => draft.remove(target)}>删</button> : null}
        </span>
      ) : null}
    </>
  );
}

export function RetroItemList({ items, section, caseId, ctx, addable }: {
  items: readonly RetroItem[];
  section: RetroDraftSection;
  caseId?: string;
  ctx: RetroMinutesCtx;
  addable: boolean;
}): JSX.Element {
  const draft = ctx.draft;
  return (
    <>
      {items.length ? (
        <ul className={styles.itemList}>
          {items.map((item) => (
            <li className={styles.draftItem} key={item.id}>
              <ItemContent item={item} target={{ section, caseId, itemId: item.id }} ctx={ctx} />
            </li>
          ))}
        </ul>
      ) : <p className={styles.recNote}>{draft ? "（这一节是空的）" : "没有。"}</p>}
      {draft && addable ? (
        draft.adding === section ? (
          <TextEditor
            initial=""
            maxLength={RETRO_LIMITS.draftTextMax}
            hint="离开输入框自动保存 · 标「老孙补充」，可以不带出处 · 留空放弃"
            onCommit={(text) => draft.commitAddText(section, text)}
            onCancel={draft.cancelAdd}
          />
        ) : <button type="button" className={styles.addItem} onClick={() => draft.startAdd(section)}>＋ 补充一条</button>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// 教学纪要
// ---------------------------------------------------------------------------

export function RetroCaseReviewGrid({ review, ctx }: { review: RetroCaseReview; ctx: RetroMinutesCtx }): JSX.Element {
  const processItem: RetroItem = { id: "process", text: review.process, sources: review.processSources, origin: "AI", edited: false };
  return (
    <div className={styles.minGrid}>
      <div className={styles.wide}>
        <small>经过</small>
        <div className={styles.draftItem}>
          <ItemContent item={processItem} target={{ section: "case.process", caseId: review.caseId, itemId: "process" }} ctx={ctx} allowDelete={false} />
        </div>
      </div>
      <div>
        <small>关键争议</small>
        <RetroItemList items={review.disputes} section="case.disputes" caseId={review.caseId} ctx={ctx} addable={false} />
      </div>
      <div>
        <small>老孙指出的问题</small>
        <RetroItemList items={review.founderPoints} section="case.founderPoints" caseId={review.caseId} ctx={ctx} addable={false} />
      </div>
      <div className={styles.wide}>
        <small>改进建议</small>
        <RetroItemList items={review.suggestions} section="case.suggestions" caseId={review.caseId} ctx={ctx} addable={false} />
      </div>
    </div>
  );
}

export function RetroMinutesView({ minutes, ctx }: { minutes: RetroMinutes; ctx: RetroMinutesCtx }): JSX.Element {
  const rows = [
    ...minutes.cases.map((review) => ({ caseId: review.caseId, review })),
    ...minutes.unanalyzedCaseIds.map((caseId) => ({ caseId, review: null as RetroCaseReview | null })),
  ]
    .sort((a, b) => (ctx.caseInfo(a.caseId)?.number ?? 0) - (ctx.caseInfo(b.caseId)?.number ?? 0));
  return (
    <>
      <section className={v04.readingModule}>
        <header>
          <div><small>PART 1 · {rows.length} 个案例</small><h2>案例简要回顾</h2></div>
          <span className={styles.recMeta}>每案的经过、争议、问题、建议直接取自逐案提炼</span>
        </header>
        {rows.map(({ caseId, review }) => {
          const info = ctx.caseInfo(caseId);
          return (
            <div className={styles.minCase} key={caseId}>
              <div className={styles.minCaseHead}>
                <b>案例 {info?.number ?? "?"}</b>
                {info && !info.deleted ? <Link href={`/retro/${encodeURIComponent(caseId)}`}>{info.title}</Link> : <span>{info?.title ?? "（案例）"}</span>}
                <span>{info ? `${info.department} · ${info.client}` : ""}{info?.deleted ? " · 已移入回收站" : ""}</span>
              </div>
              {review === null
                ? <p className={styles.minSkip}>这个案例没有录音，列在清单里，不参与提炼。</p>
                : review.empty
                  ? <p className={styles.minSkip}>这个案例没有提炼出有依据的内容。</p>
                  : <RetroCaseReviewGrid review={review} ctx={ctx} />}
            </div>
          );
        })}
      </section>
      <section className={v04.readingModule}>
        <header>
          <div><small>PART 2</small><h2>本次培训的核心认识</h2></div>
          <span className={styles.recMeta}>跨案例归纳，按实际讨论来，不凑数</span>
        </header>
        <div className={styles.secBody}><RetroItemList items={minutes.insights} section="insights" ctx={ctx} addable /></div>
      </section>
      <section className={v04.readingModule}>
        <header>
          <div><small>PART 3</small><h2>可以进入实际工作的改进事项</h2></div>
          <span className={styles.recMeta}>只留能执行的：什么时候、谁、做什么</span>
        </header>
        <div className={styles.secBody}><RetroItemList items={minutes.actions} section="actions" ctx={ctx} addable /></div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// 方法提取记录
// ---------------------------------------------------------------------------

export type RetroMethodFilters = { dimension: RetroMethodDimension | "ALL"; kind: RetroMethodKind | "ALL" };

function FilterPill({ pressed, label, onClick }: { pressed: boolean; label: string; onClick: () => void }): JSX.Element {
  return <button type="button" className={styles.partPill} aria-pressed={pressed} onClick={onClick}>{label}</button>;
}

function CandidateEditor({ candidate, isNew, ctx, onDone }: {
  candidate: RetroCandidateValue & { id?: string };
  isNew: boolean;
  ctx: RetroMinutesCtx;
  onDone: (value: RetroCandidateValue) => string | null;
}): JSX.Element {
  const draft = ctx.draft!;
  const [local, setLocal] = useState<RetroCandidateValue>({
    title: candidate.title,
    description: candidate.description,
    dimension: candidate.dimension,
    kind: candidate.kind,
    situation: candidate.situation,
    transfer: candidate.transfer,
    transferNote: candidate.transferNote,
  });
  const [error, setError] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);
  const target: RetroDraftTarget = { section: "candidates", itemId: candidate.id ?? "" };

  /** 随时保存：改一项发一项；情境类还没写情境时，类别和情境一起等着，写好再发（服务端不收「情境类没有情境」）。 */
  async function save(patch: Partial<RetroCandidateValue>, next: RetroCandidateValue) {
    if (isNew) return;
    const send: Partial<RetroCandidateValue> = { ...patch };
    if (next.kind === "SITUATIONAL" && !next.situation.trim()) { delete send.kind; delete send.situation; }
    else if ("kind" in patch || "situation" in patch) { send.kind = next.kind; send.situation = next.situation; }
    if ("title" in send && !next.title.trim()) delete send.title;
    if (!Object.keys(send).length) return;
    const problem = await draft.patchCandidate(target, send);
    setError(problem ?? "");
  }
  function set<K extends keyof RetroCandidateValue>(key: K, value: RetroCandidateValue[K], immediate: boolean) {
    const next = { ...local, [key]: value };
    setLocal(next);
    if (immediate) void save({ [key]: value } as Partial<RetroCandidateValue>, next);
  }
  function blur<K extends keyof RetroCandidateValue>(key: K) {
    void save({ [key]: local[key] } as Partial<RetroCandidateValue>, local);
  }
  function done() {
    const problem = !local.title.trim() ? "标题不能为空。" : local.kind === "SITUATIONAL" && !local.situation.trim() ? "情境类的方法候选必须写明是什么情境。" : "";
    if (problem) { setError(problem); return; }
    const failure = onDone({ ...local, title: local.title.trim() });
    if (failure) setError(failure);
  }

  return (
    <article className={styles.methodCard}>
      <div className={`${styles.itemEditor} ${styles.methodEditor}`}>
        <label>标题<input ref={titleRef} className={styles.eInput} maxLength={RETRO_LIMITS.draftTitleMax} value={local.title}
          onChange={(event) => set("title", event.target.value, false)} onBlur={() => blur("title")} /></label>
        <label>描述<textarea className={`${styles.eArea} ${styles.eAreaBox}`} maxLength={RETRO_LIMITS.draftTextMax} value={local.description}
          onChange={(event) => set("description", event.target.value, false)} onBlur={() => blur("description")} /></label>
        <div className={styles.editorGrid}>
          <label>维度<select value={local.dimension} onChange={(event) => set("dimension", event.target.value as RetroMethodDimension, true)}>
            {RETRO_METHOD_DIMENSION_LIST.map((key) => <option key={key} value={key}>{RETRO_DIMENSION_LABELS[key]}</option>)}</select></label>
          <label>类别<select value={local.kind} onChange={(event) => set("kind", event.target.value as RetroMethodKind, true)}>
            {RETRO_METHOD_KIND_LIST.map((key) => <option key={key} value={key}>{RETRO_KIND_LABELS[key]}</option>)}</select></label>
          <label>迁移性<select value={local.transfer} onChange={(event) => set("transfer", event.target.value as RetroMethodTransfer, true)}>
            {RETRO_METHOD_TRANSFER_LIST.map((key) => <option key={key} value={key}>{RETRO_TRANSFER_LABELS[key]}</option>)}</select></label>
        </div>
        {local.kind === "SITUATIONAL" ? (
          <label>情境 *（情境类必须写明是什么情境）<input className={styles.eInput} maxLength={RETRO_LIMITS.draftTextMax} value={local.situation}
            onChange={(event) => set("situation", event.target.value, false)} onBlur={() => blur("situation")} /></label>
        ) : null}
        <label>迁移性理由<input className={styles.eInput} maxLength={RETRO_LIMITS.draftTextMax} value={local.transferNote}
          onChange={(event) => set("transferNote", event.target.value, false)} onBlur={() => blur("transferNote")} /></label>
        {error ? <p className={styles.editorError} role="alert">{error}</p> : null}
        <div className={styles.editorRow}>
          <span>{isNew ? "点「完成」才会补充进草稿" : "改动随时保存"}</span>
          <span className={styles.grow} />
          {isNew ? <button type="button" className={v04.reviewGhostButton} onClick={draft.cancelAdd}>放弃</button> : null}
          <button type="button" className={v04.reviewPrimaryButton} onClick={done}>完成</button>
        </div>
      </div>
    </article>
  );
}

function CandidateCard({ candidate, ctx }: { candidate: RetroMethodCandidate; ctx: RetroMinutesCtx }): JSX.Element {
  const draft = ctx.draft;
  const target: RetroDraftTarget = { section: "candidates", itemId: candidate.id };
  if (draft && draft.editingKey === retroDraftKey(target)) {
    return <CandidateEditor candidate={candidate} isNew={false} ctx={ctx} onDone={() => { draft.finishCandidate(); return null; }} />;
  }
  const sources: readonly RetroSource[] = candidate.sources;
  return (
    <article className={styles.methodCard}>
      <div className={styles.methodTop}>
        <span className={styles.methodNo}>#{String(candidate.number).padStart(2, "0")}</span>
        <span className={styles.dimChip}>{RETRO_DIMENSION_LABELS[candidate.dimension]}</span>
        <span className={styles.kindMark} data-kind={candidate.kind}><i />{RETRO_KIND_LABELS[candidate.kind]}</span>
        {candidate.origin === "MANUAL" ? <span className={styles.manualTag} style={{ margin: 0 }}>老孙补充</span> : null}
        {draft && candidate.edited && candidate.origin !== "MANUAL" ? <span className={styles.editedTag} style={{ margin: 0 }}>已改</span> : null}
      </div>
      <h4>{candidate.title || "（未命名）"}</h4>
      {candidate.description ? <p>{candidate.description}</p> : null}
      {candidate.kind === "SITUATIONAL" ? <p className={styles.situation}><b>情境　</b>{candidate.situation}</p> : null}
      <p className={styles.transfer}><b>迁移性　</b>{RETRO_TRANSFER_LABELS[candidate.transfer]}{candidate.transferNote ? ` · ${candidate.transferNote}` : ""}</p>
      {sources.length ? (
        <div className={styles.sources}>
          <RetroSourceMarks sources={sources} ctx={ctx.source} onListen={ctx.onListen} onRoundJump={ctx.onRoundJump} />
        </div>
      ) : <p className={styles.recNote}>没有出处（老孙补充）</p>}
      {draft ? (
        <span className={styles.itemActs}>
          <button type="button" onClick={() => draft.startEdit(target)}>改</button>
          <button type="button" className={styles.danger} onClick={() => draft.remove(target)}>删</button>
        </span>
      ) : null}
    </article>
  );
}

export function RetroMethodsView({ methods, ctx, filters, onFilters }: {
  methods: RetroMethods;
  ctx: RetroMinutesCtx;
  filters: RetroMethodFilters;
  onFilters: (next: RetroMethodFilters) => void;
}): JSX.Element {
  const draft = ctx.draft;
  const list = methods.candidates.filter((candidate) => (
    (filters.dimension === "ALL" || candidate.dimension === filters.dimension)
    && (filters.kind === "ALL" || candidate.kind === filters.kind)
  ));
  // 按维度顺序排列，组内按编号；不按出现次数排序，也不打重要度分（规格三-5）。
  const groups = RETRO_METHOD_DIMENSION_LIST
    .map((dimension) => ({ dimension, items: list.filter((candidate) => candidate.dimension === dimension).sort((a, b) => a.number - b.number) }))
    .filter((group) => group.items.length);

  return (
    <>
      <p className={styles.methodIntro}>
        以下都是<b>方法候选</b>，由 AI 从老孙的点评中提取，每条都有录音出处；是否成为正式方法，要经多次案例支持和老孙审定。按分析维度排列，不按出现次数排序。
      </p>
      <div className={styles.filterRows}>
        <div className={styles.filterRow} role="group" aria-label="按维度筛选">
          <span>维度</span>
          <FilterPill pressed={filters.dimension === "ALL"} label="全部" onClick={() => onFilters({ ...filters, dimension: "ALL" })} />
          {RETRO_METHOD_DIMENSION_LIST.map((key) => (
            <FilterPill key={key} pressed={filters.dimension === key} label={RETRO_DIMENSION_LABELS[key]} onClick={() => onFilters({ ...filters, dimension: key })} />
          ))}
        </div>
        <div className={styles.filterRow} role="group" aria-label="按类别筛选">
          <span>类别</span>
          <FilterPill pressed={filters.kind === "ALL"} label="全部" onClick={() => onFilters({ ...filters, kind: "ALL" })} />
          {RETRO_METHOD_KIND_LIST.map((key) => (
            <FilterPill key={key} pressed={filters.kind === key} label={RETRO_KIND_LABELS[key]} onClick={() => onFilters({ ...filters, kind: key })} />
          ))}
        </div>
      </div>
      {groups.length ? groups.map((group) => (
        <section className={styles.methodGroup} key={group.dimension}>
          <h3>{RETRO_DIMENSION_LABELS[group.dimension]}<span>{group.items.length} 条</span></h3>
          <div className={styles.methodCards}>
            {group.items.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} ctx={ctx} />)}
          </div>
        </section>
      )) : <p className={styles.histNote}>没有符合筛选的方法候选。</p>}
      {draft ? (
        draft.adding === "candidates" ? (
          <div className={styles.methodCards} style={{ marginBottom: 22 }}>
            <CandidateEditor
              candidate={{ title: "", description: "", situation: "", transfer: "UNSURE", transferNote: "", ...draft.defaultCandidate }}
              isNew
              ctx={ctx}
              onDone={(value) => { draft.commitAddCandidate(value); return null; }}
            />
          </div>
        ) : <button type="button" className={styles.addItem} style={{ margin: "0 0 22px" }} onClick={() => draft.startAdd("candidates")}>＋ 补充一条方法候选</button>
      ) : null}
      <section className={v04.readingModule}>
        <header>
          <div><small>OBSERVATIONS</small><h2>本月观察</h2></div>
          <span className={styles.recMeta}>同一思路在不同情境下的差异、看似矛盾的判断</span>
        </header>
        <div className={styles.secBody}><RetroItemList items={methods.observations} section="observations" ctx={ctx} addable /></div>
      </section>
    </>
  );
}

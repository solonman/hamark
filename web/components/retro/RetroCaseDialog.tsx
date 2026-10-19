"use client";

import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import { retroApi, retroReasonText } from "@/lib/retro-client";
import { RETRO_LIMITS } from "@/lib/retro-model";
import {
  blankRetroBasics,
  buildRetroBasicsInput,
  retroBasicsClosable,
  retroEditMonthChoices,
  retroMonthChoices,
  validateRetroBasics,
  type RetroBasicsDraft,
} from "@/lib/retro-ui";
import report from "../report/library/ReportLibrary.module.css";
import styles from "./Retro.module.css";

/**
 * 新建案例／编辑基本信息（规格 10.4）：同一个外壳（ReportUploadDialog 的壳：uploadDialog／field／two／hint／formError／uploadFooter），
 * 新建眉题 NEW CASE、编辑眉题 EDIT。只有五项基本信息；任务与最初需求、过程在案例页里原位填。
 * 校验顺序：月份 → 部门 → 客户 → 标题，报错写在 formError 里；点遮罩和按 Esc 只在表单还空着（编辑时：没改过）才关闭。
 */
export default function RetroCaseDialog({
  mode,
  initial,
  caseId,
  revision,
  departments,
  onClose,
  onCreated,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: RetroBasicsDraft;
  /** 编辑时必填。 */
  caseId?: string;
  /** 编辑时的乐观锁（案例的 revision）。 */
  revision?: number;
  /** 部门输入框的下拉提示：已有的部门名。 */
  departments: readonly string[];
  onClose: () => void;
  onCreated: (caseId: string) => void;
  onSaved: () => void;
}): JSX.Element {
  const titleId = useId();
  const listId = useId();
  const monthRef = useRef<HTMLSelectElement>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  const [draft, setDraft] = useState<RetroBasicsDraft>(() => initial ?? blankRetroBasics());
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const edit = mode === "edit";

  const months = useMemo(
    () => (edit ? retroEditMonthChoices(initial?.monthKey ?? "") : retroMonthChoices()),
    [edit, initial?.monthKey],
  );
  const closable = !pending && retroBasicsClosable(mode, draft, dirty);

  useEffect(() => { monthRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && closable) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closable, onClose]);

  function update<K extends keyof RetroBasicsDraft>(key: K, value: RetroBasicsDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  async function submit() {
    const problem = validateRetroBasics(draft, months.map((month) => month.key));
    if (problem) {
      setError(problem);
      requestAnimationFrame(() => formErrorRef.current?.scrollIntoView({ block: "nearest" }));
      return;
    }
    setError("");
    setPending(true);
    try {
      const input = buildRetroBasicsInput(draft);
      if (edit) {
        if (!caseId || revision === undefined) throw new Error("缺少案例信息，无法保存。");
        await retroApi.patchCase(caseId, { ...input, revision });
        onSaved();
      } else {
        const created = await retroApi.createCase(input);
        onCreated(created.caseId);
      }
    } catch (reason) {
      setError(retroReasonText(reason, "没有保存成功，请重试。"));
      setPending(false);
    }
  }

  return (
    <div className={styles.root}>
      <div
        className={report.uploadBackdrop}
        role="presentation"
        onMouseDown={(event) => { if (event.target === event.currentTarget && closable) onClose(); }}
      >
        <section className={`${report.uploadDialog} ${styles.dialog}`} role="dialog" aria-modal="true" aria-labelledby={titleId} data-retro-case-dialog={mode}>
          <div className={`${report.uploadHead} ${styles.dialogHead}`}>
            <div><small>{edit ? "EDIT" : "NEW CASE"}</small><b id={titleId}>{edit ? "编辑基本信息" : "新建案例"}</b></div>
            <button type="button" className={report.uploadClose} onClick={onClose} aria-label="关闭" disabled={pending}>×</button>
          </div>
          <div className={report.uploadBody}>
            {edit ? null : (
              <p className={report.hint}>
                先填基本信息并创建；任务与最初需求、过程（每一回合：我们交了什么 → 客户怎么反馈 → 我们怎么应对）在案例页里点一下就能填，离开输入框自动保存。
              </p>
            )}
            <div className={report.two}>
              <label className={report.field}>
                <small>复盘月份 *</small>
                <select ref={monthRef} value={draft.monthKey} onChange={(event) => update("monthKey", event.target.value)}>
                  {months.map((month) => <option key={month.key} value={month.key}>{month.label}</option>)}
                </select>
              </label>
              <label className={report.field}>
                <small>部门 *</small>
                <input
                  list={listId}
                  maxLength={RETRO_LIMITS.departmentMax}
                  value={draft.department}
                  placeholder="如：服务一组"
                  onChange={(event) => update("department", event.target.value)}
                />
                <datalist id={listId}>{departments.map((name) => <option key={name} value={name} />)}</datalist>
              </label>
            </div>
            <label className={report.field}>
              <small>客户 *</small>
              <input
                maxLength={RETRO_LIMITS.clientMax}
                value={draft.clientName}
                placeholder="如：某地产 · 滨江项目"
                onChange={(event) => update("clientName", event.target.value)}
              />
            </label>
            <label className={report.field}>
              <small>案例标题 *</small>
              <input
                maxLength={RETRO_LIMITS.titleMax}
                value={draft.title}
                placeholder="一句话说清这件事，如：滨江项目开盘主形象三次被否"
                onChange={(event) => update("title", event.target.value)}
              />
            </label>
            <label className={report.field}>
              <small>客户服务场景 <i>选填，逗号分隔，最多 {RETRO_LIMITS.sceneTagsMax} 个</i></small>
              <input
                value={draft.sceneTagsText}
                placeholder="提案、改稿、案名、开盘节点、客户情绪、需求变更、比稿"
                onChange={(event) => update("sceneTagsText", event.target.value)}
              />
            </label>
            {error ? <p className={report.formError} role="alert" ref={formErrorRef}>{error}</p> : null}
          </div>
          <div className={`${report.uploadFooter} ${styles.dialogFoot}`}>
            <button type="button" onClick={onClose} disabled={pending}>取消</button>
            <button type="button" className={report.uploadGo} disabled={pending} onClick={() => void submit()}>
              {pending ? (edit ? "保存中…" : "创建中…") : edit ? "保存" : "创建并填写过程 →"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

"use client";

import { useRef } from "react";
import type { ReportAnnotation } from "@/lib/report-structure";
import type { ReportDetail, ReportFileView } from "@/lib/report-model";
import { V19SystemValue } from "@/components/v04/V19EditableValue";
import type { CaseReviewComment } from "@/lib/case-review";
import ReportFieldItem from "./ReportFieldItem";
import styles from "./ReportStudio.module.css";

/**
 * 第一部分｜案例背景与资料。字段清单见规格 2.2：城市、开发商、项目背景（多行）、
 * 业务背景（多行）、相关资料（文件列表）；任务类型与来源信息只读，不进 `annotation`
 * （相关资料同样不进 payload，走独立的 `report_files` 接口，见规格 3.1）。
 */

const fmtSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

const fileExt = (name: string): string => {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1].toUpperCase() : "FILE";
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type ReportPartOneReview = {
  canReview: boolean;
  disabled: boolean;
  /** 每个条目在报告所有版本上的评论列表，见 `ReportFieldItem.tsx` 顶部注释。 */
  comments: ReadonlyMap<string, CaseReviewComment[]>;
  /** 当前正在看的版本 id，用来判定 `comments` 里哪一条是「本版」。 */
  currentVersionId: string | null;
  onSave: (input: { targetKey: string; targetLabel: string; body: string }) => Promise<void>;
};

export type ReportPartOneFiles = {
  items: ReportFileView[];
  /** 只有正在编辑自己版本时才能改共享的相关资料列表（规格外的口径见任务说明第 4 条）。 */
  canManage: boolean;
  busy: boolean;
  error: string;
  onUpload: (files: FileList) => void;
  onDelete: (fileId: string) => void;
};

export type ReportPartOneProps = {
  report: ReportDetail;
  annotation: ReportAnnotation;
  readOnly: boolean;
  onChange: (next: ReportAnnotation) => void;
  review: ReportPartOneReview;
  files: ReportPartOneFiles;
};

export default function ReportPartOne({
  report,
  annotation,
  readOnly,
  onChange,
  review,
  files,
}: ReportPartOneProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const patchBackground = (patch: Partial<ReportAnnotation["background"]>) => {
    onChange({ ...annotation, background: { ...annotation.background, ...patch } });
  };

  const fieldReview = (targetKey: string, label: string) => ({
    targetKey,
    targetLabel: label,
    canReview: review.canReview,
    comments: review.comments.get(targetKey) ?? [],
    currentVersionId: review.currentVersionId,
    disabled: review.disabled,
    onSave: review.onSave,
  });

  return (
    <div className={styles.form2}>
      <ReportFieldItem
        label="城市"
        value={annotation.background.city}
        readOnly={readOnly}
        onCommit={(next) => patchBackground({ city: next })}
        review={fieldReview("background.city", "城市")}
      />
      <ReportFieldItem
        label="开发商"
        value={annotation.background.developer}
        readOnly={readOnly}
        onCommit={(next) => patchBackground({ developer: next })}
        review={fieldReview("background.developer", "开发商")}
      />
      <ReportFieldItem
        label="项目背景"
        kind="textarea"
        wide
        value={annotation.background.projectBackground}
        readOnly={readOnly}
        onCommit={(next) => patchBackground({ projectBackground: next })}
        review={fieldReview("background.projectBackground", "项目背景")}
      />
      <ReportFieldItem
        label="业务背景"
        kind="textarea"
        wide
        value={annotation.background.businessBackground}
        readOnly={readOnly}
        onCommit={(next) => patchBackground({ businessBackground: next })}
        review={fieldReview("background.businessBackground", "业务背景")}
      />

      <div className={`${styles.item} ${styles.wide}`}>
        <small>任务类型</small>
        <span className={styles.chip}>{report.taskType || "未选择"}</span>
      </div>

      <div className={`${styles.item} ${styles.wide}`}>
        <small>相关资料</small>
        <div className={styles.upload}>
          {files.items.map((file) => (
            <div className={styles.file} key={file.id}>
              <i>{fileExt(file.originalName)}</i>
              <a href={file.url} target="_blank" rel="noreferrer" title={file.originalName}>
                {file.originalName}
              </a>
              <em>{fmtSize(file.fileSize)}</em>
              {files.canManage ? (
                <button type="button" title="移除" disabled={files.busy} onClick={() => files.onDelete(file.id)}>
                  ×
                </button>
              ) : null}
            </div>
          ))}
          {files.canManage ? (
            <label className={styles.dropzone}>
              <input
                ref={inputRef}
                type="file"
                multiple
                hidden
                disabled={files.busy}
                onChange={(event) => {
                  if (event.target.files?.length) files.onUpload(event.target.files);
                  event.target.value = "";
                }}
              />
              <b>{files.busy ? "上传中…" : "＋ 添加文件"}</b>
              <span>PPT／PDF／图片／文档</span>
            </label>
          ) : files.items.length === 0 ? (
            <p className={styles.uploadEmpty}>还没有相关资料。</p>
          ) : null}
          {files.error ? <p className={styles.fieldError}>{files.error}</p> : null}
        </div>
      </div>

      <div className={`${styles.trace} ${styles.wide}`}>
        <h4>来源信息</h4>
        <dl>
          <div>
            <dt>来源文件</dt>
            <dd><V19SystemValue>{report.originalName}</V19SystemValue></dd>
          </div>
          <div>
            <dt>文件格式</dt>
            <dd><V19SystemValue>{report.sourceFormat}</V19SystemValue></dd>
          </div>
          <div>
            <dt>页数</dt>
            <dd><V19SystemValue>{report.pageCount} 页</V19SystemValue></dd>
          </div>
          <div>
            <dt>原页序</dt>
            <dd><V19SystemValue>{report.pageCount ? `p1–p${report.pageCount}` : "—"}</V19SystemValue></dd>
          </div>
          <div>
            <dt>任务类型</dt>
            <dd><V19SystemValue>{report.taskType || "上传时未选"}</V19SystemValue></dd>
          </div>
          <div>
            <dt>上传</dt>
            <dd><V19SystemValue>{report.createdByName} · {formatDate(report.createdAt)}</V19SystemValue></dd>
          </div>
        </dl>
        <p>来自上传的文件，不需要填写。</p>
      </div>
    </div>
  );
}

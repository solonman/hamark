"use client";

import { guessMediaKind } from "@/lib/upload-dedup/fingerprint-browser";
import type { UploadDuplicateMatch } from "@/lib/upload-dedup/model";
import styles from "./DuplicateUploadNotice.module.css";
import type { UploadDuplicateCheck } from "./use-upload-duplicate-check";

/**
 * 上传对话框里的查重提示（docs/28 六）。放在文件区正下方：人刚选完文件，眼睛就在这儿，
 * 所以不用浮层 toast——它几秒就消失，而这里要逐条列出「在哪一条里」并等人点「仍要上传」。
 * 多文件对话框传 showFileNames，每条前面标出是这次选的哪个文件。
 */
export default function DuplicateUploadNotice({
  check,
  showFileNames = false,
  onAcknowledged,
  onCancel,
  paper = false,
}: {
  check: UploadDuplicateCheck;
  showFileNames?: boolean;
  /** 选完文件就直接上传的对话框：点了「仍要上传」接着就传。 */
  onAcknowledged?: () => void;
  /** 不在对话框里的入口（复盘附件格）没有「关闭」可点，给一个「不传了」。 */
  onCancel?: () => void;
  /** 视频库那两个上传框是写死的浅色纸底，不跟主题走；这里也固定用浅色那套琥珀色。 */
  paper?: boolean;
}) {
  const tone = paper ? ` ${styles.paper}` : "";
  if (!check.findings.length) {
    return check.checking ? <p className={`${styles.checking}${tone}`}>正在比对是否已传过…</p> : null;
  }
  return (
    <div className={`${styles.notice}${tone}`} role="alert">
      <b className={styles.head}>可能已经传过</b>
      <ul className={styles.list}>
        {check.findings.flatMap(({ file, matches }) =>
          matches.map((match, index) => (
            <li key={`${file.name}-${file.size}-${index}`}>
              <span className={styles.reason}>{reasonLabel(match, guessMediaKind(file))}</span>
              <span className={styles.where}>
                {showFileNames ? <>「{file.name}」</> : null}
                {match.reason === "SAME_BATCH" ? (
                  <>和这次选的「{match.title}」是同一个文件</>
                ) : (
                  <>已在《{match.title}》{match.detail ? <> · {match.detail}</> : null}</>
                )}
              </span>
              {match.reason === "SAME_BATCH" ? null : <small className={styles.meta}>{metaLine(match)}</small>}
              {match.href ? (
                <a className={styles.open} href={match.href} target="_blank" rel="noopener noreferrer">
                  打开那条
                </a>
              ) : null}
            </li>
          )),
        )}
      </ul>
      {check.needsAcknowledge ? (
        <div className={styles.foot}>
          <span>确实要再传一份的话：</span>
          <button
            type="button"
            className={styles.ack}
            onClick={() => {
              check.acknowledge();
              onAcknowledged?.();
            }}
          >
            仍要上传
          </button>
          {onCancel ? (
            <button type="button" className={styles.cancel} onClick={onCancel}>不传了</button>
          ) : null}
        </div>
      ) : (
        <p className={styles.acked}>已确认仍要上传。</p>
      )}
    </div>
  );
}

function reasonLabel(match: UploadDuplicateMatch, kind: string): string {
  switch (match.reason) {
    case "SAME_FILE":
      return "同一个文件";
    case "SAME_BATCH":
      return "这次选了两遍";
    case "SIMILAR":
      return kind === "VIDEO" && match.similarity !== null
        ? `内容相似（约 ${Math.round(match.similarity * 100)}% 的画面对得上）`
        : "画面相似";
    case "SAME_SIZE":
      return match.sameName ? "疑似重复（文件名和大小都一样）" : "疑似重复（大小完全一样）";
  }
}

function metaLine(match: UploadDuplicateMatch): string {
  const parts = [
    match.uploaderName,
    match.uploadedAt ? match.uploadedAt.slice(0, 10) : "",
    match.width && match.height ? `${match.width}×${match.height}` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

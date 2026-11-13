"use client";

// 上传对话框里的查重：选好文件就在浏览器里算指纹、问服务端有没有传过（docs/28 六）。
// 只提醒、不拦截：发现重复后要上传人点一下「仍要上传」，提交前用 settle() 判断能不能走。

import { useCallback, useEffect, useReducer, useRef } from "react";
import { fingerprintFile, guessMediaKind } from "@/lib/upload-dedup/fingerprint-browser";
import type {
  UploadDedupLibrary,
  UploadDuplicateMatch,
  UploadFingerprint,
  UploadFingerprintSource,
} from "@/lib/upload-dedup/model";

export const DUPLICATE_PENDING_MESSAGE = "先看一下上面的重复提示，确认后再上传。";

/** 提交时最多等比对这么久；到点还没比完就照常上传（只提醒的功能不能拖住上传）。 */
const SETTLE_LIMIT_MS = 30000;

export type DuplicateFinding = { file: File; matches: UploadDuplicateMatch[] };

export type UploadDuplicateCheck = {
  checking: boolean;
  findings: DuplicateFinding[];
  needsAcknowledge: boolean;
  acknowledge: () => void;
  /**
   * 等比对结束；返回 true 表示可以提交（没有重复，或已点过「仍要上传」）。
   * 选完文件就立刻上传的对话框（老孙点评）可以直接传这个文件进来，不用等下一次渲染。
   */
  settle: (files?: readonly File[]) => Promise<boolean>;
};

type Store = {
  fingerprints: Map<File, UploadFingerprint>;
  results: Map<File, UploadDuplicateMatch[]>;
  pending: Map<File, Promise<void>>;
  acknowledged: string;
};

function uniqueFiles(files: readonly File[]): File[] {
  return Array.from(new Set(files));
}

/** 同一次选的文件里有两个一模一样的（多文件对话框）。 */
function batchMatches(file: File, files: readonly File[], store: Store): UploadDuplicateMatch[] {
  const mine = store.fingerprints.get(file);
  if (!mine?.sha) return [];
  const earlier = files.slice(0, files.indexOf(file)).find((other) => {
    const theirs = store.fingerprints.get(other);
    return theirs?.sha === mine.sha && theirs.size === mine.size;
  });
  if (!earlier) return [];
  return [{
    reason: "SAME_BATCH",
    similarity: null,
    sameName: earlier.name === file.name,
    title: earlier.name,
    detail: "",
    href: null,
    uploaderName: "",
    uploadedAt: "",
    width: null,
    height: null,
  }];
}

function derive(files: readonly File[], store: Store) {
  const current = uniqueFiles(files);
  const findings = current
    .map((file) => ({ file, matches: [...batchMatches(file, current, store), ...(store.results.get(file) ?? [])] }))
    .filter((finding) => finding.matches.length > 0);
  // 换了文件、或者冒出新的重复，都要重新确认一次。
  const signature = findings
    .map(({ file, matches }) => `${file.name}|${file.size}|${matches.map((match) => `${match.reason}:${match.href ?? match.title}`).join(",")}`)
    .join(";");
  return {
    current,
    findings,
    checking: current.some((file) => store.pending.has(file)),
    signature,
    needsAcknowledge: findings.length > 0 && store.acknowledged !== signature,
  };
}

export function useUploadDuplicateCheck(
  files: readonly File[],
  options: { library: UploadDedupLibrary; excludeOwnerId?: string | null },
): UploadDuplicateCheck {
  const { library, excludeOwnerId = null } = options;
  const storeRef = useRef<Store>({ fingerprints: new Map(), results: new Map(), pending: new Map(), acknowledged: "" });
  const filesRef = useRef(files);
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    filesRef.current = files;
  });

  const run = useCallback((targets: readonly File[]) => {
    const store = storeRef.current;
    const fresh = uniqueFiles(targets).filter((file) => !store.results.has(file) && !store.pending.has(file));
    if (!fresh.length) return;
    const job = (async () => {
      let results: Record<string, UploadDuplicateMatch[]> = {};
      try {
        const fingerprints = await Promise.all(fresh.map((file) => fingerprintFile(file, guessMediaKind(file))));
        fresh.forEach((file, index) => store.fingerprints.set(file, fingerprints[index]));
        const response = await fetch("/api/upload-dedup/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            library,
            excludeOwnerId,
            files: fingerprints.map((fingerprint, index) => ({ ...fingerprint, key: String(index) })),
          }),
        });
        if (response.ok) results = ((await response.json()) as { results?: typeof results }).results ?? {};
      } catch {
        // 查重失败不挡上传：当作没发现。
      }
      fresh.forEach((file, index) => store.results.set(file, results[String(index)] ?? []));
    })();
    fresh.forEach((file) => store.pending.set(file, job));
    void job.finally(() => {
      fresh.forEach((file) => store.pending.delete(file));
      rerender();
    });
    rerender();
  }, [library, excludeOwnerId]);

  useEffect(() => {
    run(files);
  }, [files, run]);

  const derived = derive(files, storeRef.current);
  const { signature } = derived;

  const acknowledge = useCallback(() => {
    storeRef.current.acknowledged = signature;
    rerender();
  }, [signature]);

  const settle = useCallback(async (explicit?: readonly File[]) => {
    const store = storeRef.current;
    if (explicit) run(explicit);
    const targets = () => explicit ?? filesRef.current;
    const deadline = Date.now() + SETTLE_LIMIT_MS;
    for (;;) {
      const waiting = uniqueFiles(targets()).map((file) => store.pending.get(file)).filter(Boolean);
      const left = deadline - Date.now();
      if (!waiting.length || left <= 0) break;
      await Promise.race([Promise.all(waiting), new Promise((resolve) => setTimeout(resolve, left))]);
    }
    return !derive(targets(), store).needsAcknowledge;
  }, [run]);

  return {
    checking: derived.checking,
    findings: derived.findings,
    needsAcknowledge: derived.needsAcknowledge,
    acknowledge,
    settle,
  };
}

/** 上传入库后登记这份文件的指纹。不等结果、失败不提示：缺一条指纹只是以后少认出一次重复。 */
export function recordUploadFingerprint(source: UploadFingerprintSource, targetId: string, file: File) {
  void fingerprintFile(file, guessMediaKind(file))
    .then((fingerprint) =>
      fetch("/api/upload-dedup/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, targetId, fingerprint: { ...fingerprint, mirrorHashes: [] } }),
        keepalive: true,
      }),
    )
    .catch(() => undefined);
}

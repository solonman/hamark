export type SaveResponseBody = {
  error?: string;
  code?: string;
  annotationId?: string;
  revision?: number;
  serverRevision?: number;
  updatedAt?: string;
};

export type SaveOutcome =
  | {
      kind: "saved";
      annotationId: string;
      revision: number;
      updatedAt: string | null;
    }
  | { kind: "conflict"; serverRevision: number; message: string }
  | { kind: "failed"; message: string };

const conflictMessage =
  "这份作业在另一个页面被保存过，本页的修改还没有写入。请选择保留哪一份。";

// The draft PUT rejects a stale revision so a forgotten second tab cannot silently
// overwrite newer work. The server hands back the winning revision precisely so the
// losing page can rebase instead of stranding everything the user has typed.
export function interpretSaveResponse(
  status: number,
  body: SaveResponseBody,
): SaveOutcome {
  if (
    status === 409 &&
    body.code === "REVISION_CONFLICT" &&
    typeof body.serverRevision === "number"
  ) {
    return {
      kind: "conflict",
      serverRevision: body.serverRevision,
      message: conflictMessage,
    };
  }

  if (status >= 200 && status < 300) {
    if (body.annotationId && typeof body.revision === "number") {
      return {
        kind: "saved",
        annotationId: body.annotationId,
        revision: body.revision,
        updatedAt: body.updatedAt ?? null,
      };
    }
    return { kind: "failed", message: body.error || "保存失败" };
  }

  return { kind: "failed", message: body.error || "保存失败" };
}

// Adopting the server's revision keeps the page's own content and re-sends it as the
// next revision, which is what the draft PUT already does (it rewrites the whole
// document). It must stay an explicit user choice: doing it automatically would make
// the losing tab overwrite the other one without anybody being told.
export function rebaseOntoServerRevision<T extends { revision: number }>(
  draft: T,
  serverRevision: number,
): T {
  return { ...draft, revision: serverRevision };
}

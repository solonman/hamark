"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { V04UiDraft } from "@/lib/v04-ui-model";

type VideoState = { caseId: string; currentTime: number; minimized: boolean; floating: boolean };
type WorkspaceSession = { tabToken: string; leaseProof: { tabToken: string; leaseToken: string; leaseVersion: number } | null };

type SessionValue = {
  drafts: Record<string, V04UiDraft>;
  setDraft: (caseId: string, draft: V04UiDraft) => void;
  video: VideoState;
  updateVideo: (next: Partial<VideoState>) => void;
  getWorkspaceSession: (caseId: string) => WorkspaceSession;
  setWorkspaceLeaseProof: (caseId: string, proof: WorkspaceSession["leaseProof"]) => void;
};

const SessionContext = createContext<SessionValue | null>(null);
const WORKSPACE_TAB_TOKEN = /^v04-workspace-[a-f0-9-]{36}$/;

export function getOrCreateV04WorkspaceTabToken(
  caseId: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  createId: () => string = () => crypto.randomUUID(),
) {
  const key = `hamark:v04:workspace-tab:${encodeURIComponent(caseId)}`;
  try {
    const existing = storage?.getItem(key);
    if (existing && WORKSPACE_TAB_TOKEN.test(existing)) return { tabToken: existing, persisted: true };
    if (!storage) throw new Error("SESSION_STORAGE_UNAVAILABLE");
    const tabToken = `v04-workspace-${createId().toLowerCase()}`;
    if (!WORKSPACE_TAB_TOKEN.test(tabToken)) throw new Error("INVALID_WORKSPACE_TAB_TOKEN");
    storage.setItem(key, tabToken);
    return { tabToken, persisted: true };
  } catch {
    const tabToken = `v04-workspace-${createId().toLowerCase()}`;
    if (!WORKSPACE_TAB_TOKEN.test(tabToken)) throw new Error("INVALID_WORKSPACE_TAB_TOKEN");
    return { tabToken, persisted: false };
  }
}

export function V04VideoSessionProvider({ children }: { children: React.ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, V04UiDraft>>({});
  const [video, setVideo] = useState<VideoState>({ caseId: "", currentTime: 0, minimized: false, floating: false });
  const workspaceSessions = useRef(new Map<string, WorkspaceSession>());
  const setDraft = useCallback((caseId: string, draft: V04UiDraft) => {
    setDrafts((current) => ({ ...current, [caseId]: structuredClone(draft) }));
  }, []);
  const updateVideo = useCallback((next: Partial<VideoState>) => setVideo((current) => ({ ...current, ...next })), []);
  const getWorkspaceSession = useCallback((caseId: string) => {
    const existing = workspaceSessions.current.get(caseId);
    if (existing) return existing;
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { /* retain an in-memory tab identity */ }
    const created = {
      tabToken: getOrCreateV04WorkspaceTabToken(caseId, storage).tabToken,
      leaseProof: null,
    };
    workspaceSessions.current.set(caseId, created);
    return created;
  }, []);
  const setWorkspaceLeaseProof = useCallback((caseId: string, proof: WorkspaceSession["leaseProof"]) => {
    const current = getWorkspaceSession(caseId);
    workspaceSessions.current.set(caseId, { ...current, leaseProof: proof });
  }, [getWorkspaceSession]);
  const value = useMemo(() => ({ drafts, setDraft, video, updateVideo, getWorkspaceSession, setWorkspaceLeaseProof }), [drafts, setDraft, video, updateVideo, getWorkspaceSession, setWorkspaceLeaseProof]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useV04VideoSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("V04VideoSessionProvider is required");
  return value;
}

"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { claimV04DocumentIdentity, V04DocumentIdentityClaimRegistry } from "@/lib/v04-document-identity";
import type { V04UiDraft } from "@/lib/v04-ui-model";

type VideoState = { caseId: string; currentTime: number; minimized: boolean; floating: boolean };
type WorkspaceSession = {
  tabToken: string;
  recoveryTabId: string;
  identityPersisted: boolean;
  identityFailClosed: boolean;
  leaseProof: { tabToken: string; leaseToken: string; leaseVersion: number } | null;
};
type WorkspaceSessionEntry = {
  promise: Promise<WorkspaceSession>;
  session: WorkspaceSession | null;
};

type SessionValue = {
  drafts: Record<string, V04UiDraft>;
  setDraft: (caseId: string, draft: V04UiDraft) => void;
  video: VideoState;
  updateVideo: (next: Partial<VideoState>) => void;
  getWorkspaceSession: (caseId: string) => Promise<WorkspaceSession>;
  setWorkspaceLeaseProof: (caseId: string, proof: WorkspaceSession["leaseProof"]) => void;
};

const SessionContext = createContext<SessionValue | null>(null);

export function V04VideoSessionProvider({ children }: { children: React.ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, V04UiDraft>>({});
  const [video, setVideo] = useState<VideoState>({ caseId: "", currentTime: 0, minimized: false, floating: false });
  const workspaceSessions = useRef(new Map<string, WorkspaceSessionEntry>());
  const lifecycleVersion = useRef(0);
  const [identityClaims] = useState(() => new V04DocumentIdentityClaimRegistry((caseId, signal) => {
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { /* claimant chooses a fail-closed memory identity */ }
    return claimV04DocumentIdentity({ caseId, storage, signal });
  }));
  const setDraft = useCallback((caseId: string, draft: V04UiDraft) => {
    setDrafts((current) => ({ ...current, [caseId]: structuredClone(draft) }));
  }, []);
  const updateVideo = useCallback((next: Partial<VideoState>) => setVideo((current) => ({ ...current, ...next })), []);
  const getWorkspaceSession = useCallback((caseId: string) => {
    const existing = workspaceSessions.current.get(caseId);
    if (existing) return existing.promise;
    const entry: WorkspaceSessionEntry = {
      promise: Promise.resolve(null as unknown as WorkspaceSession),
      session: null,
    };
    entry.promise = identityClaims.get(caseId).then((claim) => {
      entry.session = {
        tabToken: claim.identity.workspaceTabToken,
        recoveryTabId: claim.identity.recoveryTabId,
        identityPersisted: claim.persisted,
        identityFailClosed: claim.failClosed,
        leaseProof: null,
      };
      return entry.session;
    });
    workspaceSessions.current.set(caseId, entry);
    return entry.promise;
  }, [identityClaims]);
  const setWorkspaceLeaseProof = useCallback((caseId: string, proof: WorkspaceSession["leaseProof"]) => {
    const current = getWorkspaceSession(caseId);
    void current.then((session) => { session.leaseProof = proof; });
  }, [getWorkspaceSession]);
  useEffect(() => {
    const sessions = workspaceSessions.current;
    lifecycleVersion.current += 1;
    return () => {
      const disposalVersion = ++lifecycleVersion.current;
      // React development StrictMode immediately re-runs effects after its
      // probe cleanup. A microtask distinguishes that probe from a real
      // unmount without letting a late asynchronous claim survive either.
      queueMicrotask(() => {
        if (lifecycleVersion.current !== disposalVersion) return;
        identityClaims.dispose();
        sessions.clear();
      });
    };
  }, [identityClaims]);
  const value = useMemo(() => ({ drafts, setDraft, video, updateVideo, getWorkspaceSession, setWorkspaceLeaseProof }), [drafts, setDraft, video, updateVideo, getWorkspaceSession, setWorkspaceLeaseProof]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useV04VideoSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("V04VideoSessionProvider is required");
  return value;
}

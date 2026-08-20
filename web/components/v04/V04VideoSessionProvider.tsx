"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { V04UiDraft } from "@/lib/v04-ui-model";

type VideoState = { caseId: string; currentTime: number; minimized: boolean; floating: boolean };

type SessionValue = {
  drafts: Record<string, V04UiDraft>;
  setDraft: (caseId: string, draft: V04UiDraft) => void;
  video: VideoState;
  updateVideo: (next: Partial<VideoState>) => void;
};

const SessionContext = createContext<SessionValue | null>(null);

export function V04VideoSessionProvider({ children }: { children: React.ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, V04UiDraft>>({});
  const [video, setVideo] = useState<VideoState>({ caseId: "", currentTime: 0, minimized: false, floating: false });
  const setDraft = useCallback((caseId: string, draft: V04UiDraft) => {
    setDrafts((current) => ({ ...current, [caseId]: structuredClone(draft) }));
  }, []);
  const updateVideo = useCallback((next: Partial<VideoState>) => setVideo((current) => ({ ...current, ...next })), []);
  const value = useMemo(() => ({ drafts, setDraft, video, updateVideo }), [drafts, setDraft, video, updateVideo]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useV04VideoSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("V04VideoSessionProvider is required");
  return value;
}

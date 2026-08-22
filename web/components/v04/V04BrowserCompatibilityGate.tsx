"use client";

import { useEffect, useState } from "react";
import { probeV04BrowserCompatibility, type V04BrowserMode } from "@/lib/v04-browser-compat";
import V04BrowserCompatibilityMessage from "./V04BrowserCompatibilityMessage";

export default function V04BrowserCompatibilityGate({
  mode,
  children,
}: {
  mode: V04BrowserMode;
  children: React.ReactNode;
}) {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void probeV04BrowserCompatibility({ mode }).then((result) => {
      if (active) setSupported(result.supported);
    });
    return () => { active = false; };
  }, [mode]);
  if (supported === null) return <V04BrowserCompatibilityMessage mode={mode} checking />;
  if (!supported) return <V04BrowserCompatibilityMessage mode={mode} />;
  return children;
}

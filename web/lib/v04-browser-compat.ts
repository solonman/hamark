export const V04_BROWSER_MINIMUMS = {
  chrome: 111,
  edge: 111,
  firefox: 111,
  safari: { major: 16, minor: 4 },
} as const;

export const V04_UNSAFE_EDITING_MESSAGE =
  "当前浏览器版本或隐私设置不支持安全保存。为避免草稿丢失，本页没有进入编辑状态。请升级浏览器，或改用最新版 Edge、Chrome、Firefox、Safari。";

export const V04_UNSUPPORTED_BROWSER_MESSAGE =
  "当前浏览器版本过旧，无法安全使用案例库、视频、上传与工作稿。请升级到 Chrome、Edge、Firefox 111 或更高版本，或 Safari 16.4 或更高版本。";

export type V04BrowserMode = "READ" | "EDIT";

export type V04BrowserCapabilityIssue =
  | "INSECURE_CONTEXT"
  | "FETCH_UNAVAILABLE"
  | "ABORT_UNAVAILABLE"
  | "RANDOM_UUID_UNAVAILABLE"
  | "STRUCTURED_CLONE_UNAVAILABLE"
  | "FORM_DATA_UNAVAILABLE"
  | "FILE_UNAVAILABLE"
  | "READABLE_STREAM_UNAVAILABLE"
  | "VIDEO_UNAVAILABLE"
  | "INTERSECTION_OBSERVER_UNAVAILABLE"
  | "PAGE_LIFECYCLE_UNAVAILABLE"
  | "SESSION_STORAGE_UNAVAILABLE"
  | "LOCAL_STORAGE_UNAVAILABLE"
  | "WEB_LOCKS_UNAVAILABLE";

type ProbeStorage = Pick<Storage, "setItem" | "getItem" | "removeItem" | "key" | "length">;

export type V04BrowserLockManager = {
  request: <T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<T> | T,
  ) => Promise<T>;
};

export type V04BrowserEnvironment = {
  secureContext: boolean;
  hasFetch: boolean;
  hasAbortController: boolean;
  hasRandomUUID: boolean;
  hasStructuredClone: boolean;
  hasFormData: boolean;
  hasFile: boolean;
  hasReadableStream: boolean;
  hasVideo: boolean;
  hasIntersectionObserver: boolean;
  hasPageLifecycle: boolean;
  sessionStorage: ProbeStorage | null;
  localStorage: ProbeStorage | null;
  lockManager: V04BrowserLockManager | null;
  createAbortController: (() => AbortController) | null;
  createId: (() => string) | null;
};

export type V04BrowserProbeResult = {
  supported: boolean;
  issues: V04BrowserCapabilityIssue[];
};

export type V04LegacyBrowserBlock = {
  engine: "IE" | "EDGEHTML" | "CHROME" | "EDGE" | "FIREFOX" | "SAFARI";
  detectedVersion: string;
};

function safeStorage(kind: "sessionStorage" | "localStorage"): ProbeStorage | null {
  try {
    return window[kind];
  } catch {
    return null;
  }
}

export function getV04BrowserEnvironment(): V04BrowserEnvironment {
  let lockManager: V04BrowserLockManager | null = null;
  try {
    lockManager = navigator.locks as V04BrowserLockManager;
  } catch {
    lockManager = null;
  }
  return {
    secureContext: window.isSecureContext,
    hasFetch: typeof window.fetch === "function",
    hasAbortController: typeof window.AbortController === "function",
    hasRandomUUID: typeof window.crypto?.randomUUID === "function",
    hasStructuredClone: typeof window.structuredClone === "function",
    hasFormData: typeof window.FormData === "function",
    hasFile: typeof window.File === "function",
    hasReadableStream: typeof window.ReadableStream === "function",
    hasVideo: typeof window.HTMLVideoElement === "function",
    hasIntersectionObserver: typeof window.IntersectionObserver === "function",
    hasPageLifecycle:
      "onpagehide" in window && "onbeforeunload" in window && "ononline" in window &&
      typeof document.visibilityState === "string",
    sessionStorage: safeStorage("sessionStorage"),
    localStorage: safeStorage("localStorage"),
    lockManager,
    createAbortController: typeof window.AbortController === "function"
      ? () => new window.AbortController()
      : null,
    createId: typeof window.crypto?.randomUUID === "function"
      ? () => window.crypto.randomUUID()
      : null,
  };
}

function staticIssues(environment: V04BrowserEnvironment): V04BrowserCapabilityIssue[] {
  const issues: V04BrowserCapabilityIssue[] = [];
  if (!environment.secureContext) issues.push("INSECURE_CONTEXT");
  if (!environment.hasFetch) issues.push("FETCH_UNAVAILABLE");
  if (!environment.hasAbortController) issues.push("ABORT_UNAVAILABLE");
  if (!environment.hasRandomUUID) issues.push("RANDOM_UUID_UNAVAILABLE");
  if (!environment.hasStructuredClone) issues.push("STRUCTURED_CLONE_UNAVAILABLE");
  if (!environment.hasFormData) issues.push("FORM_DATA_UNAVAILABLE");
  if (!environment.hasFile) issues.push("FILE_UNAVAILABLE");
  if (!environment.hasReadableStream) issues.push("READABLE_STREAM_UNAVAILABLE");
  if (!environment.hasVideo) issues.push("VIDEO_UNAVAILABLE");
  if (!environment.hasIntersectionObserver) issues.push("INTERSECTION_OBSERVER_UNAVAILABLE");
  if (!environment.hasPageLifecycle) issues.push("PAGE_LIFECYCLE_UNAVAILABLE");
  return issues;
}

function probeStorage(input: {
  storage: ProbeStorage | null;
  key: string;
  value: string;
  enumerate: boolean;
}) {
  const { storage, key, value, enumerate } = input;
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    if (storage.getItem(key) !== value) return false;
    if (enumerate) {
      let foundProbeKey = false;
      const length = storage.length;
      for (let index = 0; index < length; index += 1) {
        if (storage.key(index) === key) {
          foundProbeKey = true;
          break;
        }
      }
      if (!foundProbeKey) return false;
    }
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch {
    return false;
  } finally {
    try { storage.removeItem(key); } catch { /* best-effort cleanup; probe fails closed above */ }
  }
}

async function probeWebLock(environment: V04BrowserEnvironment, timeoutMs: number) {
  if (!environment.lockManager?.request || !environment.createAbortController || !environment.createId) {
    return false;
  }
  const controller = environment.createAbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, timeoutMs);
    });
    const requested = Promise.resolve(environment.lockManager.request(
      `hamark:v04:browser-capability:${environment.createId()}`,
      // Web Locks rejects with NotSupportedError when `signal` is combined with
      // `ifAvailable`. The non-blocking request cannot hang, so the abort
      // controller only guards a broken implementation via the race below.
      { mode: "exclusive", ifAvailable: true },
      (lock) => Boolean(lock) && !controller.signal.aborted,
    )).catch(() => false);
    return await Promise.race([requested, timedOut]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeV04BrowserCompatibility(input: {
  mode: V04BrowserMode;
  environment?: V04BrowserEnvironment;
  lockTimeoutMs?: number;
}): Promise<V04BrowserProbeResult> {
  const environment = input.environment ?? getV04BrowserEnvironment();
  const issues = staticIssues(environment);
  if (input.mode === "EDIT") {
    const sessionProbeId = environment.createId?.() ?? "unavailable-session";
    const localProbeId = environment.createId?.() ?? "unavailable-local";
    if (!probeStorage({
      storage: environment.sessionStorage,
      key: `hamark:v04:probe:session:${sessionProbeId}`,
      value: `hamark:v04:probe-value:session:${sessionProbeId}`,
      enumerate: false,
    })) {
      issues.push("SESSION_STORAGE_UNAVAILABLE");
    }
    if (!probeStorage({
      storage: environment.localStorage,
      key: `hamark:v04:probe:local:${localProbeId}`,
      value: `hamark:v04:probe-value:local:${localProbeId}`,
      enumerate: true,
    })) {
      issues.push("LOCAL_STORAGE_UNAVAILABLE");
    }
    if (!await probeWebLock(environment, input.lockTimeoutMs ?? 1_500)) {
      issues.push("WEB_LOCKS_UNAVAILABLE");
    }
  }
  return { supported: issues.length === 0, issues: [...new Set(issues)] };
}

function belowSafariMinimum(major: number, minor: number) {
  return major < V04_BROWSER_MINIMUMS.safari.major ||
    (major === V04_BROWSER_MINIMUMS.safari.major && minor < V04_BROWSER_MINIMUMS.safari.minor);
}

export function detectV04LegacyBrowser(userAgent: string): V04LegacyBrowserBlock | null {
  if (/\b(?:MSIE\s|Trident\/)/i.test(userAgent)) {
    const version = userAgent.match(/(?:MSIE\s|rv:)([\d.]+)/i)?.[1] ?? "unknown";
    return { engine: "IE", detectedVersion: version };
  }
  const edgeHtml = userAgent.match(/\bEdge\/([\d.]+)/i);
  if (edgeHtml) return { engine: "EDGEHTML", detectedVersion: edgeHtml[1] };

  const edge = userAgent.match(/\bEdg\/([\d.]+)/i);
  if (edge && Number(edge[1].split(".")[0]) < V04_BROWSER_MINIMUMS.edge) {
    return { engine: "EDGE", detectedVersion: edge[1] };
  }
  const firefox = userAgent.match(/\bFirefox\/([\d.]+)/i);
  if (firefox && Number(firefox[1].split(".")[0]) < V04_BROWSER_MINIMUMS.firefox) {
    return { engine: "FIREFOX", detectedVersion: firefox[1] };
  }
  const chrome = userAgent.match(/\bChrome\/([\d.]+)/i);
  if (chrome && !edge && Number(chrome[1].split(".")[0]) < V04_BROWSER_MINIMUMS.chrome) {
    return { engine: "CHROME", detectedVersion: chrome[1] };
  }
  const safari = userAgent.match(/\bVersion\/(\d+)(?:\.(\d+))?[\d.]*[^\n]*\bSafari\//i);
  if (safari) {
    const major = Number(safari[1]);
    const minor = Number(safari[2] ?? 0);
    if (belowSafariMinimum(major, minor)) {
      return { engine: "SAFARI", detectedVersion: `${major}.${minor}` };
    }
  }
  return null;
}

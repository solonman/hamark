const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLocalDemoMode() {
  return process.env.LOCAL_DEMO_MODE === "1" && process.env.NODE_ENV === "development";
}

export function requireLocalDemoMode() {
  if (!isLocalDemoMode()) {
    throw new Error("Local demo mode is disabled.");
  }
}

export function localDemoAppUrl() {
  requireLocalDemoMode();
  const value = process.env.APP_URL?.trim() || "http://localhost:3000";
  const url = new URL(value);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    throw new Error("Local demo APP_URL must be an HTTP loopback address.");
  }
  return url.toString().replace(/\/$/, "");
}

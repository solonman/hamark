const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLocalDemoMode() {
  return process.env.LOCAL_DEMO_MODE === "1" && process.env.NODE_ENV === "development";
}

export function requireLocalDemoMode() {
  if (!isLocalDemoMode()) {
    throw new Error("Local demo mode is disabled.");
  }
}

// Local demo mode swaps in local object storage and a passwordless demo login, but it
// does not swap the database. Pointed at a real DATABASE_URL it would hand demo
// identities full read/write access to live data and seed the demo dataset into
// tables the project treats as immutable, so refuse anything that is not loopback.
// The connection string carries a password and must never reach the message.
export function assertLocalDemoDatabase(connectionString: string) {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Local demo DATABASE_URL is not a valid connection string.");
  }
  if (!loopbackHosts.has(url.hostname)) {
    throw new Error(
      `Local demo refuses to use the database at ${url.hostname}. ` +
        "Point DATABASE_URL at a loopback host, or unset LOCAL_DEMO_MODE.",
    );
  }
  return connectionString;
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

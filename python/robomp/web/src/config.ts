// Auth posture injected by FastAPI at request time. The server replaces the
// `__ROBOMP_CONFIG__` sentinel in the built `index.html` with a JSON blob so
// the SPA knows whether replay auth is on without an extra round-trip. The
// blob never carries the token itself — `GET /` is unauthenticated, so the
// credential is fetched from the token-gated `GET /api/config` instead and
// kept in sessionStorage for the tab's lifetime.

export interface AppConfig {
  replayEnabled: boolean;
}

const TOKEN_STORAGE_KEY = "robomp-replay-token";

function readConfig(): AppConfig {
  const node = document.getElementById("robomp-config");
  const text = node?.textContent?.trim();
  if (!text || text === "__ROBOMP_CONFIG__") {
    return { replayEnabled: false };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") {
      return { replayEnabled: false };
    }
    return { replayEnabled: Boolean((parsed as Record<string, unknown>).replayEnabled) };
  } catch {
    return { replayEnabled: false };
  }
}

export const CONFIG: AppConfig = readConfig();

/** The token the operator entered this session, or null. */
export function storedReplayToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, sandboxed iframe): behave as if no
    // token was entered; requests then fail with the server's 401.
    return null;
  }
}

export function saveReplayToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Same as above: unauthenticated requests surface the failure in the UI.
  }
}

/** Headers to attach to every privileged API call. */
export function authHeaders(): Record<string, string> {
  const token = storedReplayToken();
  return token ? { "X-Robomp-Replay-Token": token } : {};
}

export const POLL_INTERVAL_MS = 3000;

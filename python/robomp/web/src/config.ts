// Configuration injected by FastAPI at request time. The server replaces the
// `__ROBOMP_CONFIG__` sentinel in `static/index.html` with a JSON blob so the
// SPA never needs to make an extra round-trip just to learn whether the
// trigger surface is enabled.

export interface AppConfig {
  replayEnabled: boolean;
  replayToken: string;
}

function readConfig(): AppConfig {
  const node = document.getElementById("robomp-config");
  const text = node?.textContent?.trim();
  if (!text || text === "__ROBOMP_CONFIG__") {
    return { replayEnabled: false, replayToken: "" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") {
      return { replayEnabled: false, replayToken: "" };
    }
    const record = parsed as Record<string, unknown>;
    return {
      replayEnabled: Boolean(record.replayEnabled),
      replayToken: typeof record.replayToken === "string" ? record.replayToken : "",
    };
  } catch {
    return { replayEnabled: false, replayToken: "" };
  }
}

export const CONFIG: AppConfig = readConfig();

export const AUTH_HEADERS: Readonly<Record<string, string>> = CONFIG.replayEnabled
  ? Object.freeze({ "X-Robomp-Replay-Token": CONFIG.replayToken })
  : Object.freeze({});

export const POLL_INTERVAL_MS = 3000;

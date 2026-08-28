// Configuration injected by FastAPI at request time. The server replaces the
// `__ROBOMP_CONFIG__` sentinel in `static/index.html` with a JSON blob so the
// SPA never needs to make an extra round-trip just to learn whether the
// trigger surface is enabled.
function readConfig() {
    const node = document.getElementById("robomp-config");
    const text = node?.textContent?.trim();
    if (!text || text === "__ROBOMP_CONFIG__") {
        return { replayEnabled: false, replayToken: "" };
    }
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== "object") {
            return { replayEnabled: false, replayToken: "" };
        }
        const record = parsed;
        return {
            replayEnabled: Boolean(record.replayEnabled),
            replayToken: typeof record.replayToken === "string" ? record.replayToken : "",
        };
    }
    catch {
        return { replayEnabled: false, replayToken: "" };
    }
}
export const CONFIG = readConfig();
export const AUTH_HEADERS = CONFIG.replayEnabled
    ? Object.freeze({ "X-Robomp-Replay-Token": CONFIG.replayToken })
    : Object.freeze({});
export const POLL_INTERVAL_MS = 3000;

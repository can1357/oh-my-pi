// Mirrors the JSON shapes emitted by `src/server.py`. Kept narrow on
// purpose: anything `unknown` here is something the backend explicitly does
// not promise to keep stable.
export const TERMINAL_ISSUE_STATES = new Set([
    "merged",
    "closed",
    "abandoned",
]);
export const LEVEL_ORDER = {
    DEBUG: 10,
    INFO: 20,
    WARNING: 30,
    ERROR: 40,
    RAW: 20,
};
export const EVENT_STATE_ORDER = [
    "queued",
    "running",
    "done",
    "failed",
    "skipped",
];

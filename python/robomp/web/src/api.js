import { AUTH_HEADERS } from "./config";
export class ApiError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "ApiError";
    }
}
function extractDetail(body) {
    if (body == null || typeof body !== "object")
        return null;
    const detail = body.detail;
    if (typeof detail === "string")
        return detail;
    const message = body.message;
    if (typeof message === "string")
        return message;
    return null;
}
async function unwrap(resp) {
    let body = null;
    try {
        body = await resp.json();
    }
    catch {
        // Endpoint returned non-JSON. For 2xx that's still valid for callers that
        // expect an empty body; we only surface the parse failure on errors.
    }
    if (!resp.ok) {
        const detail = extractDetail(body) ?? resp.statusText ?? `HTTP ${resp.status}`;
        throw new ApiError(resp.status, detail);
    }
    return body;
}
function authHeaders() {
    return { ...AUTH_HEADERS };
}
function jsonHeaders() {
    return { "Content-Type": "application/json", ...AUTH_HEADERS };
}
export const api = {
    status(signal) {
        return fetch("/api/status", { signal }).then(unwrap);
    },
    logs(limit = 400, signal) {
        return fetch(`/api/logs?limit=${limit}`, { signal }).then(unwrap);
    },
    browse(state, refresh = false, signal) {
        const qs = new URLSearchParams({ state, limit: "50" });
        if (refresh)
            qs.set("refresh", "1");
        return fetch(`/api/github/issues?${qs.toString()}`, {
            headers: authHeaders(),
            signal,
        }).then(unwrap);
    },
    trigger(body) {
        return fetch("/api/trigger", {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify(body),
        }).then(unwrap);
    },
    cancel(deliveryId) {
        return fetch("/api/cancel", {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({ delivery_id: deliveryId }),
        }).then(unwrap);
    },
};

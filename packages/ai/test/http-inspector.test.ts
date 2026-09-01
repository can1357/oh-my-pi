import { describe, expect, it } from "bun:test";
import {
	buildHttp400DumpPayload,
	type RawHttpRequestDump,
	rewriteClinePassError,
	shouldDumpRejectedRequest,
} from "@oh-my-pi/pi-ai/utils/http-inspector";

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const dump: RawHttpRequestDump = {
	provider: "anthropic",
	api: "anthropic-messages",
	model: "claude-opus-4-8",
	method: "POST",
	url: "https://api.anthropic.com/v1/messages",
	headers: { "x-api-key": "secret-key", "content-type": "application/json" },
	body: { messages: [{ role: "user", content: "hi" }] },
};

describe("buildHttp400DumpPayload", () => {
	it("keeps request fields top-level and records the provider error response", () => {
		const message = "400 image exceeds 5 MB limit";
		const payload = buildHttp400DumpPayload(dump, new HttpError(400, message), message);

		expect(payload.provider).toBe("anthropic");
		expect(payload.url).toBe("https://api.anthropic.com/v1/messages");
		expect(payload.body).toEqual({ messages: [{ role: "user", content: "hi" }] });
		expect(payload.errorResponse).toEqual({ status: 400, message });
	});

	it("records the same message-derived status that enables dumping", () => {
		const message = "400 Bad Request: image exceeds 5 MB limit";
		const error = new Error(message);

		expect(shouldDumpRejectedRequest(error)).toBe(true);
		expect(buildHttp400DumpPayload(dump, error, message).errorResponse).toEqual({ status: 400, message });
	});

	it("redacts sensitive request headers while keeping the rest", () => {
		const payload = buildHttp400DumpPayload(dump, new HttpError(400, "x"), "x");

		expect(payload.headers?.["x-api-key"]).toBe("[redacted]");
		expect(payload.headers?.["content-type"]).toBe("application/json");
	});
});

describe("shouldDumpRejectedRequest", () => {
	it("captures request-content rejections (400 bad request, 413 payload too large)", () => {
		expect(shouldDumpRejectedRequest(new HttpError(400, "bad request"))).toBe(true);
		expect(shouldDumpRejectedRequest(new HttpError(413, "payload too large"))).toBe(true);
	});

	it("skips auth, not-found, rate-limit, and retried 5xx errors that would spam dumps", () => {
		for (const status of [401, 403, 404, 429, 500, 502, 503, 504]) {
			expect(shouldDumpRejectedRequest(new HttpError(status, "x"))).toBe(false);
		}
	});

	it("skips errors without an HTTP status", () => {
		expect(shouldDumpRejectedRequest(new Error("network reset"))).toBe(false);
	});
});

describe("rewriteClinePassError", () => {
	it("rewrites not-subscribed into free-tier guidance", () => {
		const rewritten = rewriteClinePassError("the user is not subscribed to required model plan", "cline-pass");
		expect(rewritten).toContain("requires a ClinePass subscription");
		expect(rewritten).toContain("free");
	});

	it("rewrites the alternate not-subscribed phrasing", () => {
		const rewritten = rewriteClinePassError(
			"No access to ClinePass subscription models yet. Subscribe to ClinePass",
			"cline-pass",
		);
		expect(rewritten).toContain("requires a ClinePass subscription");
	});

	it("rewrites organization-account restriction", () => {
		const rewritten = rewriteClinePassError(
			"organization accounts cannot use individual model inference subscriptions",
			"cline-pass",
		);
		expect(rewritten).toContain("organization accounts");
		expect(rewritten).toContain("personal Cline API key");
	});

	it("rewrites roster-rotation model-not-found into reselection guidance", () => {
		const rewritten = rewriteClinePassError("model not found", "cline-pass");
		expect(rewritten).toContain("removed this model from the roster");
		expect(rewritten).toContain("/model");
	});

	it("rewrites the client-surface gate into actionable guidance", () => {
		const rewritten = rewriteClinePassError(
			"Error 403: deepseek/deepseek-v4-flash is only available via Cline product surfaces. If you are using an old version of Cline, please update to the latest version",
			"cline-pass",
		);
		expect(rewritten).toContain("official product surfaces");
		expect(rewritten).toContain("/model");
	});

	it("does not let the surface-gate rewrite swallow model-not-found", () => {
		// Marker independence: the surface-gate pattern must not match the
		// roster-rotation phrasing and vice versa.
		expect(rewriteClinePassError("model not found", "cline-pass")).toContain("removed this model");
	});

	it("leaves other providers untouched — the marker is too generic for them", () => {
		expect(rewriteClinePassError("model not found", "openrouter")).toBe("model not found");
	});

	it("leaves unrelated cline-pass errors untouched", () => {
		expect(rewriteClinePassError("500 internal server error", "cline-pass")).toBe("500 internal server error");
	});
});

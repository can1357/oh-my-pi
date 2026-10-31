import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildHttp400DumpPayload,
	type CapturedHttpErrorResponse,
	finalizeErrorMessage,
	pruneHttpRequestDumps,
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

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const MUSE_DENIAL_BODY =
	"This API key is billed to a Muse Code subscription. Muse Code subscriptions cover requests from the Muse Code client only. Use it in Muse Code, or use a pay-as-you-go API key for other clients.";
const MUSE_DENIAL_SUFFIX = " (type=permission_error param=client_attestation_denied)";
const MUSE_DENIAL_PAYLOAD = {
	error: {
		message: MUSE_DENIAL_BODY,
		type: "permission_error",
		param: "client_attestation_denied",
	},
};
const MUSE_DENIAL_RESPONSE: CapturedHttpErrorResponse = {
	status: 403,
	bodyText: JSON.stringify(MUSE_DENIAL_PAYLOAD),
	bodyJson: MUSE_DENIAL_PAYLOAD,
};

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

	it("redacts a query string carried by a configurable baseUrl (e.g. Bedrock gateway routing)", () => {
		const gatewayDump: RawHttpRequestDump = {
			...dump,
			url: "https://gateway.example.com/bedrock/model/anthropic.claude-opus-4-8/converse-stream?code=secret-token",
		};
		const payload = buildHttp400DumpPayload(gatewayDump, new HttpError(400, "x"), "x");

		expect(payload.url).not.toContain("secret-token");
		expect(payload.url).toBe(
			"https://gateway.example.com/bedrock/model/anthropic.claude-opus-4-8/converse-stream[redacted-query]",
		);
	});

	it("redacts provider-specific auth headers the fixed list never named", () => {
		const googleDump: RawHttpRequestDump = {
			provider: "google",
			api: "google-generative-ai",
			model: "gemini-2.5-flash",
			method: "POST",
			url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent",
			headers: {
				"x-goog-api-key": "AIzaSy-live-google-key",
				"x-amz-security-token": "aws-session-token",
				"content-type": "application/json",
			},
			body: { generationConfig: {} },
		};
		const payload = buildHttp400DumpPayload(googleDump, new HttpError(400, "x"), "x");

		expect(payload.headers?.["x-goog-api-key"]).toBe("[redacted]");
		expect(payload.headers?.["x-amz-security-token"]).toBe("[redacted]");
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

	it("leaves other providers untouched — the marker is too generic for them", () => {
		expect(rewriteClinePassError("model not found", "openrouter")).toBe("model not found");
	});

	it("leaves unrelated cline-pass errors untouched", () => {
		expect(rewriteClinePassError("500 internal server error", "cline-pass")).toBe("500 internal server error");
	});
});

describe("finalizeErrorMessage", () => {
	it("prints a provider body the thrown message already carries once while keeping the type/param suffix", async () => {
		const message = await finalizeErrorMessage(new Error(`403 ${MUSE_DENIAL_BODY}`), undefined, MUSE_DENIAL_RESPONSE);

		expect(occurrences(message, MUSE_DENIAL_BODY)).toBe(1);
		expect(message.endsWith(MUSE_DENIAL_SUFFIX)).toBe(true);
	});
	it("keeps the type/param suffix the thrown message already carries instead of repeating it", async () => {
		const message = await finalizeErrorMessage(
			new Error(`403 ${MUSE_DENIAL_BODY}${MUSE_DENIAL_SUFFIX}`),
			undefined,
			MUSE_DENIAL_RESPONSE,
		);

		expect(message).toBe(`403 ${MUSE_DENIAL_BODY}${MUSE_DENIAL_SUFFIX}`);
	});

	it("restores the full captured body over a truncated copy instead of appending a second copy", async () => {
		const truncated = MUSE_DENIAL_BODY.slice(0, 60);
		const message = await finalizeErrorMessage(new Error(`403 ${truncated}`), undefined, MUSE_DENIAL_RESPONSE);

		expect(message).toBe(`403 ${MUSE_DENIAL_BODY}${MUSE_DENIAL_SUFFIX}`);
		expect(occurrences(message, MUSE_DENIAL_BODY)).toBe(1);
	});

	it("prints literal dollar patterns in a provider body verbatim when restoring a truncated copy", async () => {
		const core = "Upstream rejected $& and $' and $` literally, plus enough trailing words to be truncated.";
		const payload = { error: { message: core, type: "invalid_request_error" } };
		const captured: CapturedHttpErrorResponse = { status: 400, bodyText: JSON.stringify(payload), bodyJson: payload };
		const message = await finalizeErrorMessage(new Error(`400 ${core.slice(0, 30)}`), undefined, captured);

		expect(message).toBe(`400 ${core} (type=invalid_request_error)`);
	});

	it("prints a truncated body once when a retry header is present, with the hint last", async () => {
		const core = "slow down ".repeat(500);
		const payload = { error: { message: core, type: "rate_limit" } };
		const captured: CapturedHttpErrorResponse = {
			status: 429,
			bodyText: JSON.stringify(payload),
			bodyJson: payload,
			headers: new Headers({ "retry-after-ms": "1000" }),
		};
		const message = await finalizeErrorMessage(new Error(`429 ${core.slice(0, 4096)}`), undefined, captured);

		expect(message).toBe(`429 ${core} (type=rate_limit) retry-after-ms=1000`);
	});

	it("keeps the retry hint when a bodyless status line is replaced by the captured payload", async () => {
		const headers = new Headers({ "retry-after-ms": "250" });
		const captured: CapturedHttpErrorResponse = { ...MUSE_DENIAL_RESPONSE, headers };
		const message = await finalizeErrorMessage(new Error("403 status code (no body)"), undefined, captured);

		expect(message).toBe(`403 status code: ${MUSE_DENIAL_BODY}${MUSE_DENIAL_SUFFIX} retry-after-ms=250`);
	});

	it("restores a truncated body that starts like the status code without touching the status code", async () => {
		const core = "403 forbidden by upstream policy";
		const payload = { error: { message: core, type: "permission_error" } };
		const captured: CapturedHttpErrorResponse = { status: 403, bodyText: JSON.stringify(payload), bodyJson: payload };
		const message = await finalizeErrorMessage(new Error("403 403"), undefined, captured);

		expect(message).toBe(`403 ${core} (type=permission_error)`);
	});

	it("still replaces a bodyless status line with the captured payload", async () => {
		const message = await finalizeErrorMessage(
			new Error("403 status code (no body)"),
			undefined,
			MUSE_DENIAL_RESPONSE,
		);

		expect(message).toBe(`403 status code: ${MUSE_DENIAL_BODY}${MUSE_DENIAL_SUFFIX}`);
	});

	it("joins a provider body the thrown message does not carry", async () => {
		const payload = { message: "upstream exploded" };
		const captured: CapturedHttpErrorResponse = { status: 500, bodyText: JSON.stringify(payload), bodyJson: payload };
		const message = await finalizeErrorMessage(new Error("500 boom"), undefined, captured);

		expect(message).toBe("500 boom\nupstream exploded");
	});
});

describe("pruneHttpRequestDumps", () => {
	const roots: string[] = [];
	afterEach(async () => {
		await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	});

	const DAY_MS = 24 * 60 * 60 * 1000;
	const now = Date.UTC(2026, 9, 1);

	async function writeDump(dir: string, name: string, bytes: number, ageMs: number): Promise<void> {
		const filePath = path.join(dir, name);
		await Bun.write(filePath, "x".repeat(bytes));
		const mtime = new Date(now - ageMs);
		await fs.utimes(filePath, mtime, mtime);
	}

	it("deletes dumps past the age limit and the oldest dumps beyond the size cap", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-http-dumps-"));
		roots.push(dir);
		await writeDump(dir, "newest.json", 400, 1_000);
		await writeDump(dir, "recent.json", 400, DAY_MS);
		await writeDump(dir, "older.json", 400, 2 * DAY_MS);
		await writeDump(dir, "expired.json", 10, 30 * DAY_MS);
		await writeDump(dir, "notes.txt", 5_000, 30 * DAY_MS);

		await pruneHttpRequestDumps(dir, { now, maxAgeMs: 7 * DAY_MS, maxTotalBytes: 1_000 });

		expect((await fs.readdir(dir)).sort()).toEqual(["newest.json", "notes.txt", "recent.json"]);
	});

	it("never deletes the dump it was asked to keep, even past the caps", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-http-dumps-keep-"));
		roots.push(dir);
		await writeDump(dir, "just-written.json", 2_000, 0);
		await writeDump(dir, "previous.json", 10, DAY_MS);

		await pruneHttpRequestDumps(dir, { now, maxAgeMs: 7 * DAY_MS, maxTotalBytes: 1_000, keep: "just-written.json" });

		expect(await fs.readdir(dir)).toEqual(["just-written.json"]);
	});
});

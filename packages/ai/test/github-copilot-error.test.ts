import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isGitHubCopilotPolicyDenial } from "@oh-my-pi/pi-ai/error";
import { formatMessage } from "@oh-my-pi/pi-ai/error/format";
import { rewriteCopilotError } from "@oh-my-pi/pi-ai/utils/http-inspector";
import { getFailureRetryAfterMs } from "@oh-my-pi/pi-ai/utils/retry-after";

function errorWithStatus(
	status: number,
	options: { message?: string; code?: string } = {},
): Error & { status: number; code?: string } {
	return Object.assign(new Error(options.message ?? `${status} Unauthorized`), {
		status,
		...(options.code === undefined ? {} : { code: options.code }),
	});
}

describe("rewriteCopilotError", () => {
	it("returns original message for non-copilot providers", () => {
		const err = errorWithStatus(401);
		expect(rewriteCopilotError("some error", err, "openai")).toBe("some error");
	});

	it("returns original message for non-401/403 errors", () => {
		const err = errorWithStatus(500);
		expect(rewriteCopilotError("server error", err, "github-copilot")).toBe("server error");
	});

	it("keeps GitHub's 400 model rejection bodies verbatim", () => {
		for (const [code, message] of [
			["model_not_supported", "400 The requested model is not supported."],
			[
				"model_not_available_for_integrator",
				'400 The requested model is not available for integrator "opencode". Available models: [gpt-4.1 claude-opus-4.7 gpt-5.5]',
			],
		] as const) {
			const err = errorWithStatus(400, { message, code });
			expect(rewriteCopilotError(message, err, "github-copilot")).toBe(message);
		}
	});

	it("rewrites message for 401 with github-copilot provider", () => {
		const err = errorWithStatus(401);
		const result = rewriteCopilotError("401 Unauthorized: ...", err, "github-copilot");
		expect(result).toContain("GitHub Copilot authentication failed (HTTP 401)");
		expect(result).toContain("/login github-copilot");
	});

	it("rewrites 403 with access-denied message (not auth-failed, to avoid credential removal)", () => {
		const err = errorWithStatus(403);
		const result = rewriteCopilotError("403 Forbidden", err, "github-copilot");
		expect(result).toContain("GitHub Copilot access denied (HTTP 403)");
		expect(result).not.toContain("GitHub Copilot authentication failed");
		expect(result).not.toContain("/login github-copilot");
	});
});

// The server's wait is structured: a rewrite replaces the message, and the wait
// is never in either; it reaches the caller as `errorRetryAfterMs`, read from
// the response's headers (`getFailureRetryAfterMs`), whatever the text says.
describe("formatMessage never writes the server's wait into the message", () => {
	const withWait = (status: number, message: string): Error =>
		Object.assign(new Error(message), { status, headers: new Headers({ "retry-after": "30" }) });

	it.each([
		["github-copilot", 401, "401 Unauthorized", "GitHub Copilot authentication failed (HTTP 401)"],
		["github-copilot", 403, "403 Forbidden", "GitHub Copilot access denied (HTTP 403)"],
		["cline-pass", 400, "the user is not subscribed to required model plan", "requires a ClinePass subscription"],
		[
			"cline-pass",
			400,
			"organization accounts cannot use individual model inference subscriptions",
			"unavailable for organization accounts",
		],
		["cline-pass", 400, "model not found", "removed this model from the roster"],
		["openai", 429, "429 Too many requests", "429 Too many requests"],
	])("%s %i", async (provider, status, message, rewritten) => {
		const error = withWait(status, message);
		const formatted = await formatMessage(error, { provider });

		expect(formatted).toContain(rewritten);
		expect(formatted).not.toContain("retry-after");
		expect(getFailureRetryAfterMs(error)).toBe(30_000);
	});

	it("still classifies the rewritten Copilot 403 as a policy denial", async () => {
		const formatted = await formatMessage(withWait(403, "403 Forbidden"), { provider: "github-copilot" });
		expect(isGitHubCopilotPolicyDenial("github-copilot", undefined, formatted)).toBe(true);
	});

	it("reads the wait from a Retry-After date with the shared reader", () => {
		const at = Date.now();
		const fiftyYearWindow = new Date(at);
		fiftyYearWindow.setUTCFullYear(fiftyYearWindow.getUTCFullYear() + 34);
		const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
			fiftyYearWindow.getUTCDay()
		];
		const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
			fiftyYearWindow.getUTCMonth()
		];
		const pad = (value: number): string => String(value).padStart(2, "0");
		// RFC 850 with a two-digit year 34 years ahead: Date.parse reads it as the last century.
		const rfc850 = `${day}, ${pad(fiftyYearWindow.getUTCDate())}-${month}-${pad(fiftyYearWindow.getUTCFullYear() % 100)} ${pad(fiftyYearWindow.getUTCHours())}:${pad(fiftyYearWindow.getUTCMinutes())}:${pad(fiftyYearWindow.getUTCSeconds())} GMT`;
		const error = Object.assign(new Error("503 overloaded"), {
			status: 503,
			headers: new Headers({ "retry-after": rfc850 }),
		});

		expect(getFailureRetryAfterMs(error)).toBeGreaterThan(33 * 365 * 86_400_000);
	});

	// A wait whose milliseconds spell a status (403, 503, …) never reaches the
	// classifier as text, so it cannot be read as one.
	const cases: Array<[string, string, number | undefined]> = [
		["github-copilot", "403 Forbidden", 403],
		["cline-pass", "model not found", 400],
		["cline-pass", "the user is not subscribed to required model plan", 400],
		["openai", "request failed", undefined],
	];
	for (const [provider, message, status] of cases) {
		it.each([401, 403, 429, 500, 502, 503, 504])(
			`classifies ${provider} "${message}" the same with a wait of %i ms`,
			async waitMs => {
				const failure = (headers?: Headers): Error => Object.assign(new Error(message), { status, headers });
				const withWaitHeader = await formatMessage(failure(new Headers({ "retry-after-ms": String(waitMs) })), {
					provider,
				});
				const plain = await formatMessage(failure(), { provider });
				expect(withWaitHeader).toBe(plain);

				expect(AIError.classifyMessage({ provider, errorMessage: withWaitHeader, errorStatus: status })).toBe(
					AIError.classifyMessage({ provider, errorMessage: plain, errorStatus: status }),
				);
			},
		);
	}
});

describe("isGitHubCopilotPolicyDenial", () => {
	it("exempts Copilot 403s by status so credentials survive plan/model denials", () => {
		expect(isGitHubCopilotPolicyDenial("github-copilot", 403, "403 Forbidden")).toBe(true);
	});

	it("matches the 403 rewrite text when no status is attached", () => {
		const rewritten = rewriteCopilotError("403 Forbidden", errorWithStatus(403), "github-copilot");
		expect(isGitHubCopilotPolicyDenial("github-copilot", undefined, rewritten)).toBe(true);
	});

	it("does not exempt Copilot 401s (revoked credentials must still be wiped)", () => {
		const rewritten = rewriteCopilotError("401 Unauthorized", errorWithStatus(401), "github-copilot");
		expect(isGitHubCopilotPolicyDenial("github-copilot", 401, rewritten)).toBe(false);
	});

	it("does not exempt other providers or non-403 Copilot failures", () => {
		expect(isGitHubCopilotPolicyDenial("openai", 403, "403 Forbidden")).toBe(false);
		expect(isGitHubCopilotPolicyDenial("github-copilot", 500, "server error")).toBe(false);
		expect(isGitHubCopilotPolicyDenial("github-copilot", undefined, undefined)).toBe(false);
	});
});

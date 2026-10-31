import { describe, expect, it } from "bun:test";
import { isGitHubCopilotPolicyDenial } from "@oh-my-pi/pi-ai/error";
import { formatMessage } from "@oh-my-pi/pi-ai/error/format";
import { rewriteCopilotError } from "@oh-my-pi/pi-ai/utils/http-inspector";
import { keepRetryAfterHint } from "@oh-my-pi/pi-ai/utils/retry-after";

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

// A rewrite replaces the formatted message; the server's wait must survive it,
// because the caller reads the wait from the message.
describe("formatMessage keeps the server's wait through a provider rewrite", () => {
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
	])("%s %i", async (provider, status, message, rewritten) => {
		const formatted = await formatMessage(withWait(status, message), { provider });

		expect(formatted).toContain(rewritten);
		expect(formatted).toContain("retry-after-ms=30000");
	});

	it("still classifies the rewritten Copilot 403 as a policy denial", async () => {
		const formatted = await formatMessage(withWait(403, "403 Forbidden"), { provider: "github-copilot" });
		expect(isGitHubCopilotPolicyDenial("github-copilot", undefined, formatted)).toBe(true);
	});

	it("keeps the longest hint the formatted message carried, and adds none when it carried none", () => {
		expect(keepRetryAfterHint("a retry-after-ms=1 b retry-after-ms=30000", "rewritten")).toBe(
			"rewritten retry-after-ms=30000",
		);
		expect(keepRetryAfterHint("no wait named", "rewritten")).toBe("rewritten");
		expect(keepRetryAfterHint("retry-after-ms=5", "rewritten retry-after-ms=7")).toBe("rewritten retry-after-ms=7");
	});
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

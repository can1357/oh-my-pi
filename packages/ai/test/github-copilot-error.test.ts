import { describe, expect, it } from "bun:test";
import { rewriteCopilotError } from "@oh-my-pi/pi-ai/utils/http-inspector";

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

	it("rewrites 400 model_not_supported with fleet-skew guidance", () => {
		const err = errorWithStatus(400, {
			message: "400 The requested model is not supported.",
			code: "model_not_supported",
		});
		const result = rewriteCopilotError("original", err, "github-copilot");
		expect(result).toContain("HTTP 400");
		expect(result).toContain("only part of its fleet");
		expect(result).not.toContain("authentication failed");
	});

	it("preserves per-integrator entitlement details and available models", () => {
		const message =
			'400 The requested model is not available for integrator "opencode". Available models: [gpt-4.1 claude-opus-4.7 gpt-5.5]';
		const err = errorWithStatus(400, { message, code: "model_not_available_for_integrator" });
		expect(rewriteCopilotError(message, err, "github-copilot")).toBe(message);
	});

	it("leaves non-copilot 400 model_not_supported untouched", () => {
		const err = errorWithStatus(400, {
			message: "400 model_not_supported",
			code: "model_not_supported",
		});
		expect(rewriteCopilotError("orig", err, "openai")).toBe("orig");
	});

	it("leaves 400 without model_not_supported code untouched", () => {
		const err = errorWithStatus(400, {
			message: "400 invalid request",
			code: "invalid_request_body",
		});
		expect(rewriteCopilotError("orig", err, "github-copilot")).toBe("orig");
	});
});

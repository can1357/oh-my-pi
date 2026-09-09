import { afterEach, describe, expect, it, vi } from "bun:test";
import { googleGeminiCliProjectHook } from "@oh-my-pi/pi-ai/oauth/google-gemini-cli";
import { extractGoogleValidationUrl } from "@oh-my-pi/pi-ai/utils/google-validation";

const VALIDATION_URL = "https://accounts.google.com/signin/continue?sarp=1&scc=1&plt=AKgnsbtTOKEN";

const validationBody = JSON.stringify({
	error: {
		code: 403,
		status: "PERMISSION_DENIED",
		details: [
			{
				"@type": "type.googleapis.com/google.rpc.ErrorInfo",
				reason: "VALIDATION_REQUIRED",
				metadata: { validation_url: VALIDATION_URL, validation_url_link_text: "Verify your account" },
			},
		],
	},
});

describe("extractGoogleValidationUrl", () => {
	it("extracts the validation url from a raw 403 VALIDATION_REQUIRED body", () => {
		expect(extractGoogleValidationUrl(validationBody)).toBe(VALIDATION_URL);
	});

	it("extracts the url when the body is wrapped in the discovery error prefix", () => {
		// exchangeToken receives discoverProject's thrown message, which embeds the raw body.
		const wrapped = `Could not discover or provision an Antigravity project. loadCodeAssist failed: 403 Forbidden: ${validationBody}`;
		expect(extractGoogleValidationUrl(wrapped)).toBe(VALIDATION_URL);
	});

	it("returns undefined for a 403 that is not VALIDATION_REQUIRED", () => {
		const body = JSON.stringify({
			error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] },
		});
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});

	it("returns undefined when VALIDATION_REQUIRED carries no validation_url", () => {
		const body = JSON.stringify({
			error: { code: 403, details: [{ reason: "VALIDATION_REQUIRED", metadata: {} }] },
		});
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});

	it("returns undefined for non-JSON error text", () => {
		expect(extractGoogleValidationUrl("loadCodeAssist failed: 500 Internal Server Error")).toBeUndefined();
	});

	it("returns undefined for empty input", () => {
		expect(extractGoogleValidationUrl("")).toBeUndefined();
	});
});

async function runProjectHook(email?: string) {
	return googleGeminiCliProjectHook(
		{
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 3600_000,
			...(email ? { email } : {}),
		},
		{
			provider: "google-gemini-cli",
			phase: "login",
			raw: { refresh_token: "refresh-token" },
			fetch,
		},
	);
}

describe("Google OAuth account verification", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rewrites a VALIDATION_REQUIRED discovery failure into an actionable message naming the account", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(validationBody, { status: 403, statusText: "Forbidden" }),
		);

		await expect(runProjectHook("user@example.com")).rejects.toThrow(
			`Account verification required for user@example.com. Visit ${VALIDATION_URL} to continue, then sign in again.`,
		);
	});

	it("omits the account clause when no email was resolved", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(validationBody, { status: 403, statusText: "Forbidden" }),
		);

		await expect(runProjectHook()).rejects.toThrow(
			`Account verification required. Visit ${VALIDATION_URL} to continue, then sign in again.`,
		);
	});

	it("propagates a non-validation discovery error untouched", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("service unavailable", { status: 503, statusText: "Service Unavailable" }),
		);

		await expect(runProjectHook("user@example.com")).rejects.toThrow(
			"loadCodeAssist failed: 503 Service Unavailable: service unavailable",
		);
	});
});

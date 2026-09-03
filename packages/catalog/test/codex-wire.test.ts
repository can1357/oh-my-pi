import { describe, expect, it } from "bun:test";
import {
	applyCodexResidencyHeader,
	getCodexAccountId,
	getCodexResidency,
	JWT_CLAIM_PATH,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";

function codexToken(auth: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }), "utf8").toString("base64url");
	const payload = Buffer.from(JSON.stringify({ [JWT_CLAIM_PATH]: auth }), "utf8").toString("base64url");
	return `${header}.${payload}.signature`;
}

describe("getCodexResidency", () => {
	it("reads the data-residency claim of a region-pinned workspace", () => {
		const token = codexToken({
			chatgpt_account_id: "acct-1",
			chatgpt_data_residency: "us",
			chatgpt_compute_residency: "us",
		});

		expect(getCodexResidency(token)).toBe("us");
		// Same token still yields the account id — the claim block is shared.
		expect(getCodexAccountId(token)).toBe("acct-1");
	});

	it("prefers data residency over compute residency when they disagree", () => {
		expect(getCodexResidency(codexToken({ chatgpt_data_residency: "eu", chatgpt_compute_residency: "us" }))).toBe(
			"eu",
		);
	});

	it("falls back to compute residency when only that claim is present", () => {
		expect(getCodexResidency(codexToken({ chatgpt_compute_residency: "eu" }))).toBe("eu");
	});

	it("returns undefined for tokens without residency claims", () => {
		// The common case: a personal ChatGPT account, not pinned to any region.
		expect(getCodexResidency(codexToken({ chatgpt_account_id: "acct-1" }))).toBeUndefined();
	});

	it("ignores blank and non-string claims instead of sending an empty header", () => {
		expect(getCodexResidency(codexToken({ chatgpt_data_residency: "   " }))).toBeUndefined();
		expect(getCodexResidency(codexToken({ chatgpt_data_residency: 42 }))).toBeUndefined();
		expect(getCodexResidency(codexToken({ chatgpt_data_residency: "", chatgpt_compute_residency: "us" }))).toBe("us");
	});

	it("returns undefined for opaque non-JWT keys used by Codex-compatible proxies", () => {
		expect(getCodexResidency("opaque-proxy-key")).toBeUndefined();
		expect(getCodexResidency("not.a.jwt")).toBeUndefined();
	});

	it("applies residency without replacing caller-supplied Headers or record values", () => {
		const token = codexToken({ chatgpt_data_residency: "us" });
		const headers = new Headers();
		applyCodexResidencyHeader(headers, token);
		expect(headers.get(OPENAI_HEADERS.RESIDENCY)).toBe("us");

		const configured = { "X-OpenAI-Internal-Codex-Residency": "eu" };
		applyCodexResidencyHeader(configured, token);
		expect(configured).toEqual({ "X-OpenAI-Internal-Codex-Residency": "eu" });
	});
});

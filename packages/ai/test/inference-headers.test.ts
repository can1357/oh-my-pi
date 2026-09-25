import { describe, expect, test } from "bun:test";
import { applyInferenceHeaders } from "@oh-my-pi/pi-ai/providers/inference-headers";

describe("applyInferenceHeaders", () => {
	test("keeps user-provided session headers instead of overwriting them", () => {
		const headers = { session_id: "user-value", "x-client-request-id": "user-req" };
		applyInferenceHeaders(headers, { provider: "openai", protocol: "openai", sessionId: "omp-session" });
		expect(headers).toEqual({ session_id: "user-value", "x-client-request-id": "user-req" });
	});

	test("fills session headers when the user sets none", () => {
		const headers: Record<string, string> = {};
		applyInferenceHeaders(headers, { provider: "openai", protocol: "openai", sessionId: "omp-session" });
		expect(headers).toEqual({ session_id: "omp-session", "x-client-request-id": "omp-session" });
	});

	test("matches existing header names case-insensitively", () => {
		const headers = { "SESSION_ID": "user-value" };
		applyInferenceHeaders(headers, { provider: "openai", protocol: "openai", sessionId: "omp-session" });
		expect(headers["SESSION_ID"]).toBe("user-value");
		expect(headers["x-client-request-id"]).toBe("omp-session");
	});
});

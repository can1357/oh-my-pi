import { describe, expect, it } from "bun:test";
import {
	formatConnectEndStreamError,
	summarizeConnectErrorDetails,
} from "@oh-my-pi/pi-ai/providers/connect-error-detail";

describe("formatConnectEndStreamError", () => {
	it("keeps the legacy prefix for a plain code/message error", () => {
		expect(formatConnectEndStreamError({ code: "unavailable", message: "post-turn connect failure" })).toBe(
			"Connect error unavailable: post-turn connect failure",
		);
	});

	it("falls back to unknown/Unknown error for malformed payloads", () => {
		expect(formatConnectEndStreamError({})).toBe("Connect error unknown: Unknown error");
		expect(formatConnectEndStreamError(null)).toBe("Connect error unknown: Unknown error");
		expect(formatConnectEndStreamError({ code: 5, message: 7 })).toBe("Connect error unknown: Unknown error");
	});

	it("appends detail entries so the server's rejection is visible", () => {
		const formatted = formatConnectEndStreamError({
			code: "invalid_argument",
			message: "Error",
			details: [{ type: "google.rpc.BadRequest", debug: { fieldViolations: [{ field: "tools" }] } }],
		});
		expect(formatted).toContain("Connect error invalid_argument: Error");
		expect(formatted).toContain("google.rpc.BadRequest");
		expect(formatted).toContain("fieldViolations");
	});

	it("inlines leftover trailer fields when the message is generic and detail-free", () => {
		const formatted = formatConnectEndStreamError({
			code: "invalid_argument",
			message: "Error",
			requestId: "req-123",
		});
		expect(formatted).toContain("Connect error invalid_argument: Error");
		expect(formatted).toContain("req-123");
	});

	it("does not inline trailer fields when the message is already specific", () => {
		const formatted = formatConnectEndStreamError({
			code: "invalid_argument",
			message: "tools[3].parameters is not an object",
			requestId: "req-123",
		});
		expect(formatted).toBe("Connect error invalid_argument: tools[3].parameters is not an object");
	});

	it("caps oversized detail payloads at the documented bound", () => {
		const detail = summarizeConnectErrorDetails([{ type: "t", debug: "x".repeat(2000) }]);
		expect(detail?.length).toBe(400);
		expect(detail).toEndWith("…");
	});
});

describe("summarizeConnectErrorDetails", () => {
	it("returns undefined for absent or empty details", () => {
		expect(summarizeConnectErrorDetails(undefined)).toBeUndefined();
		expect(summarizeConnectErrorDetails([])).toBeUndefined();
		expect(summarizeConnectErrorDetails([42, "junk"])).toBeUndefined();
	});

	it("joins typed entries", () => {
		expect(summarizeConnectErrorDetails([{ type: "a.b.C", debug: "why" }, { type: "d.e.F" }])).toBe(
			"a.b.C: why; d.e.F",
		);
	});
});

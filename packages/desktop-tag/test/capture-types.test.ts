import { describe, expect, it } from "bun:test";

import { buildCaptureUserTurn, buildFollowUpTurn } from "../src/capture/prompt";
import { sanitizeForCollaboration } from "../src/capture/redact";
import { parseCaptureTaskRequest, shortSessionLabel } from "../src/capture/types";
import { baseRequest, PNG_BASE64 } from "./helpers/capture-fakes";

const LIMITS = { maxScreenshotBytes: 1024 };

describe("parseCaptureTaskRequest", () => {
	it("accepts a minimal valid request", () => {
		const parsed = parseCaptureTaskRequest(baseRequest(), LIMITS);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.source.type).toBe("screen-region");
		expect(parsed.value.routing).toEqual({});
	});

	it("rejects missing or oversized fields", () => {
		expect(parseCaptureTaskRequest({}, LIMITS).ok).toBe(false);
		expect(parseCaptureTaskRequest(baseRequest({ instruction: "" }), LIMITS).ok).toBe(false);
		expect(parseCaptureTaskRequest(baseRequest({ instruction: "x".repeat(20_001) }), LIMITS).ok).toBe(false);
		expect(
			parseCaptureTaskRequest(baseRequest({ source: { type: "nope", capturedAt: "2026-01-01T00:00:00Z" } }), LIMITS)
				.ok,
		).toBe(false);
	});

	it("requires exactly one of screenshot data or storageRef", () => {
		const both = parseCaptureTaskRequest(
			baseRequest({ screenshot: { mimeType: "image/png", data: PNG_BASE64, storageRef: crypto.randomUUID() } }),
			LIMITS,
		);
		expect(both.ok).toBe(false);
		const neither = parseCaptureTaskRequest(baseRequest({ screenshot: { mimeType: "image/png" } }), LIMITS);
		expect(neither.ok).toBe(false);
	});

	it("rejects path-traversal storage refs and non-base64 data", () => {
		expect(
			parseCaptureTaskRequest(
				baseRequest({ screenshot: { mimeType: "image/png", storageRef: "../../etc/passwd" } }),
				LIMITS,
			).ok,
		).toBe(false);
		expect(
			parseCaptureTaskRequest(baseRequest({ screenshot: { mimeType: "image/png", data: "not base64!!" } }), LIMITS)
				.ok,
		).toBe(false);
	});

	it("enforces the screenshot upload limit against the encoded payload", () => {
		const oversized = "A".repeat(Math.ceil((LIMITS.maxScreenshotBytes * 4) / 3) + 8);
		const parsed = parseCaptureTaskRequest(
			baseRequest({ screenshot: { mimeType: "image/png", data: oversized } }),
			LIMITS,
		);
		expect(parsed.ok).toBe(false);
	});

	it("validates server-side capture descriptors", () => {
		expect(parseCaptureTaskRequest(baseRequest({ capture: { mode: "region" } }), LIMITS).ok).toBe(false);
		const valid = parseCaptureTaskRequest(
			baseRequest({ capture: { mode: "region", region: { x: 0, y: 0, width: 100, height: 100 } } }),
			LIMITS,
		);
		expect(valid.ok).toBe(true);
	});
});

describe("prompt construction", () => {
	it("clearly separates task, source, selected text, annotations, and environment", () => {
		const parsed = parseCaptureTaskRequest(
			baseRequest({
				instruction: "Investigate this error and fix the responsible code.",
				selectedText: "TypeError: cannot read properties of undefined",
				source: {
					type: "screen-region",
					capturedAt: "2026-07-11T00:00:00.000Z",
					application: "Visual Studio Code",
					windowTitle: "oh-my-pk",
				},
				annotations: [{ id: "a1", type: "rectangle", bounds: [10, 20, 100, 50], label: "failing status panel" }],
			}),
			LIMITS,
		);
		if (!parsed.ok) throw new Error(parsed.error);
		const turn = buildCaptureUserTurn({
			request: parsed.value,
			hasScreenshot: true,
			runnerId: "msi-windows-main",
			workspacePath: "/repo",
			collaborationSource: "desktop-capture",
			participant: "pk",
		});
		expect(turn).toContain("TASK");
		expect(turn).toContain("Investigate this error and fix the responsible code.");
		expect(turn).toContain("Application: Visual Studio Code");
		expect(turn).toContain("SELECTED TEXT");
		expect(turn).toContain("SCREENSHOT");
		expect(turn).toContain("failing status panel");
		expect(turn).toContain("Runner: msi-windows-main");
	});

	it("renders follow-up turns with source attribution", () => {
		const turn = buildFollowUpTurn({
			text: "Do the same for mobile.",
			source: "telegram",
			participant: "@bob",
			hasImages: true,
		});
		expect(turn).toContain("@bob");
		expect(turn).toContain("Telegram");
		expect(turn).toContain("Do the same for mobile.");
	});
});

describe("sanitizeForCollaboration", () => {
	it("redacts credential-shaped content and preserves normal text", () => {
		const input = [
			"All done! password=hunter2secret and token: ghp_abcdefghijklmnopqrstuvwx1234567890",
			"Also api_key=\"quoted-secret-value\" and secret='single-quoted-secret'",
			"AWS: AKIAIOSFODNN7EXAMPLE, api sk-abcdefgh12345678ijkl",
			"Bot 123456789:AAAaaaBBBbbbCCCcccDDDdddEEEeee123456",
			"The fix touched three files.",
		].join("\n");
		const output = sanitizeForCollaboration(input);
		expect(output).not.toContain("hunter2secret");
		expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwx1234567890");
		expect(output).not.toContain("quoted-secret-value");
		expect(output).not.toContain("single-quoted-secret");
		expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(output).not.toContain("sk-abcdefgh12345678ijkl");
		expect(output).not.toContain("AAAaaaBBBbbbCCCcccDDDdddEEEeee123456");
		expect(output).toContain("The fix touched three files.");
	});

	it("caps output length", () => {
		expect(sanitizeForCollaboration("x".repeat(10_000), 100).length).toBeLessThan(130);
	});
});

describe("shortSessionLabel", () => {
	it("prefers the session id and strips dashes", () => {
		expect(shortSessionLabel({ id: "run", sessionId: "8f31a2ff-1234" })).toBe("capture-8f31a2");
		expect(shortSessionLabel({ id: "0199aabb-cc" })).toBe("capture-0199aa");
	});
});

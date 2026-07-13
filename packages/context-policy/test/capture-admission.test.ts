import { describe, expect, it } from "bun:test";
import { authorizeCapture, type ConsentRecord, calculateRetention, DEFAULT_CONTEXT_POLICY } from "../src";

const consent: ConsentRecord = {
	userId: "user-1",
	deviceId: "device-1",
	identityVerified: true,
	enabled: true,
	scope: "session",
	sessionId: "session-1",
	remoteStorageEnabled: false,
	policyVersion: "context-retention/v1",
};

describe("persistent context capture admission", () => {
	it("keeps transient capture available while persistence remains disabled", () => {
		expect(
			authorizeCapture(
				{ userId: "user-1", deviceId: "device-1", sessionId: "session-1", persistent: false },
				undefined,
			),
		).toEqual({
			allowed: true,
			persistent: false,
		});
		expect(
			authorizeCapture(
				{ userId: "user-1", deviceId: "device-1", sessionId: "session-1", persistent: true },
				undefined,
			),
		).toMatchObject({
			allowed: false,
			persistent: false,
		});
	});

	it("binds session consent to its verified identity and session", () => {
		expect(
			authorizeCapture(
				{ userId: "user-1", deviceId: "device-1", sessionId: "session-1", persistent: true },
				consent,
			),
		).toEqual({
			allowed: true,
			persistent: true,
		});
		expect(
			authorizeCapture(
				{ userId: "user-1", deviceId: "device-1", sessionId: "session-2", persistent: true },
				consent,
			),
		).toMatchObject({
			allowed: false,
			persistent: false,
		});
	});
});

describe("default retention policy", () => {
	it("is disabled by default and derives raw capture expiry and cold transition", () => {
		expect(DEFAULT_CONTEXT_POLICY.enabledByDefault).toBe(false);
		expect(calculateRetention("raw_capture", "2026-07-13T00:00:00.000Z")).toEqual({
			expiresAt: "2026-08-12T00:00:00.000Z",
			transitionToColdAt: "2026-07-20T00:00:00.000Z",
		});
	});
});

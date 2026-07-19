import { describe, expect, it } from "bun:test";

import { loadCaptureConfig } from "../src/capture/config";

describe("loadCaptureConfig security defaults", () => {
	it("defaults autoApprove to false so a chat cannot drive an unrestricted agent without opt-in", () => {
		expect(loadCaptureConfig({}).autoApprove).toBe(false);
	});

	it("honors an explicit CAPTURE_AUTO_APPROVE opt-in", () => {
		expect(loadCaptureConfig({ CAPTURE_AUTO_APPROVE: "1" }).autoApprove).toBe(true);
		expect(loadCaptureConfig({ CAPTURE_AUTO_APPROVE: "true" }).autoApprove).toBe(true);
	});

	it("defaults requireReply on so ambient chat cannot become agent input", () => {
		expect(loadCaptureConfig({}).telegram.requireReply).toBe(true);
	});

	it("honors TELEGRAM_REQUIRE_REPLY=0 for the legacy ambient-follow-up behavior", () => {
		expect(loadCaptureConfig({ TELEGRAM_REQUIRE_REPLY: "0" }).telegram.requireReply).toBe(false);
	});
});

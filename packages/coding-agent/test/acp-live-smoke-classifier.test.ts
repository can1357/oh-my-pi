import { describe, expect, it } from "bun:test";
import { classifyLiveSmoke } from "../../../scripts/acp-live-smoke-classifier";

describe("ACP live smoke classification", () => {
	it("accepts an exact observed route", () => {
		expect(classifyLiveSmoke(0, "bytes=192000 want=192000 exact=True")).toBe("OK");
	});

	it("marks only requested tool/rawInput deviations as harness-invalid", () => {
		expect(classifyLiveSmoke(0, "tool=bash expected=eval exact=False tool_mismatch=True")).toBe("HARNESS_INVALID");
		expect(classifyLiveSmoke(0, "tool=eval exact=False raw_input_mismatch=True")).toBe("HARNESS_INVALID");
	});

	it("keeps wire failures as regressions after the requested call was observed", () => {
		expect(classifyLiveSmoke(1, "bytes=1024 want=192000 exact=False prefix=MISMATCH")).toBe("REGRESSION");
		expect(classifyLiveSmoke(0, "exact=False source_echo_mismatch=True")).toBe("REGRESSION");
		expect(classifyLiveSmoke(0, "bytes=384000 want=192000 exact=False unexpected=['duplicate']")).toBe("REGRESSION");
	});
});

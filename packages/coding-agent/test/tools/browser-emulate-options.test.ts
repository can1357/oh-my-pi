import { describe, expect, it } from "bun:test";
import { validateEmulateOptions } from "@oh-my-pi/pi-coding-agent/tools/browser/emulation";

describe("validateEmulateOptions", () => {
	it("reads Puppeteer's viewport keys and the CSS reduced-motion values", () => {
		expect(
			validateEmulateOptions({
				viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
				reducedMotion: "no-preference",
				media: "print",
			}),
		).toEqual({
			viewport: { width: 390, height: 844, scale: 3, isMobile: true, hasTouch: true },
			reducedMotion: false,
			media: "print",
		});
	});

	it("refuses a key it does not take instead of dropping it", () => {
		expect(() => validateEmulateOptions({ prefersDark: true })).toThrow("prefersDark must be removed");
	});
});

import { afterEach, describe, expect, it } from "bun:test";
import { openCommandFor } from "@oh-my-pi/pi-coding-agent/utils/open";

const original = process.env.BROWSER;

afterEach(() => {
	if (original === undefined) delete process.env.BROWSER;
	else process.env.BROWSER = original;
});

describe("openCommandFor", () => {
	it("uses the platform opener when BROWSER is unset", () => {
		delete process.env.BROWSER;
		expect(openCommandFor("https://example.com/oauth")).toEqual(
			process.platform === "darwin" ? ["open", "https://example.com/oauth"] : expect.any(Array),
		);
	});

	// Reported 2026-08-31: "it opens default browser which never works because I
	// keep my default browser different from other stuff".
	it("launches nothing when the user opts out with BROWSER=none", () => {
		process.env.BROWSER = "none";
		expect(openCommandFor("https://example.com/oauth")).toBeUndefined();
		process.env.BROWSER = "  NONE  ";
		expect(openCommandFor("https://example.com/oauth")).toBeUndefined();
	});

	it("uses BROWSER as the opener, unsplit, so a path with spaces survives", () => {
		process.env.BROWSER = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		expect(openCommandFor("https://example.com/oauth")).toEqual([
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"https://example.com/oauth",
		]);
	});

	it("ignores BROWSER for file paths, which need the OS type handler", () => {
		process.env.BROWSER = "none";
		expect(openCommandFor("/tmp/session-export.html")).toBeDefined();
	});
});

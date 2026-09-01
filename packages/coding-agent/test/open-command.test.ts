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
	// The convention allows arguments and %s substitution. omp does not parse
	// them, so a value it cannot honor must leave the platform default alone
	// rather than spawn a binary named "firefox %s" and open nothing.
	it("ignores a BROWSER value that is not the opt-out", () => {
		process.env.BROWSER = "firefox %s";
		expect(openCommandFor("https://example.com/oauth")).toEqual(
			process.platform === "darwin" ? ["open", "https://example.com/oauth"] : expect.any(Array),
		);
	});

	it("ignores BROWSER for file paths, which need the OS type handler", () => {
		process.env.BROWSER = "none";
		expect(openCommandFor("/tmp/session-export.html")).toBeDefined();
	});
});

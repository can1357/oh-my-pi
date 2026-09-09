import { describe, expect, it } from "bun:test";
import { compareVersions } from "../src/version";

describe("compareVersions", () => {
	it("trims whitespace and strips one leading v/V", () => {
		expect(compareVersions(" 1.2.3 ", "1.2.3")).toBe(0);
		expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
		expect(compareVersions("V1.2.3", "v1.2.3")).toBe(0);
		expect(compareVersions(" v1.2.3 ", "1.2.3")).toBe(0);
	});

	it("zero-pads missing trailing segments", () => {
		expect(compareVersions("1.2", "1.2.0")).toBe(0);
		expect(compareVersions("1", "1.0.0.0")).toBe(0);
		expect(compareVersions("1.2", "1.2.1")).toBe(-1);
		expect(compareVersions("1.2.3", "1.2")).toBe(1);
	});

	it("supports arbitrary segment counts", () => {
		expect(compareVersions("1.2.3.4.5", "1.2.3.4.5")).toBe(0);
		expect(compareVersions("1.2.3.4", "1.2.3.5")).toBe(-1);
		expect(compareVersions("1.0.0.1", "1.0.0")).toBe(1);
	});

	it("orders SemVer prereleases before the plain release", () => {
		expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
		expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
		expect(compareVersions("v1.0.0-beta", "1.0.0")).toBe(-1);
		expect(compareVersions("1.1.0-alpha", "1.0.0-beta")).toBe(1);
	});

	it("compares prerelease identifiers per SemVer 2.0", () => {
		expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
		expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.2")).toBe(-1);
		// numeric, not lexical: rc.10 > rc.9
		expect(compareVersions("1.0.0-rc.9", "1.0.0-rc.10")).toBe(-1);
		// a larger set of equal fields has higher precedence
		expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
		// numeric identifiers sort before alphanumeric ones
		expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
		expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.1")).toBe(1);
	});

	it("strips SemVer build metadata before comparing", () => {
		// build metadata does not affect precedence
		expect(compareVersions("1.0.1+linux", "1.0.0")).toBe(1);
		expect(compareVersions("1.0.0-rc.1+abc", "1.0.0-rc.1+xyz")).toBe(0);
		expect(compareVersions("1.0.0+build1", "1.0.0+build2")).toBe(0);
		expect(compareVersions("1.0.0+linux", "1.0.0+mac")).toBe(0);
		expect(compareVersions("1.0.0+linux", "1.0.1+linux")).toBe(-1);
		expect(compareVersions("v1.2.3+meta", "1.2.3")).toBe(0);
		expect(compareVersions(" 1.0.0+meta ", "1.0.0")).toBe(0);
	});

	it("compares malformed numeric segments as 0", () => {
		expect(compareVersions("1.2.x", "1.2.0")).toBe(0);
		expect(compareVersions("1.x", "1.0")).toBe(0);
		expect(compareVersions("1.2.x", "1.2.1")).toBe(-1);
	});

	it("never throws and always returns -1, 0, or 1", () => {
		expect(compareVersions("not_a_version", "0")).toBe(0);
		expect(compareVersions("", "")).toBe(0);
		expect(compareVersions("v", "")).toBe(0);
		// hyphenated garbage parses as a prerelease suffix and loses to the release
		expect(compareVersions("not-a-version", "1.0.0")).toBe(-1);
		expect(compareVersions("3.0.0", "1.0.0")).toBe(1);
		expect(compareVersions("1.0.0", "3.0.0")).toBe(-1);
		// exact numeric comparison beyond float precision
		expect(compareVersions("1.2.99999999999999999999", "1.2.100000000000000000000")).toBe(-1);
	});
});

import { describe, expect, test } from "bun:test";
import { bunFloor, satisfiesBunFloor } from "./check-bun-floor";

describe("bunFloor", () => {
	test("reads a floor pin and an exact pin", () => {
		expect(bunFloor("bun@>=1.4.3")).toBe("1.4.3");
		expect(bunFloor("bun@1.4.3")).toBe("1.4.3");
	});

	test("reports no floor for an absent or non-bun pin", () => {
		expect(bunFloor(undefined)).toBeUndefined();
		expect(bunFloor("npm@10.0.0")).toBeUndefined();
		expect(bunFloor("bun@")).toBeUndefined();
	});
});

describe("satisfiesBunFloor", () => {
	// The gate's contract: `bun --check` is unknown before 1.4.3, so Bun prints
	// its help and exits 0 — every check:types would pass without checking a
	// file. A runtime below the declared floor must be rejected instead.
	test("rejects the runtimes whose --check silently passes", () => {
		expect(satisfiesBunFloor("1.3.14", "bun@>=1.4.3")).toBe(false);
		expect(satisfiesBunFloor("1.4.2", "bun@>=1.4.3")).toBe(false);
	});

	test("accepts the floor and newer", () => {
		expect(satisfiesBunFloor("1.4.3", "bun@>=1.4.3")).toBe(true);
		expect(satisfiesBunFloor("1.4.4", "bun@>=1.4.3")).toBe(true);
		expect(satisfiesBunFloor("1.5.0", "bun@>=1.4.3")).toBe(true);
	});

	// A prerelease of the boundary sorts below it, matching the startup guard
	// in packages/coding-agent/src/cli.ts — accepting it would install a
	// runtime that immediately exits.
	test("rejects a prerelease of the floor", () => {
		expect(satisfiesBunFloor("1.4.3-canary.1", "bun@>=1.4.3")).toBe(false);
	});

	test("accepts any runtime when the manifest pins no bun", () => {
		expect(satisfiesBunFloor("1.0.0", undefined)).toBe(true);
	});
});

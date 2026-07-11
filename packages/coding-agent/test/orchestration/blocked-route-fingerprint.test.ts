import { describe, expect, it } from "bun:test";
import {
	ApproachRegistry,
	computeBlockerFingerprint,
	shouldRejectDuplicateBlockedSpawn,
} from "../../src/orchestration/approach-registry";

describe("blocked-route fingerprint preservation", () => {
	it("stores a parent-carried fingerprint verbatim so duplicate-spawn checks match it", () => {
		const registry = new ApproachRegistry();
		// Fingerprint minted elsewhere (older session / different algorithm revision):
		// it intentionally differs from what computeBlockerFingerprint would produce.
		const carried = "carried-fingerprint-1";
		expect(carried).not.toBe(computeBlockerFingerprint("persistence", "API returns 403"));

		registry.markBlocked("persistence", "sqlite", "API returns 403", undefined, carried);

		expect(registry.get("persistence", "sqlite")?.blockerFingerprint).toBe(carried);
		expect(shouldRejectDuplicateBlockedSpawn(registry, "persistence", carried)).toBe(true);
	});

	it("recomputes the fingerprint when none is supplied", () => {
		const registry = new ApproachRegistry();
		registry.markBlocked("persistence", "sqlite", "API returns 403");

		const expected = computeBlockerFingerprint("persistence", "API returns 403");
		expect(registry.get("persistence", "sqlite")?.blockerFingerprint).toBe(expected);
		expect(shouldRejectDuplicateBlockedSpawn(registry, "persistence", expected)).toBe(true);
	});

	it("ignores a blank supplied fingerprint and falls back to recomputation", () => {
		const registry = new ApproachRegistry();
		registry.markBlocked("persistence", "sqlite", "API returns 403", undefined, "   ");

		const expected = computeBlockerFingerprint("persistence", "API returns 403");
		expect(registry.get("persistence", "sqlite")?.blockerFingerprint).toBe(expected);
	});
});

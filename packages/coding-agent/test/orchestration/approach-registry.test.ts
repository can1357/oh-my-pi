import { describe, expect, it } from "bun:test";
import {
	ApproachRegistry,
	computeBlockerFingerprint,
	shouldRejectDuplicateBlockedSpawn,
} from "../../src/orchestration/approach-registry";

describe("ApproachRegistry", () => {
	it("registers and retrieves records", () => {
		const registry = new ApproachRegistry();
		const record = registry.register({ family: "persistence", mechanism: "sqlite-cache" });
		expect(record.family).toBe("persistence");
		expect(record.mechanism).toBe("sqlite-cache");
		expect(record.status).toBe("active");
	});

	it("marks a route as blocked and sets fingerprint", () => {
		const registry = new ApproachRegistry();
		const record = registry.markBlocked("concurrency", "mutex-lock", "Deadlock in high contention");
		expect(record.status).toBe("blocked");
		expect(record.blocker).toBe("Deadlock in high contention");
		expect(record.blockerFingerprint).toBeDefined();
		expect(typeof record.blockerFingerprint).toBe("string");
	});

	it("finds a fingerprint match via hasBlockedFingerprint", () => {
		const registry = new ApproachRegistry();
		registry.markBlocked("network", "http-retry", "Connection refused");
		const fp = computeBlockerFingerprint("network", "Connection refused");
		expect(registry.hasBlockedFingerprint("network", fp)).toBe(true);
		expect(registry.hasBlockedFingerprint("network", "nonexistent")).toBe(false);
	});

	it("updates existing record on re-register", () => {
		const registry = new ApproachRegistry();
		registry.register({ family: "auth", mechanism: "jwt", status: "active" });
		const updated = registry.register({
			family: "auth",
			mechanism: "jwt",
			status: "promising",
			evidence: ["test passed"],
		});
		expect(updated.status).toBe("promising");
		expect(updated.evidence).toContain("test passed");
	});

	it("lists all records", () => {
		const registry = new ApproachRegistry();
		registry.register({ family: "f1", mechanism: "m1" });
		registry.register({ family: "f2", mechanism: "m2" });
		expect(registry.list().length).toBe(2);
	});

	it("clears all records", () => {
		const registry = new ApproachRegistry();
		registry.register({ family: "x", mechanism: "y" });
		registry.clear();
		expect(registry.list().length).toBe(0);
	});
});

describe("shouldRejectDuplicateBlockedSpawn", () => {
	it("returns false when family is undefined", () => {
		const registry = new ApproachRegistry();
		expect(shouldRejectDuplicateBlockedSpawn(registry, undefined, "fp")).toBe(false);
	});

	it("returns false when fingerprint is undefined", () => {
		const registry = new ApproachRegistry();
		expect(shouldRejectDuplicateBlockedSpawn(registry, "family", undefined)).toBe(false);
	});

	it("returns false when fingerprint not in registry", () => {
		const registry = new ApproachRegistry();
		registry.markBlocked("persistence", "sqlite", "read lock");
		expect(shouldRejectDuplicateBlockedSpawn(registry, "persistence", "nonexistent-fp")).toBe(false);
	});

	it("returns true when duplicate fingerprint exists for the family", () => {
		const registry = new ApproachRegistry();
		const record = registry.markBlocked("network", "tcp-retry", "ECONNREFUSED");
		const fp = record.blockerFingerprint!;
		expect(shouldRejectDuplicateBlockedSpawn(registry, "network", fp)).toBe(true);
	});

	it("returns false when fingerprint matches a different family", () => {
		const registry = new ApproachRegistry();
		// Mark "family-A" as blocked
		registry.markBlocked("family-A", "mech", "Blocker X");
		const fp = computeBlockerFingerprint("family-A", "Blocker X");
		// Same fingerprint content but for family-B should not match family-A
		expect(shouldRejectDuplicateBlockedSpawn(registry, "family-B", fp)).toBe(false);
	});
});

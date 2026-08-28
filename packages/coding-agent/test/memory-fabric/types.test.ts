/**
 * Canonical memory record types — factory, guards, and validation.
 */

import { describe, expect, it } from "bun:test";
import {
	createMemoryRecord,
	isDecisionRecord,
	isEvidenceRecord,
	isFactRecord,
	MEMORY_RECORD_TYPES,
	validateMemoryRecord,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/types";

function makeRecord(overrides?: Partial<Parameters<typeof createMemoryRecord>[0]>) {
	return createMemoryRecord({
		type: "fact",
		projectId: "proj-1",
		content: "The build uses bun, not npm.",
		sourceRefs: [{ type: "user-message", id: "msg-1" }],
		...overrides,
	});
}

describe("createMemoryRecord", () => {
	it("fills defaults and stamps timestamps", () => {
		const record = makeRecord();
		expect(record.projectId).toBe("proj-1");
		expect(record.type).toBe("fact");
		expect(record.tags).toEqual([]);
		expect(record.confidence).toBe(0.5);
		expect(record.importance).toBe(0.5);
		expect(record.sensitivity).toBe("project");
		expect(record.verification).toBe("observed");
		expect(record.schemaVersion).toBe(1);
		expect(record.createdAt).toBe(record.updatedAt);
		expect(record.validFrom).toBe(record.createdAt);
	});

	it("generates unique ids with the mem_ prefix", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const record = makeRecord();
			expect(record.id).toMatch(/^mem_/);
			expect(seen.has(record.id)).toBe(false);
			seen.add(record.id);
		}
	});

	it("computes a 64-hex-char SHA-256 content hash", () => {
		const record = makeRecord();
		expect(record.contentHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("hashes content and structured data together", () => {
		const plain = makeRecord();
		const samePlain = makeRecord();
		const withStructured = makeRecord({ structured: { statement: "x", domain: "y", evidence: [] } });
		expect(plain.contentHash).toBe(samePlain.contentHash);
		expect(plain.contentHash === withStructured.contentHash).toBe(false);
	});

	it("clamps confidence and importance into 0..1", () => {
		const record = makeRecord({ confidence: 7, importance: -3 });
		expect(record.confidence).toBe(1);
		expect(record.importance).toBe(0);
	});

	it("omits unset optional fields instead of writing undefined", () => {
		const record = makeRecord();
		expect(Object.hasOwn(record, "worktreeId")).toBe(false);
		expect(Object.hasOwn(record, "branchId")).toBe(false);
		expect(Object.hasOwn(record, "sessionId")).toBe(false);
		expect(Object.hasOwn(record, "taskId")).toBe(false);
		expect(Object.hasOwn(record, "agentId")).toBe(false);
		expect(Object.hasOwn(record, "structured")).toBe(false);
		expect(Object.hasOwn(record, "validUntil")).toBe(false);
		expect(Object.hasOwn(record, "expiresAt")).toBe(false);
		expect(Object.hasOwn(record, "supersedes")).toBe(false);
	});

	it("keeps provided optional scope fields", () => {
		const record = makeRecord({ sessionId: "sess-1", branchId: "main" });
		expect(record.sessionId).toBe("sess-1");
		expect(record.branchId).toBe("main");
	});

	it("respects an explicit id", () => {
		const record = makeRecord({ id: "mem_fixed" });
		expect(record.id).toBe("mem_fixed");
	});
});

describe("type guards", () => {
	it("narrow by the type discriminant", () => {
		const fact = makeRecord();
		expect(isFactRecord(fact)).toBe(true);
		expect(isEvidenceRecord(fact)).toBe(false);
		expect(isDecisionRecord(fact)).toBe(false);
	});
});

describe("validateMemoryRecord", () => {
	it("accepts a factory-built record", () => {
		expect(validateMemoryRecord(makeRecord())).toBe(true);
	});

	it("rejects non-objects and null", () => {
		expect(validateMemoryRecord(null)).toBe(false);
		expect(validateMemoryRecord("record")).toBe(false);
		expect(validateMemoryRecord(42)).toBe(false);
	});

	it("rejects an unknown type value", () => {
		const record = { ...makeRecord(), type: "gossip" };
		expect(validateMemoryRecord(record)).toBe(false);
	});

	it("rejects missing required string fields", () => {
		const record: Record<string, unknown> = { ...makeRecord() };
		delete record.contentHash;
		expect(validateMemoryRecord(record)).toBe(false);
	});

	it("rejects invalid sensitivity and verification values", () => {
		expect(validateMemoryRecord({ ...makeRecord(), sensitivity: "top-secret" })).toBe(false);
		expect(validateMemoryRecord({ ...makeRecord(), verification: "sworn" })).toBe(false);
	});

	it("rejects non-array sourceRefs or tags", () => {
		expect(validateMemoryRecord({ ...makeRecord(), sourceRefs: "none" })).toBe(false);
		expect(validateMemoryRecord({ ...makeRecord(), tags: null })).toBe(false);
	});
});

describe("record type registry", () => {
	it("covers all eight canonical kinds", () => {
		expect(MEMORY_RECORD_TYPES).toHaveLength(8);
		expect(MEMORY_RECORD_TYPES).toContain("evidence");
		expect(MEMORY_RECORD_TYPES).toContain("graph-assertion");
	});
});

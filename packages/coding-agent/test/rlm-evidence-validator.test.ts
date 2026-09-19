/**
 * P0.2 deterministic EvidencePacketV2 post-validator.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	emptyEvidencePacketV2,
	type EvidencePacketV2,
	parseEvidencePacketV2,
	rejectInvalidEvidencePacket,
	validateEvidencePacket,
} from "../src/rlm";
import { RlmRuntime, resetRlmStoresForTest } from "../src/rlm";
import { resolveRlmView } from "../src/rlm/view";

afterEach(() => {
	resetRlmStoresForTest();
});

describe("evidence validator", () => {
	test("rejects ungranted handle citations", () => {
		const runtime = new RlmRuntime({ maxCalls: 4 });
		const granted = runtime.store.put("GRANTED pool_limit=100");
		const ungranted = runtime.store.put("UNGRANTED pool_limit=50");
		const view = resolveRlmView(runtime.store, [{ handle: granted.id, start: 0, end: 30 }]);
		const packet: EvidencePacketV2 = {
			status: "sufficient",
			atoms: [
				{
					id: "a1",
					key: "pool_limit",
					value: "100",
					citations: [{ handle: `rlm://h/${ungranted.id}`, start: 0, end: 10 }],
				},
			],
			claims: [],
			contradictions: [],
			missingEvidence: [],
		};
		const v = validateEvidencePacket(runtime.store, view, packet);
		expect(v.ok).toBe(false);
		expect(v.violations.some(x => x.kind === "ungranted_handle")).toBe(true);
	});

	test("rejects identical contradiction sides", () => {
		const runtime = new RlmRuntime({ maxCalls: 4 });
		const rec = runtime.store.put("config max_connections=100\nruntime pool_limit=50");
		const view = resolveRlmView(runtime.store, [{ handle: rec.id, start: 0, end: 40 }]);
		const packet: EvidencePacketV2 = {
			status: "sufficient",
			atoms: [],
			claims: [],
			contradictions: [
				{
					left: { value: "50", citations: [{ handle: `rlm://h/${rec.id}`, start: 20, end: 35 }] },
					right: { value: "50", citations: [{ handle: `rlm://h/${rec.id}`, start: 20, end: 35 }] },
				},
			],
			missingEvidence: [],
		};
		const v = validateEvidencePacket(runtime.store, view, packet);
		expect(v.violations.some(x => x.kind === "contradiction_identical_sides")).toBe(true);
	});

	test("rejectInvalidEvidencePacket strips claims and records violations", () => {
		const runtime = new RlmRuntime({ maxCalls: 2 });
		const rec = runtime.store.put("FACT=1");
		const view = resolveRlmView(runtime.store, [{ handle: rec.id, start: 0, end: 5 }]);
		const bad = parseEvidencePacketV2({
			status: "sufficient",
			atoms: [],
			claims: [{ fact: "x", supports: ["missing"], citations: [], confidence: 1 }],
			contradictions: [],
			missingEvidence: [],
		});
		const v = validateEvidencePacket(runtime.store, view, bad);
		const rejected = rejectInvalidEvidencePacket(bad, v);
		expect(rejected.status).toBe("partial");
		expect(rejected.claims).toHaveLength(0);
		expect(rejected.missingEvidence.some(m => m.startsWith("validation:"))).toBe(true);
	});

	test("accepts valid atom with in-grant citation", () => {
		const runtime = new RlmRuntime({ maxCalls: 2 });
		const rec = runtime.store.put("active_connections reaches pool_limit under load");
		const view = resolveRlmView(runtime.store, [{ handle: rec.id, start: 0, end: 20 }]);
		const packet = emptyEvidencePacketV2("sufficient");
		packet.atoms.push({
			id: "pool_limit",
			key: "pool_limit",
			value: "saturation",
			citations: [{ handle: `rlm://h/${rec.id}`, start: 0, end: 20 }],
		});
		const v = validateEvidencePacket(runtime.store, view, packet);
		expect(v.ok).toBe(true);
		expect(v.structuralValid).toBe(true);
	});
});

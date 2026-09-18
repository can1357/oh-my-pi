/**
 * P0.2 citation normalization for EvidencePacketV2.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { normalizeEvidencePacketCitations } from "../src/rlm/evidence-packet-normalize";
import { emptyEvidencePacketV2 } from "../src/rlm/evidence-packet-v2";
import { RlmRuntime, resetRlmStoresForTest } from "../src/rlm";
import { resolveRlmView } from "../src/rlm/view";
import { validateEvidencePacket } from "../src/rlm/evidence-validator";

afterEach(() => {
	resetRlmStoresForTest();
});

describe("evidence packet citation normalize", () => {
	test("shifts excerpt-relative citations to absolute grant offsets", () => {
		const runtime = new RlmRuntime({ maxCalls: 4 });
		const rec = runtime.store.put(`${"x".repeat(100)}active_connections reaches pool_limit`);
		const view = resolveRlmView(runtime.store, [{ handle: rec.id, start: 100, end: 140 }]);
		const grant = view.grants[0]!;
		const packet = emptyEvidencePacketV2("sufficient");
		packet.atoms.push({
			id: "a1",
			key: "pool_limit",
			value: "saturation",
			citations: [{ handle: grant.handle, start: 0, end: 20 }],
		});
		const normalized = normalizeEvidencePacketCitations(packet, view);
		expect(normalized.atoms[0]!.citations[0]!.start).toBe(grant.start);
		const v = validateEvidencePacket(runtime.store, view, normalized);
		expect(v.ok).toBe(true);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { tryDeterministicContradictionPacket } from "../src/rlm/evidence-grant-supplement";
import { RlmRuntime, resetRlmStoresForTest } from "../src/rlm";
import { resolveRlmView } from "../src/rlm/view";
import { selectGrantsFromSearch } from "../src/rlm/select-grants";
import { validateEvidencePacket } from "../src/rlm/evidence-validator";
import { scoreContradictionValid } from "../evals/rlm/lib/evidence-codec-rubric";
import { LIVE_FIXTURES } from "../evals/rlm/lib/live-groq-common";

afterEach(() => resetRlmStoresForTest());

describe("grant contradiction supplement", () => {
	test("builds typed cited contradiction for S2-shaped grants", () => {
		const runtime = new RlmRuntime({ maxCalls: 4 });
		const fixture = LIVE_FIXTURES.find(f => f.id === "S2_contradictory")!;
		const rec = runtime.store.put(fixture.buildCorpus(), fixture.id);
		const selection = selectGrantsFromSearch(runtime.store, rec.id, fixture.patterns, {
			maxMatches: 4,
			contextChars: 512,
			maxTotalBytes: 8192,
			mode: "literal",
		});
		const view = resolveRlmView(runtime.store, selection.grants);
		const packet = tryDeterministicContradictionPacket(runtime.store, view);
		expect(packet?.contradictions.length).toBe(1);
		const v = validateEvidencePacket(runtime.store, view, packet!);
		expect(v.ok).toBe(true);
		expect(scoreContradictionValid(packet, fixture, runtime.store, view)).toBe(true);
	});
});

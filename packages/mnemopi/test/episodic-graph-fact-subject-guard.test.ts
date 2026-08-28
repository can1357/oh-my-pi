import { describe, expect, it } from "bun:test";
import { EpisodicGraph, isPlausibleFactSubject } from "@oh-my-pi/pi-mnemopi/core/episodic-graph";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";

// Junk subjects verbatim from the real bank snapshot (fixtures/bank.db), captured by
// extractFacts's loose "X is/has/uses/works" regexes before this guard existed.
const JUNK_SUBJECTS = [
	"This",
	"Do not",
	"The process",
	"The name",
	"I wonder which of these two memory systems",
	"Left Option for Hungarian symbols while",
	"Server recovered\n\nA detached server",
];

const REAL_SUBJECTS = [
	"Backend",
	"Telemetry",
	"Bash tool",
	"Kitty APC graphics upload",
	"LongMemEval claim",
	"Richest bank",
];

describe("isPlausibleFactSubject", () => {
	it("rejects sentence-fragment subjects pulled from the real bank", () => {
		for (const subject of JUNK_SUBJECTS) {
			expect(isPlausibleFactSubject(subject)).toBe(false);
		}
	});

	it("keeps plausible entity-shaped subjects", () => {
		for (const subject of REAL_SUBJECTS) {
			expect(isPlausibleFactSubject(subject)).toBe(true);
		}
	});
});

function withGraph<T>(fn: (graph: EpisodicGraph) => T): T {
	const db = openDatabase(":memory:");
	try {
		const graph = new EpisodicGraph({ db });
		return fn(graph);
	} finally {
		closeQuietly(db);
	}
}

describe("EpisodicGraph.extractFacts subject guard", () => {
	it("drops a fragment-subject match while still keeping a genuine one", () => {
		withGraph(graph => {
			const facts = graph.extractFacts("The process is slow. Backend is a service.", "mem_guard");
			expect(facts.some(fact => fact.subject === "The process")).toBe(false);
			expect(facts.some(fact => fact.subject === "Backend" && fact.object === "service")).toBe(true);
		});
	});
});

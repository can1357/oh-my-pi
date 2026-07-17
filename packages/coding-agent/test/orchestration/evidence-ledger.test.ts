import { describe, expect, it } from "bun:test";
import { EVIDENCE_RECORD_VERSION, EvidenceLedger } from "../../src/orchestration/evidence-ledger";

const CONTRACT_ID = "contract-abc";

function makeInput(overrides?: Record<string, unknown>) {
	return {
		taskContractId: CONTRACT_ID,
		criterionIds: ["C1"],
		claim: "tests pass",
		kind: "test" as const,
		locator: "bun test packages/foo",
		status: "supports" as const,
		redactionStatus: "clean" as const,
		...overrides,
	};
}

describe("EvidenceLedger.append", () => {
	it("appends a valid record and returns it", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		const result = ledger.append(makeInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.record.version).toBe(EVIDENCE_RECORD_VERSION);
		expect(result.record.taskContractId).toBe(CONTRACT_ID);
		expect(result.record.criterionIds).toEqual(["C1"]);
		expect(result.record.id).toBeString();
		expect(result.record.timestamp).toBeString();
	});

	it("rejects a record for a different taskContractId", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		const result = ledger.append(makeInput({ taskContractId: "other-contract" }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0].code).toBe("contract_mismatch");
	});

	it("rejects an empty claim", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		const result = ledger.append(makeInput({ claim: "" }));
		expect(result.ok).toBe(false);
	});

	it("rejects an empty locator", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		const result = ledger.append(makeInput({ locator: "" }));
		expect(result.ok).toBe(false);
	});

	it("rejects an invalid kind", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		const result = ledger.append(makeInput({ kind: "magic" as "test" }));
		expect(result.ok).toBe(false);
	});

	it("rejects an invalid status", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		const result = ledger.append(makeInput({ status: "unknown" as "supports" }));
		expect(result.ok).toBe(false);
	});

	it("rejects an invalid redactionStatus", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		const result = ledger.append(makeInput({ redactionStatus: "exposed" as "clean" }));
		expect(result.ok).toBe(false);
	});

	it("rejects non-string elements in criterionIds", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		const result = ledger.append(makeInput({ criterionIds: [1, 2] as unknown as string[] }));
		expect(result.ok).toBe(false);
	});

	it("assigns unique ids to successive records", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		const r1 = ledger.append(makeInput());
		const r2 = ledger.append(makeInput());
		if (!r1.ok || !r2.ok) throw new Error("setup failed");
		expect(r1.record.id).not.toBe(r2.record.id);
	});
});

describe("EvidenceLedger queries", () => {
	it("forCriterion returns only matching records", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		ledger.append(makeInput({ criterionIds: ["C1"] }));
		ledger.append(makeInput({ criterionIds: ["C2"], claim: "C2 check" }));
		expect(ledger.forCriterion("C1")).toHaveLength(1);
		expect(ledger.forCriterion("C2")).toHaveLength(1);
		expect(ledger.forCriterion("C3")).toHaveLength(0);
	});

	it("supportingForCriterion filters to supports/partial", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		ledger.append(makeInput({ status: "supports" }));
		ledger.append(makeInput({ status: "partial", claim: "partial evidence" }));
		ledger.append(makeInput({ status: "contradicts", claim: "failing test" }));
		expect(ledger.supportingForCriterion("C1")).toHaveLength(2);
	});

	it("contradictingForCriterion filters to contradicts", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		ledger.append(makeInput({ status: "supports" }));
		ledger.append(makeInput({ status: "contradicts", claim: "bad" }));
		expect(ledger.contradictingForCriterion("C1")).toHaveLength(1);
	});

	it("byKind filters by evidence kind", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		ledger.append(makeInput({ kind: "test" }));
		ledger.append(makeInput({ kind: "command", claim: "cmd output" }));
		expect(ledger.byKind("test")).toHaveLength(1);
		expect(ledger.byKind("command")).toHaveLength(1);
		expect(ledger.byKind("source")).toHaveLength(0);
	});

	it("byModule filters by moduleInstanceId", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		ledger.append(makeInput({ moduleInstanceId: "m1" }));
		ledger.append(makeInput({ moduleInstanceId: "m2", claim: "m2 evidence" }));
		expect(ledger.byModule("m1")).toHaveLength(1);
		expect(ledger.byModule("m2")).toHaveLength(1);
	});

	it("all returns records in append order", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		ledger.append(makeInput({ claim: "first" }));
		ledger.append(makeInput({ claim: "second" }));
		const all = ledger.all();
		expect(all[0].claim).toBe("first");
		expect(all[1].claim).toBe("second");
	});

	it("size reflects appended count", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		expect(ledger.size).toBe(0);
		ledger.append(makeInput());
		ledger.append(makeInput({ claim: "second" }));
		expect(ledger.size).toBe(2);
	});
});

describe("EvidenceLedger.evaluateCriterionCoverage", () => {
	it("returns pass when supporting evidence exists and no contradictions", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		ledger.append(makeInput({ status: "supports" }));
		const coverage = ledger.evaluateCriterionCoverage(["C1"]);
		expect(coverage.C1).toBe("pass");
	});

	it("returns fail when only contradicting evidence exists", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		ledger.append(makeInput({ status: "contradicts", claim: "test failed" }));
		const coverage = ledger.evaluateCriterionCoverage(["C1"]);
		expect(coverage.C1).toBe("fail");
	});

	it("returns contradicted when both supporting and contradicting evidence exists", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		ledger.append(makeInput({ status: "supports" }));
		ledger.append(makeInput({ status: "contradicts", claim: "also fails" }));
		const coverage = ledger.evaluateCriterionCoverage(["C1"]);
		expect(coverage.C1).toBe("contradicted");
	});

	it("returns unproven for a criterion with no records", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		const coverage = ledger.evaluateCriterionCoverage(["C1", "C2"]);
		expect(coverage.C1).toBe("unproven");
		expect(coverage.C2).toBe("unproven");
	});

	it("covers multiple criteria independently", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		ledger.append(makeInput({ criterionIds: ["C1"], status: "supports" }));
		ledger.append(makeInput({ criterionIds: ["C2"], status: "contradicts", claim: "C2 failed" }));
		const coverage = ledger.evaluateCriterionCoverage(["C1", "C2", "C3"]);
		expect(coverage.C1).toBe("pass");
		expect(coverage.C2).toBe("fail");
		expect(coverage.C3).toBe("unproven");
	});
});

describe("EvidenceLedger.snapshot", () => {
	it("snapshot reflects all appended records", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		ledger.append(makeInput());
		ledger.append(makeInput({ claim: "second" }));
		const snap = ledger.snapshot();
		expect(snap.count).toBe(2);
		expect(snap.records).toHaveLength(2);
		expect(snap.taskContractId).toBe(CONTRACT_ID);
	});

	it("snapshot is immutable — modifying it does not change the ledger", () => {
		const ledger = new EvidenceLedger(CONTRACT_ID);
		ledger.append(makeInput());
		const snap = ledger.snapshot();
		ledger.append(makeInput({ claim: "new" }));
		expect(snap.count).toBe(1);
		expect(ledger.size).toBe(2);
	});
});

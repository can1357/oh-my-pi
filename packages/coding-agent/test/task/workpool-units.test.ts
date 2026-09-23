import { describe, expect, it } from "bun:test";
import workpoolUnitLedgerTemplate from "../../src/prompts/tools/workpool-unit-ledger.md" with { type: "text" };
import {
	buildUnitLedger,
	classifyUnitReport,
	type UnitAttempt,
	type UnitItemState,
	unitLedgerView,
} from "../../src/task/workpool-units";
import { prompt } from "@oh-my-pi/pi-utils";

const MISSING = "worker yielded no report for this unit";

describe("classifyUnitReport", () => {
	it("accepts only done units with a value and no failed verification", () => {
		const cases: Array<[string, unknown, string]> = [
			["done + passed", { status: "done", value: 1, verification: { status: "passed" } }, "accepted"],
			["done, not verified", { status: "done", value: 0 }, "accepted"],
			["unresolved", { status: "unresolved", value: 1, reason: "needs creds" }, "unresolved"],
			[
				"failed verification",
				{ status: "done", value: 1, verification: { status: "failed" } },
				"verification_failed",
			],
			["no report", undefined, "missing"],
			["prose instead of object", "looks fine to me", "malformed"],
			["unknown status", { status: "complete", value: 1 }, "malformed"],
			["done without value", { status: "done" }, "malformed"],
			["non-string evidence", { status: "done", value: 1, evidence: [{ path: "a" }] }, "malformed"],
			["bad verification status", { status: "done", value: 1, verification: { status: "ok" } }, "malformed"],
			// Strict-mode providers send omitted optionals as null.
			[
				"strict-mode null optionals",
				{
					status: "done",
					value: 1,
					evidence: null,
					verification: { status: "passed", commands: null },
					reason: null,
				},
				"accepted",
			],
			["null value", { status: "done", value: null }, "malformed"],
		];
		const results = cases.map(([label, report]) => {
			const outcome = classifyUnitReport(report, MISSING);
			return [label, outcome.kind === "accepted" ? "accepted" : outcome.reason];
		});
		expect(results).toEqual(cases.map(([label, , expected]) => [label, expected]));
	});

	it("carries the worker's reason, evidence, and failed check into the residual", () => {
		expect(
			classifyUnitReport(
				{
					status: "done",
					value: "patched",
					evidence: ["src/a.ts:10"],
					verification: { status: "failed", commands: ["bun test a"], details: "2 fail" },
				},
				MISSING,
			),
		).toEqual({
			kind: "residual",
			reason: "verification_failed",
			detail: "2 fail",
			evidence: ["src/a.ts:10"],
			verification: { status: "failed", commands: ["bun test a"], details: "2 fail" },
		});
		expect(classifyUnitReport(undefined, "batch failed: timeout")).toMatchObject({ detail: "batch failed: timeout" });
	});
});

describe("buildUnitLedger", () => {
	const items: UnitItemState[] = [
		{ id: "p#1", seq: 1, text: "Audit auth", status: "completed" },
		{ id: "p#2", seq: 2, text: "Audit billing", status: "completed" },
		{ id: "p#3", seq: 3, text: "Audit export", status: "failed" },
	];
	const attempts: UnitAttempt[] = [
		{
			itemId: "p#2",
			attempt: 1,
			agentId: "w-1",
			batchId: "w-1-b2",
			outcome: classifyUnitReport({ status: "done", value: 1, verification: { status: "failed" } }, MISSING),
		},
		{
			itemId: "p#1",
			attempt: 1,
			agentId: "w-1",
			batchId: "w-1-b1",
			outcome: classifyUnitReport({ status: "done", value: { ok: true }, evidence: ["a.ts:1"] }, MISSING),
		},
		{
			itemId: "p#2",
			attempt: 2,
			agentId: "w-2",
			batchId: "w-2-b1",
			outcome: classifyUnitReport(
				{
					status: "done",
					value: 2,
					evidence: ["b.ts:4"],
					verification: { status: "passed", commands: ["bun test b"] },
				},
				MISSING,
			),
		},
		{ itemId: "p#3", attempt: 1, agentId: "w-2", batchId: "w-2-b1", outcome: classifyUnitReport(undefined, MISSING) },
		{
			itemId: "p#3",
			attempt: 2,
			agentId: "w-1",
			batchId: "w-1-b3",
			outcome: classifyUnitReport({ status: "unresolved", reason: "no access" }, MISSING),
		},
	];

	function render(ledgerItems: UnitItemState[], ledgerAttempts: UnitAttempt[]): string {
		return prompt.render(
			workpoolUnitLedgerTemplate,
			unitLedgerView("p", buildUnitLedger(ledgerItems, ledgerAttempts)),
		);
	}

	it("produces byte-identical state for every arrival order of the same attempts", () => {
		const baseline = render(items, attempts);
		const permutations: UnitAttempt[][] = [
			[...attempts].reverse(),
			[attempts[3]!, attempts[0]!, attempts[4]!, attempts[2]!, attempts[1]!],
			[attempts[2]!, attempts[4]!, attempts[1]!, attempts[0]!, attempts[3]!],
		];
		for (const order of permutations) {
			expect(render([...items].reverse(), order)).toBe(baseline);
			expect(buildUnitLedger(items, order)).toEqual(buildUnitLedger(items, attempts));
		}
	});

	it("keeps the accepting attempt's value and evidence plus every attempt's worker and batch", () => {
		const ledger = buildUnitLedger(items, attempts);
		expect(ledger.map(entry => [entry.id, entry.state, entry.reason])).toEqual([
			["p#1", "accepted", undefined],
			["p#2", "accepted", undefined],
			["p#3", "residual", "unresolved"],
		]);
		expect(ledger[0]).toMatchObject({ verified: false, value: { ok: true }, evidence: ["a.ts:1"] });
		expect(ledger[1]).toMatchObject({
			verified: true,
			value: 2,
			evidence: ["b.ts:4"],
			attempts: [
				{ attempt: 1, agentId: "w-1", batchId: "w-1-b2", result: "verification_failed" },
				{ attempt: 2, agentId: "w-2", batchId: "w-2-b1", result: "accepted" },
			],
		});
		expect(ledger[2]?.attempts.map(attempt => attempt.result)).toEqual(["missing", "unresolved"]);
		expect(ledger[2]?.detail).toBe("no access");
	});

	it("reports in-flight, cancelled, and never-attempted units without inventing results", () => {
		const ledger = buildUnitLedger(
			[
				{ id: "q#1", seq: 1, text: "retrying", status: "queued" },
				{ id: "q#2", seq: 2, text: "closed early", status: "cancelled" },
				{ id: "q#3", seq: 3, text: "dispatch failed", status: "failed" },
			],
			[
				{
					itemId: "q#1",
					attempt: 1,
					agentId: "w",
					batchId: "w-b1",
					outcome: classifyUnitReport(undefined, MISSING),
				},
			],
		);
		expect(ledger.map(entry => [entry.state, entry.reason])).toEqual([
			["pending", undefined],
			["cancelled", undefined],
			["residual", "missing"],
		]);
	});
});

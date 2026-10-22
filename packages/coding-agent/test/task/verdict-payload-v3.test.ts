import { describe, expect, it } from "bun:test";
import { finalizeSubprocessOutput } from "../../src/task/executor";

// G062: verbatim abort-reason from the live RecursionCorrection lane
// (DeepEnvWave3.RecursionCorrection, status=cancelled, output {aborted:true,error:<this>}).
// The terminal yield put the real deliverable on the `error` channel. Shape: a top-level `data`
// object carrying `verdict: "PASS"`, no `status` field anywhere, and nested `childReports[].verdict`
// PASS entries that must NOT count as the resolved record's token.
const RECURSION_CORRECTION_ABORT_REASON = `{"data": {"brief": "RecursionCorrection (G085 + SH-08): correct report timestamps/routing gaps and confounded matched plan; preserve ten feeder units + referee + four valid artifacts", "children": 3, "taskCalls": 1, "childReports": [{"id": "DeepEnvWave3.RecursionCorrection.RecurseAudit", "verdict": "PASS", "artifact": "reviews/orchestrate/2026-09-10-phase2/env-wave/recursion/correction-audit/audit.md (184 lines)", "routing": "deepseek/deepseek-v4-flash, resolvedModelIsFallback false, own jsonl:3", "finding": "Lead start 08:41:43.524Z PRESERVED; '48 seconds' respawn false (actual 238.49s); 08:50Z-vs-mtime-08:52:23Z unresolved; BakeoffPlan 'nothing on disk' partial (50-byte file); routing = Muse lead/watcher/report vs DeepSeek owner cohort, all fallback false"}, {"id": "DeepEnvWave3.RecursionCorrection.MatchedPlanFix", "verdict": "PASS", "artifact": "reviews/orchestrate/2026-09-10-phase2/env-wave/recursion/bakeoff-plan/bakeoff-plan-corrected.md (267 lines, sha256 36c1346c6a8474cfc559b49a97f6afebf1a8eca3660fbb2498fb16e17ccea986)", "routing": "deepseek/deepseek-v4-flash, resolvedModelIsFallback false, own jsonl:3", "finding": "Same-model rule + retained void-on-fallback + pre-dispatch jsonl:3 receipt check; model-vs-delegation separation paragraph; roster diff exit 0, referee diff exit 0, gate diff exit 1 (one declared voided-pair sentence); original 173-line plan untouched"}, {"id": "DeepEnvWave3.RecursionCorrection.RecurseReportFix", "verdict": "PASS", "artifact": "reviews/orchestrate/2026-09-10-phase2/env-wave/recursion/report-corrected.md (191 lines)", "routing": "deepseek/deepseek-v4-flash, resolvedModelIsFallback false, own jsonl:3", "finding": "Eight-seat accounting with audit-verified stamps; chronology without causal claim; original 61-line report.md mtime unchanged"}], "ownRouting": "openrouter/meta/muse-spark-1.3-contributor, resolvedModelIsFallback false, agent/sessions/-.omp/2026-09-10T03-53-28-158Z_01a08972-f75e-724a-a2cb-0ab46606b80c/DeepEnvWave3/DeepEnvWave3.RecursionCorrection.jsonl:3 (bash EXIT:0)", "verification": ["wc -l audit.md/report-corrected.md/bakeoff-plan-corrected.md/report.md/bakeoff-plan.md = 184/191/267/61/173, EXIT:0", "Read audit.md fully (184 lines), report-corrected.md:1-63 + :64-191, bakeoff-plan-corrected.md:1-80 + :84-180 + :184-267 — all end END, ten-unit table + referee preserved, no causal allegation", "No DB query rerun; originals untouched"], "deviations": ["PlanFix added two metric fields (model_id, model_fallback) + one gate-analysis sentence on voided pairs counting as undecided — both declared in its yield, accepted as required for auditability", "Report-corrected.md cites bakeoff-plan-corrected.md at 17446 bytes/263 lines from a mid-write read; landed file is 17912 bytes/267 lines after final receipt-table edit — content verified identical in scope, size drift only"], "remainingLimits": ["Bakeoff not executed: zero pairs run; same-model control is a design rule realized only on execution", "Original report write time (08:50Z vs 08:52:23Z mtime) unresolved by line-2/line-3 receipts alone", "'48 seconds' figure unsourcable from receipts", "Sample is ten pairs; cannot generalize thresholds"], "ledgerRows": ["- 2026-09-10 09:0x UTC · DeepEnvWave2.RecursionGates correction-audit · PASS — 8/8 seat receipts verified from raw jsonl:2/:3; G085-a start stamp 08:41:43.524Z PRESERVED; GAPS: '48 seconds' false (238.49 s), 08:50Z vs 08:52:23Z unresolved, 'nothing on disk' partial (50-byte file); Muse lead/watcher/report vs DeepSeek owner cohort, all fallback false.", "- 2026-09-10 09:0x UTC · DeepEnvWave2.RecursionGates correction · PASS — corrected report report-corrected.md preserves G085/SH-08 start stamp 08:41:43Z, corrects '48 seconds' to 238.49 s, marks 08:50Z-vs-08:52:23Z unresolved, corrects 'nothing on disk' to 50-byte partial, accounts all eight seats, routes Muse lead/watcher/report versus DeepSeek owner cohort all fallback false."], "verdict": "PASS"}}`;

function runWith(payload: string) {
	return finalizeSubprocessOutput({
		rawOutput: "",
		exitCode: 0,
		stderr: "",
		doneAborted: false,
		signalAborted: false,
		yieldItems: [{ status: "aborted", error: payload }],
		outputSchema: undefined,
	});
}

describe("terminal yield abort envelope (G062/G138 v3)", () => {
	// ---- valid terminal deliveries that must survive the v3 correction ----
	it("delivers the live RecursionCorrection abort reason instead of wrapping it", () => {
		const parsed = JSON.parse(RECURSION_CORRECTION_ABORT_REASON);
		expect(parsed.data.verdict).toBe("PASS");
		expect(JSON.stringify(parsed)).not.toContain('"status"');

		const result = runWith(RECURSION_CORRECTION_ABORT_REASON);

		expect(result.abortedViaYield).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.rawOutput).toBe(RECURSION_CORRECTION_ABORT_REASON);
	});

	it("delivers a bare data.verdict PASS payload", () => {
		const payload = JSON.stringify({ data: { verdict: "PASS", details: "guard wired" } });
		const result = runWith(payload);

		expect(result.abortedViaYield).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.rawOutput).toBe(payload);
	});

	it("delivers a result.data-wrapped verdict PASS payload", () => {
		const payload = JSON.stringify({ result: { data: { verdict: "PASS", details: "guard wired" } } });
		const result = runWith(payload);

		expect(result.abortedViaYield).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.rawOutput).toBe(payload);
	});

	it("delivers a root verdict PASS payload", () => {
		const payload = JSON.stringify({ verdict: "PASS", details: "root-level terminal result" });
		const result = runWith(payload);

		expect(result.abortedViaYield).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.rawOutput).toBe(payload);
	});

	it("delivers a root status PASS payload", () => {
		const payload = JSON.stringify({ status: "PASS", details: "status token" });
		const result = runWith(payload);

		expect(result.abortedViaYield).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.rawOutput).toBe(payload);
	});

	it("delivers a root status success payload", () => {
		const payload = JSON.stringify({ status: "success", details: "success token" });
		const result = runWith(payload);

		expect(result.abortedViaYield).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.rawOutput).toBe(payload);
	});

	// ---- the v2 hole: a PASS alongside an explicit non-success must not win ----
	it("still aborts a data.verdict ISSUES payload", () => {
		const payload = JSON.stringify({ data: { verdict: "ISSUES", details: "lane found defects" } });
		const result = runWith(payload);

		expect(result.abortedViaYield).toBe(true);
		expect(result.stderr).toBe(payload);
		expect(result.rawOutput).toBe(JSON.stringify({ aborted: true, error: payload }, null, 2));
	});

	it("aborts a PASS/ISSUES contradiction inside one resolved record", () => {
		const payload = JSON.stringify({ data: { status: "PASS", verdict: "ISSUES" } });
		const result = runWith(payload);

		expect(result.abortedViaYield).toBe(true);
		expect(result.stderr).toBe(payload);
		expect(result.rawOutput).toBe(JSON.stringify({ aborted: true, error: payload }, null, 2));
	});

	it("aborts when any explicit failure token sits beside a PASS", () => {
		for (const token of ["ISSUES", "BLOCKED", "FAIL", "ERROR"]) {
			const payload = JSON.stringify({ data: { verdict: "PASS", status: token } });
			const result = runWith(payload);

			expect(result.abortedViaYield).toBe(true);
			expect(result.stderr).toBe(payload);
			expect(result.rawOutput).toBe(JSON.stringify({ aborted: true, error: payload }, null, 2));
		}
	});

	it("aborts a nested child PASS under a top-level ISSUES", () => {
		const payload = JSON.stringify({ status: "ISSUES", data: { verdict: "PASS" } });
		const result = runWith(payload);

		expect(result.abortedViaYield).toBe(true);
		expect(result.stderr).toBe(payload);
		expect(result.rawOutput).toBe(JSON.stringify({ aborted: true, error: payload }, null, 2));
	});

	it("does not let a child-array PASS override a top-level ISSUES", () => {
		const payload = JSON.stringify({
			data: { verdict: "ISSUES", children: [{ verdict: "PASS" }, { verdict: "PASS" }] },
		});
		const result = runWith(payload);

		expect(result.abortedViaYield).toBe(true);
		expect(result.stderr).toBe(payload);
		expect(result.rawOutput).toBe(JSON.stringify({ aborted: true, error: payload }, null, 2));
	});

	it("aborts a success-word announcement with no resolved outcome token", () => {
		const payload = JSON.stringify({ data: { summary: "22 pass, 0 fail", counts: { pass: 22, fail: 0 } } });
		const result = runWith(payload);

		expect(result.abortedViaYield).toBe(true);
		expect(result.stderr).toBe(payload);
		expect(result.rawOutput).toBe(JSON.stringify({ aborted: true, error: payload }, null, 2));
	});

	it("aborts a near-token substring that is not an exact success token", () => {
		for (const payload of [
			JSON.stringify({ data: { verdict: "passed" } }),
			JSON.stringify({ data: { status: "in-progress", note: "verification passed" } }),
		]) {
			const result = runWith(payload);

			expect(result.abortedViaYield).toBe(true);
			expect(result.stderr).toBe(payload);
			expect(result.rawOutput).toBe(JSON.stringify({ aborted: true, error: payload }, null, 2));
		}
	});

	// ---- intentional cancel stays on the abort path ----
	it("still aborts on a genuine caller cancel", () => {
		const result = runWith("Cancelled by caller");

		expect(result.abortedViaYield).toBe(true);
		expect(result.stderr).toBe("Cancelled by caller");
		expect(result.rawOutput).toBe(JSON.stringify({ aborted: true, error: "Cancelled by caller" }, null, 2));
	});

	it("still aborts a JSON error payload with no success token", () => {
		const payload = JSON.stringify({ error: "boom", message: "subagent crashed" });
		const result = runWith(payload);

		expect(result.abortedViaYield).toBe(true);
		expect(result.stderr).toBe(payload);
		expect(result.rawOutput).toBe(JSON.stringify({ aborted: true, error: payload }, null, 2));
	});
});

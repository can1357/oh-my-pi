import { describe, expect, it } from "bun:test";
import { finalizeSubprocessOutput } from "../../src/task/executor";

const PASS_DELIVERY = JSON.stringify({
	status: "PASS",
	details: "guard wired",
	artifacts: [{ locator: "reviews/orchestrate/x/report.md" }],
});

const WRAPPED_PASS_DELIVERY = JSON.stringify({
	result: { data: { status: "PASS", details: "guard wired" } },
});

describe("terminal yield with a PASS payload on the error channel", () => {
	it("delivers the payload instead of wrapping it into an abort-reason envelope", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "aborted", error: PASS_DELIVERY }],
			outputSchema: undefined,
		});

		expect(result.abortedViaYield).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.rawOutput).toBe(PASS_DELIVERY);
	});

	it("delivers a result.data-wrapped PASS payload on the error channel", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "aborted", error: WRAPPED_PASS_DELIVERY }],
			outputSchema: undefined,
		});

		expect(result.abortedViaYield).toBe(false);
		expect(result.rawOutput).toBe(WRAPPED_PASS_DELIVERY);
	});

	it("still aborts on a genuine caller cancel", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: true,
			signalAborted: true,
			yieldItems: [{ status: "aborted", error: "Cancelled by caller" }],
			outputSchema: undefined,
		});

		expect(result.abortedViaYield).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("Cancelled by caller");
		expect(result.rawOutput).toBe(JSON.stringify({ aborted: true, error: "Cancelled by caller" }, null, 2));
	});

	it("still aborts when the error payload carries no success status", () => {
		const issues = JSON.stringify({ status: "ISSUES", details: "lane found defects" });
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "aborted", error: issues }],
			outputSchema: undefined,
		});

		expect(result.abortedViaYield).toBe(true);
		expect(result.stderr).toBe(issues);
		expect(result.rawOutput).toBe(JSON.stringify({ aborted: true, error: issues }, null, 2));
	});

	it("keeps a pre-yield failure exit code while still delivering the PASS payload", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 1,
			stderr: "stream error: ECONNRESET",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "aborted", error: PASS_DELIVERY }],
			outputSchema: undefined,
		});

		expect(result.abortedViaYield).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("stream error: ECONNRESET");
		expect(result.rawOutput).toBe(PASS_DELIVERY);
	});
});

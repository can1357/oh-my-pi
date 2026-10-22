import { describe, expect, it } from "bun:test";
import { finalizeSubprocessOutput, type FinalizeSubprocessOutputArgs } from "../../src/task/executor";

const okSchema = {
	type: "object",
	additionalProperties: false,
	properties: { ok: { const: true } },
	required: ["ok"],
} as const;
const successYield = [{ status: "success" as const, data: { ok: true } }];

function finalize(overrides: Partial<FinalizeSubprocessOutputArgs> = {}) {
	return finalizeSubprocessOutput({
		rawOutput: "",
		exitCode: 0,
		stderr: "",
		doneAborted: false,
		signalAborted: false,
		yieldItems: successYield,
		outputSchema: okSchema,
		outputSchemaMode: "strict",
		outputSchemaSource: "caller",
		terminalContext: {
			terminalYieldAccepted: false,
			yieldInvalidatedByAsync: false,
			abortKind: undefined,
		},
		...overrides,
	});
}

describe("terminal task failure classification", () => {
	it("keeps a valid successful yield successful", () => {
		const result = finalize({});
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("preserves a genuine nonzero exit with empty stderr when no result was committed", () => {
		const result = finalize({ exitCode: 1, stderr: "", yieldItems: [] });
		expect(result.exitCode).not.toBe(0);
	});

	it("fails nonzero empty stderr with a committed yield and no verified internal cause", () => {
		const result = finalize({ exitCode: 1, stderr: "" });
		expect(result.exitCode).not.toBe(0);
		expect(result.structuredOutput?.status).not.toBe("valid");
	});

	it("preserves a completed yield through verified internal abort cleanup", () => {
		const result = finalize({
			exitCode: 1,
			stderr: "",
			terminalContext: {
				terminalYieldAccepted: true,
				yieldInvalidatedByAsync: false,
				abortKind: "terminate",
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("invalidates valid structured metadata on a final nonzero exit while preserving data", () => {
		const result = finalize({
			exitCode: 1,
			stderr: "child crashed",
			terminalContext: {
				terminalYieldAccepted: true,
				yieldInvalidatedByAsync: false,
				abortKind: "terminate",
			},
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.structuredOutput?.status).not.toBe("valid");
		expect(result.structuredOutput?.data).toEqual({ ok: true });
	});

	it("preserves a genuine nonzero exit with stderr", () => {
		const result = finalize({ exitCode: 1, stderr: "child crashed" });
		expect(result.exitCode).not.toBe(0);
		expect(result.structuredOutput?.status).not.toBe("valid");
	});

	it("lets a committed success survive expected internal doneAborted termination", () => {
		const result = finalize({
			doneAborted: true,
			exitCode: 1,
			stderr: "",
			terminalContext: {
				terminalYieldAccepted: true,
				yieldInvalidatedByAsync: false,
				abortKind: "terminate",
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("does not downgrade a committed success for late external signal", () => {
		const result = finalize({
			signalAborted: true,
			exitCode: 0,
			stderr: "",
			terminalContext: {
				terminalYieldAccepted: true,
				yieldInvalidatedByAsync: false,
				abortKind: "signal",
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("provides a concrete reason when terminal failure forces exit 1", () => {
		const result = finalize({
			doneAborted: true,
			yieldItems: successYield,
			outputSchema: undefined,
			outputSchemaSource: undefined,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("Subagent terminated before committing a result");
	});

	it("fails a genuine cancellation with no committed terminal yield", () => {
		const result = finalize({
			doneAborted: true,
			yieldItems: [{ status: "success", type: ["section"], data: { ok: true } }],
			outputSchema: undefined,
			outputSchemaSource: undefined,
		});
		expect(result.exitCode).not.toBe(0);
	});

	it("preserves a legitimate payload containing error", () => {
		const result = finalize({
			yieldItems: [{ status: "success", data: { error: "existing validation issue" } }],
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: { error: { type: "string" } },
				required: ["error"],
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("preserves a legitimate payload containing success:false", () => {
		const result = finalize({
			yieldItems: [{ status: "success", data: { success: false } }],
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: { success: { type: "boolean" } },
				required: ["success"],
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("retains explicit aborted-yield failure metadata", () => {
		const result = finalize({
			yieldItems: [{ status: "aborted", error: "blocked by permissions" }],
			outputSchema: undefined,
		});
		expect(result.abortedViaYield).toBe(true);
		expect(result.rawOutput).toContain('"aborted": true');
	});

	it("does not treat a stale terminal yield invalidated by async delivery as committed", () => {
		const result = finalize({
			doneAborted: true,
			yieldItems: [
				{ status: "success", data: { ok: true } },
				{ status: "success", type: ["later"], data: { partial: true } },
			],
			outputSchema: undefined,
			outputSchemaSource: undefined,
			terminalContext: {
				terminalYieldAccepted: false,
				yieldInvalidatedByAsync: true,
				abortKind: "terminate",
			},
		});
		expect(result.exitCode).not.toBe(0);
	});

	it("treats a forced-final incremental yield as terminal when accepted", () => {
		const result = finalize({
			doneAborted: true,
			yieldItems: [{ status: "success", type: ["final"], data: { final: true } }],
			outputSchema: undefined,
			outputSchemaSource: undefined,
			terminalContext: {
				terminalYieldAccepted: true,
				yieldInvalidatedByAsync: false,
				abortKind: "terminate",
			},
		});
		expect(result.exitCode).toBe(0);
	});

	it("keeps a terminal success after incremental sections successful", () => {
		const result = finalize({
			yieldItems: [
				{ status: "success", type: ["section"], data: { partial: true } },
				{ status: "success", data: { ok: true } },
			],
			outputSchema: undefined,
		});
		expect(result.exitCode).toBe(0);
	});

	it("counts a schema-overridden accepted yield as committed under run-monitor context", () => {
		const result = finalize({
			exitCode: 1,
			stderr: "",
			yieldItems: [{ status: "success", data: { findings: [{}] }, schemaOverridden: true }],
			outputSchemaMode: "permissive",
			outputSchema: {
				type: "object",
				required: ["findings"],
				properties: { findings: { type: "array", items: { type: "object", required: ["severity"] } } },
			},
			terminalContext: {
				terminalYieldAccepted: true,
				yieldInvalidatedByAsync: false,
				abortKind: "terminate",
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("schema-retry budget");
	});

	it("preserves a malformed permissive schema as an accepted, committed yield", () => {
		const result = finalize({
			exitCode: 1,
			stderr: "",
			yieldItems: [{ status: "success", data: { verdict: "looks good" } }],
			outputSchemaMode: "permissive",
			outputSchema: "",
			terminalContext: {
				terminalYieldAccepted: true,
				yieldInvalidatedByAsync: false,
				abortKind: "terminate",
			},
		});
		expect(result.exitCode).toBe(0);
	});

	it("still fails a strict schema violation despite a committed yield", () => {
		const result = finalize({
			yieldItems: [{ status: "success", data: { ok: "wrong" } }],
			terminalContext: {
				terminalYieldAccepted: true,
				yieldInvalidatedByAsync: false,
				abortKind: "terminate",
			},
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.structuredOutput?.status).not.toBe("valid");
	});

	it("normalizes a pre-yield nonzero exit with empty stderr once a yield is committed and no abort cause exists", () => {
		const result = finalize({
			exitCode: 1,
			stderr: "",
			terminalContext: {
				terminalYieldAccepted: true,
				yieldInvalidatedByAsync: false,
				abortKind: undefined,
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
		expect(result.structuredOutput?.data).toEqual({ ok: true });
	});

	it("allows only an expected soft-budget unstructured result", () => {
		const result = finalize({
			structured: false,
			yieldItems: undefined,
			rawOutput: "partial wrap-up",
			terminalContext: {
				terminalYieldAccepted: false,
				yieldInvalidatedByAsync: false,
				abortKind: "budget",
				budgetStopRequested: true,
				budgetLimitExceeded: false,
			},
		});
		expect(result.exitCode).toBe(0);
	});

	for (const abortKind of ["shutdown", "signal", "timeout", "terminate"] as const) {
		it(`fails unstructured output for unrelated ${abortKind} termination`, () => {
			const result = finalize({
				structured: false,
				yieldItems: undefined,
				rawOutput: "partial wrap-up",
				terminalContext: {
					terminalYieldAccepted: false,
					yieldInvalidatedByAsync: false,
					abortKind,
					budgetStopRequested: true,
					budgetLimitExceeded: false,
				},
			});
			expect(result.exitCode).not.toBe(0);
		});
	}

	it("does not exempt an async-invalidated unstructured result", () => {
		const result = finalize({
			structured: false,
			yieldItems: undefined,
			rawOutput: "stale wrap-up",
			terminalContext: {
				terminalYieldAccepted: false,
				yieldInvalidatedByAsync: true,
				abortKind: "budget",
				budgetStopRequested: true,
				budgetLimitExceeded: false,
			},
		});
		expect(result.exitCode).not.toBe(0);
	});

	it("does not exempt a nonzero unstructured execution", () => {
		const result = finalize({
			structured: false,
			yieldItems: undefined,
			rawOutput: "partial wrap-up",
			exitCode: 1,
			terminalContext: {
				terminalYieldAccepted: false,
				yieldInvalidatedByAsync: false,
				abortKind: "budget",
				budgetStopRequested: true,
				budgetLimitExceeded: false,
			},
		});
		expect(result.exitCode).not.toBe(0);
	});

	it("fails a hard budget stop for unstructured output", () => {
		const result = finalize({
			structured: false,
			yieldItems: undefined,
			rawOutput: "partial wrap-up",
			terminalContext: {
				terminalYieldAccepted: false,
				yieldInvalidatedByAsync: false,
				abortKind: "budget",
				budgetStopRequested: true,
				budgetLimitExceeded: true,
			},
		});
		expect(result.exitCode).not.toBe(0);
	});

	it("fails unstructured execution with empty output", () => {
		const result = finalize({
			structured: false,
			yieldItems: undefined,
			rawOutput: "",
			outputSchema: undefined,
		});
		expect(result.exitCode).not.toBe(0);
	});

	it("exercises unstructured no-schema execution with raw output", () => {
		const result = finalize({
			structured: false,
			yieldItems: undefined,
			rawOutput: "plain final answer",
			outputSchema: undefined,
		});
		expect(result.exitCode).toBe(0);
		expect(result.rawOutput).toBe("plain final answer");
	});
});

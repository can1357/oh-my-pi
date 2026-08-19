import { describe, expect, it } from "bun:test";
import {
	finalizeSubprocessOutput,
	SUBAGENT_WARNING_GATE_OVERRIDDEN,
	SUBAGENT_WARNING_MISSING_YIELD,
	SUBAGENT_WARNING_NULL_YIELD,
	SUBAGENT_WARNING_SCHEMA_OVERRIDDEN,
} from "@pk-nerdsaver-ai/pi-coding-agent/task/executor";

describe("subagent warning injection", () => {
	it("injects null-data warning when yield is success without data", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "partial output",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success" }],
			outputSchema: undefined,
		});

		expect(result.rawOutput).toBe(`${SUBAGENT_WARNING_NULL_YIELD}\n\npartial output`);
		expect(result.hasYield).toBe(true);
	});

	it("injects missing-submit warning when subagent exits cleanly without yield", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { properties: { ok: { type: "boolean" } } },
		});

		expect(result.rawOutput).toBe(SUBAGENT_WARNING_MISSING_YIELD);
		expect(result.hasYield).toBe(false);
	});

	it("does not inject missing-submit warning when fallback completion is recoverable", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: '{"data":{"ok":true}}',
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.rawOutput).toBe('{\n  "ok": true\n}');
		expect(result.rawOutput.includes("SYSTEM WARNING")).toBe(false);
	});

	it("prefixes missing-submit warning on stop outputs", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "agent stopped after writing analysis",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.rawOutput).toBe(`${SUBAGENT_WARNING_MISSING_YIELD}\n\nagent stopped after writing analysis`);
	});

	it("does not inject missing-submit warning when execution exits non-zero", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 1,
			stderr: "subagent terminated",
			doneAborted: true,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.rawOutput).toBe("");
		expect(result.stderr).toBe("subagent terminated");
		expect(result.exitCode).toBe(1);
	});

	it("normalizes explicit aborted yield into aborted payload", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "partial output",
			exitCode: 1,
			stderr: "old error",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "aborted", error: "blocked by permissions" }],
			outputSchema: undefined,
		});

		expect(result.abortedViaYield).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("blocked by permissions");
		expect(result.rawOutput).toContain('"aborted": true');
		expect(result.rawOutput).toContain('"blocked by permissions"');
	});

	it("accepts successful yield data without warning", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "should be replaced",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { ok: true } }],
			outputSchema: undefined,
		});

		expect(result.rawOutput).toBe('{\n  "ok": true\n}');
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.rawOutput.includes("SYSTEM WARNING")).toBe(false);
	});

	it("does not inject missing-submit warning when no schema and raw text exists", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "plain text notes",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: undefined,
		});

		expect(result.rawOutput).toBe("plain text notes");
		expect(result.rawOutput.includes("SYSTEM WARNING")).toBe(false);
		expect(result.exitCode).toBe(0);
	});

	it("honors schemaOverridden flag from yield and surfaces data with warning", () => {
		// Reviewer subagent exhausted its in-tool schema-retry budget, then was
		// accepted with empty finding objects. Without honoring the override, the
		// executor's post-mortem validator silently rejected the same payload with
		// `schema_violation`, opaquely swapping the agent's accepted output for an
		// error blob. Reports #2, #8, #11, #16, #17, #20.
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { findings: [{}, {}] }, schemaOverridden: true }],
			outputSchema: {
				type: "object",
				required: ["findings"],
				properties: {
					findings: {
						type: "array",
						minItems: 1,
						items: {
							type: "object",
							required: ["severity", "file", "line"],
							properties: {
								severity: { type: "string" },
								file: { type: "string" },
								line: { type: "number" },
							},
						},
					},
				},
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe(SUBAGENT_WARNING_SCHEMA_OVERRIDDEN);
		expect(JSON.parse(result.rawOutput)).toEqual({ findings: [{}, {}] });
	});

	it("treats malformed output schemas as no validation instead of schema_violation", () => {
		// Empty-string schema is a caller mistake; the yield tool already degrades
		// to a loose schema and accepts the data. The executor's finalizer used to
		// emit `schema_violation: invalid output schema` even though yield accepted
		// it, which surprised users dispatching prose review batches. Report #60.
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { verdict: "looks good" } }],
			outputSchema: "",
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.rawOutput)).toEqual({ verdict: "looks good" });
		expect(result.stderr.startsWith("invalid output schema:")).toBe(true);
	});

	it("surfaces gateOverridden flag from yield as a stderr warning to the parent", () => {
		// The gate cap accepts the payload after MAX_GATE_REMINDERS; without a
		// parent-visible warning the escalation would be invisible outside nested
		// result metadata.
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { summary: "done without evidence" }, gateOverridden: true }],
			outputSchema: undefined,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe(SUBAGENT_WARNING_GATE_OVERRIDDEN);
		expect(JSON.parse(result.rawOutput)).toEqual({ summary: "done without evidence" });
	});

	it("combines schema and gate override warnings when both flags are set", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { ok: true }, schemaOverridden: true, gateOverridden: true }],
			outputSchema: {
				type: "object",
				required: ["findings"],
				properties: { findings: { type: "array" } },
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe(`${SUBAGENT_WARNING_SCHEMA_OVERRIDDEN}\n${SUBAGENT_WARNING_GATE_OVERRIDDEN}`);
		expect(JSON.parse(result.rawOutput)).toEqual({ ok: true });
	});
});

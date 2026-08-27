import { describe, expect, it } from "bun:test";
import type {
	InterruptedPresentationRecord,
	StartedPresentationRecord,
	ToolCallPresentation,
	ToolCallRecord,
	ToolFact,
	ToolOutcome,
	ToolPresentationRecord,
} from "@oh-my-pi/pi-agent-core/presentation";
import type { IsExact } from "../src/presentation/exact";
import {
	type FrozenModelProjection,
	type PersistedToolJournal,
	type ReplayableToolExecution,
	toolCallRecordOf,
} from "../src/presentation/journal";
import {
	frozenModelProjectionSchema,
	interruptedPresentationRecordSchema,
	type PresentationFrozenModelProjection,
	type PresentationInterruptedPresentationRecord,
	type PresentationPersistedToolJournal,
	type PresentationReplayableToolExecution,
	type PresentationStartedPresentationRecord,
	type PresentationToolCallRecord,
	type PresentationToolFact,
	type PresentationToolOutcome,
	type PresentationToolPresentationRecord,
	persistedToolJournalSchema,
	replayableToolExecutionSchema,
	startedPresentationRecordSchema,
	toolCallRecordSchema,
	toolFactSchema,
	toolOutcomeSchema,
	toolPresentationRecordSchema,
} from "../src/presentation/schemas/journal";

/**
 * The v4 persisted tool journal types and their
 * zod schemas. Pure type/schema definitions — no producer writes a
 * `PersistedToolJournal` record yet and no consumer reads a
 * `ReplayableToolExecution`; see `../src/presentation/journal.ts`'s doc
 * comment. These tests exist because the module has no producer or consumer
 * yet, so nothing else in the codebase exercises these types or schemas —
 * every assertion here is the only coverage they have.
 */

describe("v4 journal schema type parity", () => {
	it("keeps ToolCallRecord and its schema the same type", () => {
		const parity: IsExact<ToolCallRecord, PresentationToolCallRecord> = true;
		expect(parity).toBe(true);
	});

	it("keeps ToolFact and its schema the same type", () => {
		const parity: IsExact<ToolFact, PresentationToolFact> = true;
		expect(parity).toBe(true);
	});

	it("keeps StartedPresentationRecord and its schema the same type", () => {
		const parity: IsExact<StartedPresentationRecord, PresentationStartedPresentationRecord> = true;
		expect(parity).toBe(true);
	});

	it("keeps ToolPresentationRecord and its schema the same type", () => {
		const parity: IsExact<ToolPresentationRecord, PresentationToolPresentationRecord> = true;
		expect(parity).toBe(true);
	});

	it("keeps InterruptedPresentationRecord and its schema the same type", () => {
		const parity: IsExact<InterruptedPresentationRecord, PresentationInterruptedPresentationRecord> = true;
		expect(parity).toBe(true);
	});

	it("keeps ToolOutcome and its schema the same type", () => {
		const parity: IsExact<ToolOutcome, PresentationToolOutcome> = true;
		expect(parity).toBe(true);
	});

	it("keeps FrozenModelProjection and its schema the same type", () => {
		const parity: IsExact<FrozenModelProjection, PresentationFrozenModelProjection> = true;
		expect(parity).toBe(true);
	});

	it("keeps PersistedToolJournal and its schema the same type", () => {
		const parity: IsExact<PersistedToolJournal, PresentationPersistedToolJournal> = true;
		expect(parity).toBe(true);
	});

	it("keeps ReplayableToolExecution and its schema the same type", () => {
		const parity: IsExact<ReplayableToolExecution, PresentationReplayableToolExecution> = true;
		expect(parity).toBe(true);
	});
});

const minimalCall = {
	toolCallId: "call-0000000001",
	toolName: "bash",
	title: "Run echo",
	kind: "execute" as const,
};

const minimalStartedPresentation = { version: 1 as const, facts: [] };
const minimalToolPresentation = { version: 1 as const, facts: [], attachments: [] };
const minimalInterruptedPresentation = { version: 1 as const, facts: [] };
const minimalSucceededOutcome = { kind: "succeeded" as const };
const minimalModelProjection = { version: 1 as const, content: [] };

describe("toolCallRecordSchema", () => {
	it("round-trips a minimal valid call record", () => {
		const parsed = toolCallRecordSchema.parse(minimalCall);
		expect(parsed).toEqual(minimalCall);
	});

	it("rejects an unmodelled extra key (strict, matching schemas/facts.ts's built-in disposition)", () => {
		expect(toolCallRecordSchema.safeParse({ ...minimalCall, extraDriftField: "nope" }).success).toBe(false);
	});
});

describe("toolFactSchema / toolOutcomeSchema / presentation record schemas", () => {
	it("round-trips one fact per kind", () => {
		const factId = "fact-0000000001";
		const facts = [
			{ id: factId, kind: "wall_time", ms: 12 },
			{
				id: factId,
				kind: "truncation",
				meta: { direction: "tail", totalBytes: 100, retainedBytes: 10 },
			},
			{ id: factId, kind: "limit", meta: { limit: "column", value: 512 } },
			{
				id: factId,
				kind: "diagnostics",
				entries: [{ path: "/tmp/a.ts", severity: "error", message: "boom" }],
			},
			{ id: factId, kind: "artifact", artifactId: "artifact-1" },
			{ id: factId, kind: "model_guidance", source: "ttsr", text: "guidance" },
			{ id: factId, kind: "stop_annotation", text: "stopped" },
			{ id: factId, kind: "capability_notice", text: "no pty" },
			{ id: factId, kind: "unreported_annotation", text: "hidden" },
			{ id: factId, kind: "notice", text: "fyi" },
		];
		for (const fact of facts) {
			expect(toolFactSchema.safeParse(fact).success).toBe(true);
		}
	});

	it("round-trips each ToolOutcome kind", () => {
		expect(toolOutcomeSchema.safeParse({ kind: "succeeded" }).success).toBe(true);
		expect(
			toolOutcomeSchema.safeParse({
				kind: "failed",
				failure: { reason: "process", message: "exit 1" },
				process: { kind: "exited", code: 1 },
			}).success,
		).toBe(true);
		expect(toolOutcomeSchema.safeParse({ kind: "interrupted", reason: "user abort" }).success).toBe(true);
	});

	it("rejects a nonzero-exit-code outcome carrying the literal 0", () => {
		expect(
			toolOutcomeSchema.safeParse({
				kind: "failed",
				failure: { reason: "process", message: "exit 0 but failed?" },
				process: { kind: "exited", code: 0 },
			}).success,
		).toBe(false);
	});

	it("round-trips started/settled/interrupted presentation records", () => {
		expect(startedPresentationRecordSchema.safeParse(minimalStartedPresentation).success).toBe(true);
		expect(toolPresentationRecordSchema.safeParse(minimalToolPresentation).success).toBe(true);
		expect(interruptedPresentationRecordSchema.safeParse(minimalInterruptedPresentation).success).toBe(true);
	});
});

describe("frozenModelProjectionSchema", () => {
	it("round-trips a minimal projection", () => {
		expect(frozenModelProjectionSchema.safeParse(minimalModelProjection).success).toBe(true);
	});

	it("rejects a version other than the current literal", () => {
		expect(frozenModelProjectionSchema.safeParse({ version: 2, content: [] }).success).toBe(false);
		expect(frozenModelProjectionSchema.safeParse({ content: [] }).success).toBe(false);
	});
});

describe("persistedToolJournalSchema", () => {
	const executionId = "exec-0000000001";

	it("constructs the tool_execution_started variant from a minimal valid literal", () => {
		const record = {
			type: "tool_execution_started",
			recordVersion: 1,
			executionId,
			call: minimalCall,
			presentation: minimalStartedPresentation,
		};
		const parsed = persistedToolJournalSchema.safeParse(record);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.type).toBe("tool_execution_started");
	});

	it("constructs the tool_execution_settled variant from a minimal valid literal", () => {
		const record = {
			type: "tool_execution_settled",
			recordVersion: 1,
			executionId,
			outcome: minimalSucceededOutcome,
			presentation: minimalToolPresentation,
			modelProjection: minimalModelProjection,
		};
		const parsed = persistedToolJournalSchema.safeParse(record);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.type).toBe("tool_execution_settled");
	});

	it("rejects a record with recordVersion omitted", () => {
		const record = {
			type: "tool_execution_started",
			executionId,
			call: minimalCall,
			presentation: minimalStartedPresentation,
		};
		expect(persistedToolJournalSchema.safeParse(record).success).toBe(false);
	});

	it("rejects a record carrying an unrecognized future recordVersion", () => {
		const record = {
			type: "tool_execution_started",
			recordVersion: 2,
			executionId,
			call: minimalCall,
			presentation: minimalStartedPresentation,
		};
		expect(persistedToolJournalSchema.safeParse(record).success).toBe(false);
	});

	it("rejects a record carrying recordVersion 0", () => {
		const record = {
			type: "tool_execution_started",
			recordVersion: 0,
			executionId,
			call: minimalCall,
			presentation: minimalStartedPresentation,
		};
		expect(persistedToolJournalSchema.safeParse(record).success).toBe(false);
	});

	it("rejects an unrecognized type discriminator", () => {
		const record = {
			type: "tool_execution_cancelled",
			recordVersion: 1,
			executionId,
			call: minimalCall,
			presentation: minimalStartedPresentation,
		};
		expect(persistedToolJournalSchema.safeParse(record).success).toBe(false);
	});
});

describe("replayableToolExecutionSchema", () => {
	it("constructs the settled variant from a minimal valid literal", () => {
		const record = {
			state: "settled",
			call: minimalCall,
			outcome: minimalSucceededOutcome,
			presentation: minimalToolPresentation,
			modelProjection: minimalModelProjection,
		};
		const parsed = replayableToolExecutionSchema.safeParse(record);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.state).toBe("settled");
	});

	it("constructs the interrupted variant from a minimal valid literal", () => {
		const record = {
			state: "interrupted",
			call: minimalCall,
			reason: "process died before settlement",
			presentation: minimalInterruptedPresentation,
		};
		const parsed = replayableToolExecutionSchema.safeParse(record);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.state).toBe("interrupted");
	});

	it("rejects an unrecognized state discriminator", () => {
		const record = { state: "pending", call: minimalCall, reason: "not real", presentation: minimalToolPresentation };
		expect(replayableToolExecutionSchema.safeParse(record).success).toBe(false);
	});
});

/**
 * `toolCallRecordOf` must be total over
 * its documented untyped `rawInput` boundary — never throw, even for a
 * pathological value `jsonRecordSchema.safeParse` cannot safely reject
 * (cyclic references, throwing accessors). A throw here would escape
 * `AgentSession#recordToolExecutionStartedJournal` into the agent's fire-
 * and-forget listener dispatch, which only logs a rejected async listener —
 * silently losing the journal write and every later announcement for that
 * call, while the tool itself keeps running.
 */
describe("toolCallRecordOf", () => {
	const baseCall: ToolCallPresentation = {
		toolCallId: "call-fixture-0001",
		toolName: "bash",
		title: "Run printf",
		kind: "execute",
	};

	it("carries every typed field through unchanged", () => {
		const call: ToolCallPresentation = {
			...baseCall,
			cwd: "/tmp/fixture-cwd",
			sourceEcho: "echo fixture",
			locations: [{ path: "/tmp/fixture-cwd/file.txt", line: 3 }],
			rawInput: { command: "printf fixture" },
		};
		const record = toolCallRecordOf(call);
		expect(record.toolCallId).toBe(call.toolCallId);
		expect(record.toolName).toBe(call.toolName);
		expect(record.title).toBe(call.title);
		expect(record.kind).toBe(call.kind);
		expect(record.cwd).toBe(call.cwd);
		expect(record.sourceEcho).toBe(call.sourceEcho);
		expect(record.locations).toEqual(call.locations);
		expect(record.rawInput).toEqual({ command: "printf fixture" });
	});

	it("drops awaitsLiveTerminal by design (persisted-safe counterpart, no live-terminal concept)", () => {
		const call: ToolCallPresentation = { ...baseCall, awaitsLiveTerminal: true };
		const record = toolCallRecordOf(call);
		expect(record).not.toHaveProperty("awaitsLiveTerminal");
	});

	it("drops rawInput without throwing when it is a cyclic object", () => {
		const cyclic: Record<string, unknown> = { command: "printf cyclic" };
		cyclic.self = cyclic;
		const call: ToolCallPresentation = { ...baseCall, rawInput: cyclic };

		let record: ToolCallRecord | undefined;
		expect(() => {
			record = toolCallRecordOf(call);
		}).not.toThrow();
		expect(record?.rawInput).toBeUndefined();
		// The typed fields survive intact even though rawInput was unusable.
		expect(record?.toolCallId).toBe(call.toolCallId);
		expect(record?.toolName).toBe(call.toolName);
	});

	it("drops rawInput without throwing when a nested property accessor throws", () => {
		const hostile: Record<string, unknown> = { command: "printf hostile" };
		Object.defineProperty(hostile, "poison", {
			enumerable: true,
			get(): never {
				throw new Error("hostile accessor");
			},
		});
		const call: ToolCallPresentation = { ...baseCall, rawInput: hostile };

		let record: ToolCallRecord | undefined;
		expect(() => {
			record = toolCallRecordOf(call);
		}).not.toThrow();
		expect(record?.rawInput).toBeUndefined();
		expect(record?.toolCallId).toBe(call.toolCallId);
	});

	it("keeps a genuinely JSON-safe rawInput even alongside a deeply nested structure", () => {
		const nested = { a: { b: { c: [1, 2, { d: "leaf" }] } } };
		const call: ToolCallPresentation = { ...baseCall, rawInput: nested };
		const record = toolCallRecordOf(call);
		expect(record.rawInput).toEqual(nested);
	});
});

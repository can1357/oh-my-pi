/**
 * `correlateReplayableToolExecution` in isolation. Production code wires it
 * into `AcpAgent#replaySessionHistory` (`acp-agent.ts`), which now calls
 * `nextReplayableToolExecution` (this module's chronological-walk wrapper
 * around `correlateReplayableToolExecution`) and feeds a hit through
 * `#replayHydratedToolExecution`, replacing the old ad hoc lifecycle
 * reconstruction for any call with v4 journal coverage.
 */
import { describe, expect, it } from "bun:test";
import { factId, toolExecutionId } from "@oh-my-pi/pi-agent-core/presentation";
import { hydrateReplayableToolExecution } from "../src/presentation/hydrate";
import { SessionManager } from "../src/session/session-manager";
import {
	correlateReplayableToolExecution,
	createReplayToolJournalCursor,
	DANGLING_TOOL_EXECUTION_REASON,
	nextReplayableToolExecution,
} from "../src/session/tool-journal-correlation";

function makeManager(): SessionManager {
	return SessionManager.inMemory("/repo");
}

describe("correlateReplayableToolExecution", () => {
	it("folds a started+settled pair into the settled ReplayableToolExecution with every field intact", () => {
		const manager = makeManager();
		manager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CORR0001-STARTED"),
			call: { toolCallId: "call-CORR0001", toolName: "bash", title: "run fixture A", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		manager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CORR0001-STARTED"),
			outcome: { kind: "succeeded" },
			presentation: {
				version: 1,
				facts: [{ id: factId("fact-CORR0001-A"), kind: "wall_time", ms: 7 }],
				attachments: [],
			},
			modelProjection: { version: 1, content: [{ type: "text", text: "CORR0001-OUTPUT" }] },
		});

		const result = correlateReplayableToolExecution(manager.getBranch(), "call-CORR0001");

		expect(result).toEqual({
			state: "settled",
			call: { toolCallId: "call-CORR0001", toolName: "bash", title: "run fixture A", kind: "execute" },
			outcome: { kind: "succeeded" },
			presentation: {
				version: 1,
				facts: [{ id: factId("fact-CORR0001-A"), kind: "wall_time", ms: 7 }],
				attachments: [],
			},
			modelProjection: { version: 1, content: [{ type: "text", text: "CORR0001-OUTPUT" }] },
		});
	});

	it("folds a dangling started-only record into the interrupted state", () => {
		const manager = makeManager();
		manager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CORR0002-STARTED"),
			call: { toolCallId: "call-CORR0002", toolName: "eval", title: "run fixture B", kind: "execute" },
			presentation: { version: 1, facts: [{ id: factId("fact-CORR0002-A"), kind: "wall_time", ms: 3 }] },
		});

		const result = correlateReplayableToolExecution(manager.getBranch(), "call-CORR0002");

		expect(result).toEqual({
			state: "interrupted",
			call: { toolCallId: "call-CORR0002", toolName: "eval", title: "run fixture B", kind: "execute" },
			reason: DANGLING_TOOL_EXECUTION_REASON,
			presentation: { version: 1, facts: [{ id: factId("fact-CORR0002-A"), kind: "wall_time", ms: 3 }] },
		});
	});

	it("returns undefined when no started record exists for the id — the universal pre-v4/legacy_snapshot case", () => {
		const manager = makeManager();
		// A branch with unrelated entries and a *different* call's journal pair,
		// but nothing at all for "call-CORR0003" — this is what every historical
		// session and every legacy_snapshot call looks like.
		manager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CORR0004-STARTED"),
			call: { toolCallId: "call-CORR0004", toolName: "read", title: "unrelated call", kind: "read" },
			presentation: { version: 1, facts: [] },
		});
		manager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CORR0004-STARTED"),
			outcome: { kind: "succeeded" },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [] },
		});

		expect(correlateReplayableToolExecution(manager.getBranch(), "call-CORR0003")).toBeUndefined();
		expect(correlateReplayableToolExecution([], "call-CORR0003")).toBeUndefined();
	});

	it("scopes to the passed branch: an abandoned branch's execution of a recycled toolCallId never answers for the active one", () => {
		const manager = makeManager();
		const rootId = manager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CORR0005-ROOT"),
			call: { toolCallId: "call-CORR0005-ROOT", toolName: "bash", title: "root anchor", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});

		// Branch A: call-CORR0005 fails and is left dangling (process died mid-call).
		manager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CORR0005-BRANCH-A"),
			call: { toolCallId: "call-CORR0005", toolName: "bash", title: "branch A attempt", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		const branchAEntries = manager.getBranch();

		// Rewind to the root and start branch B, which the provider (or a retry
		// path) recycles the exact same toolCallId for — a different, settled
		// execution.
		manager.branch(rootId);
		manager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CORR0005-BRANCH-B"),
			call: { toolCallId: "call-CORR0005", toolName: "bash", title: "branch B retry", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		manager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CORR0005-BRANCH-B"),
			outcome: { kind: "succeeded" },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [{ type: "text", text: "CORR0005-BRANCH-B-OUTPUT" }] },
		});
		const branchBEntries = manager.getBranch();

		// `getEntries()` is the flat, cross-branch array: proves the abandoned
		// branch A record is still physically present, not deleted by branch().
		const flat = manager.getEntries();
		expect(
			flat.filter(e => e.type === "tool_execution_started" && e.call.toolCallId === "call-CORR0005"),
		).toHaveLength(2);

		// Correlating branch A's own lineage sees only its own dangling execution.
		expect(correlateReplayableToolExecution(branchAEntries, "call-CORR0005")).toEqual({
			state: "interrupted",
			call: { toolCallId: "call-CORR0005", toolName: "bash", title: "branch A attempt", kind: "execute" },
			reason: DANGLING_TOOL_EXECUTION_REASON,
			presentation: { version: 1, facts: [] },
		});

		// Correlating branch B's lineage (the active one after the rewind) sees
		// only its own settled execution — branch A's dangling record for the
		// same toolCallId never leaks in, because it is not on this path.
		expect(correlateReplayableToolExecution(branchBEntries, "call-CORR0005")).toEqual({
			state: "settled",
			call: { toolCallId: "call-CORR0005", toolName: "bash", title: "branch B retry", kind: "execute" },
			outcome: { kind: "succeeded" },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [{ type: "text", text: "CORR0005-BRANCH-B-OUTPUT" }] },
		});
	});

	it("resolves each occurrence of a toolCallId recycled twice on the *same* branch to its own execution via upToIndex", () => {
		const manager = makeManager();
		manager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CORR0006-FIRST"),
			call: { toolCallId: "call-CORR0006", toolName: "bash", title: "first run", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		manager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CORR0006-FIRST"),
			outcome: { kind: "failed", failure: { reason: "internal", message: "first run failed" } },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [{ type: "text", text: "CORR0006-FIRST-OUTPUT" }] },
		});
		// The index of the last entry belonging to the *first* occurrence, before
		// the second occurrence's `started` record is appended — exactly the
		// position bound a chronological walker would have reached at the moment
		// it encounters the first occurrence's toolCall in the transcript.
		const afterFirstOccurrenceIndex = manager.getBranch().length - 1;

		manager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CORR0006-SECOND"),
			call: { toolCallId: "call-CORR0006", toolName: "bash", title: "second run", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		manager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CORR0006-SECOND"),
			outcome: { kind: "succeeded" },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [{ type: "text", text: "CORR0006-SECOND-OUTPUT" }] },
		});

		const branch = manager.getBranch();

		// Bounding the search to the first occurrence's own position resolves it
		// to its own execution — not the later, unrelated second one.
		expect(correlateReplayableToolExecution(branch, "call-CORR0006", afterFirstOccurrenceIndex)).toEqual({
			state: "settled",
			call: { toolCallId: "call-CORR0006", toolName: "bash", title: "first run", kind: "execute" },
			outcome: { kind: "failed", failure: { reason: "internal", message: "first run failed" } },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [{ type: "text", text: "CORR0006-FIRST-OUTPUT" }] },
		});

		// Querying with no bound (or a bound past the second occurrence) resolves
		// to the most recent execution on the branch.
		expect(correlateReplayableToolExecution(branch, "call-CORR0006")).toEqual({
			state: "settled",
			call: { toolCallId: "call-CORR0006", toolName: "bash", title: "second run", kind: "execute" },
			outcome: { kind: "succeeded" },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [{ type: "text", text: "CORR0006-SECOND-OUTPUT" }] },
		});
	});

	it("feeds directly into hydrateReplayableToolExecution's input contract", () => {
		const manager = makeManager();
		manager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CORR0007-STARTED"),
			call: { toolCallId: "call-CORR0007", toolName: "bash", title: "run command", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		manager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CORR0007-STARTED"),
			outcome: { kind: "succeeded" },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [] },
		});

		const execution = correlateReplayableToolExecution(manager.getBranch(), "call-CORR0007");
		if (execution === undefined) throw new Error("expected a correlated execution");

		const events = hydrateReplayableToolExecution(execution);
		expect(events[0]).toEqual({
			type: "started",
			call: { toolCallId: "call-CORR0007", toolName: "bash", title: "run command", kind: "execute" },
		});
		expect(events.at(-1)).toEqual({ type: "settled", outcome: { kind: "succeeded" } });
	});
});

describe("nextReplayableToolExecution's totality gate", () => {
	it("hydrates every occurrence of a recycled toolCallId when the branch holds one started record per transcript occurrence", () => {
		const manager = makeManager();
		manager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CURSOR0001-FIRST"),
			call: { toolCallId: "call-CURSOR0001", toolName: "bash", title: "first run", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		manager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CURSOR0001-FIRST"),
			outcome: { kind: "succeeded" },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [{ type: "text", text: "CURSOR0001-FIRST-OUTPUT" }] },
		});
		manager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CURSOR0001-SECOND"),
			call: { toolCallId: "call-CURSOR0001", toolName: "bash", title: "second run", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		manager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CURSOR0001-SECOND"),
			outcome: { kind: "succeeded" },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [{ type: "text", text: "CURSOR0001-SECOND-OUTPUT" }] },
		});

		// The branch has exactly 2 started records for this id, and the
		// transcript is declared to hold exactly 2 occurrences of it: a total
		// pairing, so every occurrence resolves to its own execution in order.
		const cursor = createReplayToolJournalCursor(manager.getBranch(), new Map([["call-CURSOR0001", 2]]));
		expect(nextReplayableToolExecution(cursor, "call-CURSOR0001")).toEqual({
			state: "settled",
			call: { toolCallId: "call-CURSOR0001", toolName: "bash", title: "first run", kind: "execute" },
			outcome: { kind: "succeeded" },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [{ type: "text", text: "CURSOR0001-FIRST-OUTPUT" }] },
		});
		expect(nextReplayableToolExecution(cursor, "call-CURSOR0001")).toEqual({
			state: "settled",
			call: { toolCallId: "call-CURSOR0001", toolName: "bash", title: "second run", kind: "execute" },
			outcome: { kind: "succeeded" },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [{ type: "text", text: "CURSOR0001-SECOND-OUTPUT" }] },
		});
	});

	it("disqualifies every occurrence of a recycled toolCallId when the branch holds fewer started records than the transcript has occurrences", () => {
		const manager = makeManager();
		// Only the *second* occurrence was journaled -- a session straddling the
		// v4 producer, or one occurrence on legacy_snapshot. Nothing persisted
		// says which occurrence this record belongs to.
		manager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CURSOR0002-ONLY"),
			call: { toolCallId: "call-CURSOR0002", toolName: "bash", title: "only journaled run", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		manager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CURSOR0002-ONLY"),
			outcome: { kind: "succeeded" },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [{ type: "text", text: "CURSOR0002-ONLY-OUTPUT" }] },
		});

		// The transcript declares 2 occurrences, but the branch only has 1
		// started record: a short pairing. Every occurrence must return
		// undefined -- never assign the lone record to either encounter.
		const cursor = createReplayToolJournalCursor(manager.getBranch(), new Map([["call-CURSOR0002", 2]]));
		expect(nextReplayableToolExecution(cursor, "call-CURSOR0002")).toBeUndefined();
		expect(nextReplayableToolExecution(cursor, "call-CURSOR0002")).toBeUndefined();
	});

	it("disqualifies an id when the branch holds more started records than the transcript has occurrences", () => {
		const manager = makeManager();
		manager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CURSOR0003-ONLY"),
			call: { toolCallId: "call-CURSOR0003", toolName: "bash", title: "overcounted run", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		manager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId: toolExecutionId("exec-CURSOR0003-ONLY"),
			outcome: { kind: "succeeded" },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [{ type: "text", text: "CURSOR0003-OUTPUT" }] },
		});

		// 1 started record, but the transcript declares 0 occurrences of it --
		// disqualified, not silently ignored as "no occurrences to resolve".
		const cursor = createReplayToolJournalCursor(manager.getBranch(), new Map());
		expect(nextReplayableToolExecution(cursor, "call-CURSOR0003")).toBeUndefined();
	});
});

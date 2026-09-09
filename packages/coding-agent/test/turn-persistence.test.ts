/**
 * Contracts for {@link sessionMessagePersistenceKey} and
 * {@link planTurnPersistence} — the pure helpers that decide which messages
 * still need persisting at a mid-run compaction boundary.
 *
 * These two functions replace `AgentSession`'s old O(n²) branch rebuild +
 * content `JSON.stringify` compare per pair (issue #3629). The behavioral
 * contract here is:
 *
 *  1. Keys are logical identity, not structural. Two messages with the same
 *     persistence key are treated as the same logical message; content
 *     differences are display variants, not new turns.
 *  2. The planner runs in one pass over the snapshot-set + turn keys, never
 *     re-scans the branch, and reports the FIRST out-of-order violation
 *     (the earliest turn message whose later sibling is already persisted).
 */
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { planTurnPersistence, sessionMessagePersistenceKey } from "@oh-my-pi/pi-coding-agent/session/turn-persistence";

function assistant(overrides: Partial<Extract<AgentMessage, { role: "assistant" }>> = {}) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "hi" }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 1_700_000_000_000,
		...overrides,
	};
}

function toolResult(overrides: Partial<Extract<AgentMessage, { role: "toolResult" }>> = {}) {
	return {
		role: "toolResult" as const,
		toolCallId: "tc-1",
		toolName: "bash",
		content: [{ type: "text" as const, text: "output" }],
		isError: false,
		timestamp: 1_700_000_000_000,
		...overrides,
	};
}

describe("sessionMessagePersistenceKey", () => {
	test("assistant identity covers timestamp/provider/model/responseId/stopReason — different content keeps the same key", () => {
		// Two assistant variants emitted for the same logical turn (one streamed,
		// one finalized; or one obfuscated, one deobfuscated for display) must
		// share a key so we never double-persist them on the branch.
		const a = assistant({ content: [{ type: "text", text: "foo" }], responseId: "resp-1" });
		const b = assistant({ content: [{ type: "text", text: "foo (deobfuscated)" }], responseId: "resp-1" });
		expect(sessionMessagePersistenceKey(a)).toBeDefined();
		expect(sessionMessagePersistenceKey(a)).toBe(sessionMessagePersistenceKey(b));
	});

	test("assistant identity changes with responseId / stopReason", () => {
		const base = assistant({ responseId: "resp-1" });
		expect(sessionMessagePersistenceKey({ ...base, responseId: "resp-2" })).not.toBe(
			sessionMessagePersistenceKey(base),
		);
		expect(sessionMessagePersistenceKey({ ...base, stopReason: "toolUse" })).not.toBe(
			sessionMessagePersistenceKey(base),
		);
	});

	test("toolResult identity covers toolCallId + toolName at the timestamp — content does not affect identity", () => {
		const a = toolResult({
			content: [{ type: "text", text: "first" }],
			toolCallId: "tc-99",
			toolName: "bash",
		});
		const b = toolResult({
			content: [{ type: "text", text: "second" }],
			toolCallId: "tc-99",
			toolName: "bash",
		});
		expect(sessionMessagePersistenceKey(a)).toBe(sessionMessagePersistenceKey(b));
		expect(sessionMessagePersistenceKey({ ...a, toolCallId: "tc-100" })).not.toBe(sessionMessagePersistenceKey(a));
		expect(sessionMessagePersistenceKey({ ...a, toolName: "edit" })).not.toBe(sessionMessagePersistenceKey(a));
	});

	test("user/developer identity discriminates on attribution, so a hook-injected user and a typed user at the same instant get distinct keys", () => {
		// Old code keyed `${role}:${timestamp}` and collided two user messages
		// posted in the same millisecond from different sources (typed vs hook),
		// silently dropping one on the slot map. The persistence key now folds in
		// attribution so the two slots stay independent.
		const typed: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "hi" }],
			attribution: "user",
			timestamp: 1_700_000_000_000,
		};
		const hook: AgentMessage = { ...typed, attribution: "agent" };
		expect(sessionMessagePersistenceKey(typed)).not.toBe(sessionMessagePersistenceKey(hook));
		// And two genuine duplicates with the same attribution at the same ms
		// still dedupe.
		expect(sessionMessagePersistenceKey({ ...typed })).toBe(sessionMessagePersistenceKey(typed));
	});

	test("returns undefined for non-persistent roles, signaling 'skip the persistence slot path'", () => {
		// The persistence path (slot chain, pending Map, persistTurnMessages...) is
		// gated on a defined key — non-persistent message kinds (custom, hook,
		// bashExecution, etc.) take other branches in SessionManager. The helper
		// must return `undefined` rather than fabricating a key for those.
		const customLike = { role: "hookMessage", timestamp: 1 } as unknown as AgentMessage;
		expect(sessionMessagePersistenceKey(customLike)).toBeUndefined();
	});
});

describe("planTurnPersistence", () => {
	test("persists every turn message when nothing is on the branch yet", () => {
		const turnKeys = ["a", "b", "c"];
		const plan = planTurnPersistence(turnKeys, new Set());
		expect(plan).toEqual({ kind: "ok", toPersist: [0, 1, 2] });
	});

	test("skips messages already on the branch and persists the rest in order", () => {
		// Assistant already persisted; only its two tool results need appending.
		const turnKeys = ["assistant", "tr-1", "tr-2"];
		const plan = planTurnPersistence(turnKeys, new Set(["assistant"]));
		expect(plan).toEqual({ kind: "ok", toPersist: [1, 2] });
	});

	test("bails 'out-of-order' on the FIRST gap so we don't splice a stale message between newer entries", () => {
		// The assistant (index 0) is missing but tool-result #1 is on the branch.
		// Inserting the assistant now would land it AFTER its own tool result —
		// the planner refuses and reports the first violating index.
		const plan = planTurnPersistence(["assistant", "tr-1", "tr-2"], new Set(["tr-1"]));
		expect(plan).toEqual({ kind: "out-of-order", messageIndex: 0 });
	});

	test("a later out-of-order message reports its OWN index, not the earliest unpersisted slot", () => {
		// Both `assistant` and `tr-1` are already on the branch (the agent loop
		// finished persisting most of the turn). `tr-2` is missing but `tr-3` is
		// already there. The planner skips persisted entries and surfaces `tr-2`
		// (index 2) as the violation — the caller logs that role/timestamp so a
		// reader can identify which message went missing mid-flight.
		const plan = planTurnPersistence(["assistant", "tr-1", "tr-2", "tr-3"], new Set(["assistant", "tr-1", "tr-3"]));
		expect(plan).toEqual({ kind: "out-of-order", messageIndex: 2 });
	});

	test("undefined keys (non-persistent slots) are skipped silently and never block ordering", () => {
		// A non-persistent message in the middle of the turn must not be treated
		// as either 'missing' or 'later persisted' — its `undefined` key has no
		// branch presence and no identity to violate. The planner persists the
		// addressable neighbors as if it weren't there.
		const plan = planTurnPersistence(["a", undefined, "c"], new Set(["a"]));
		expect(plan).toEqual({ kind: "ok", toPersist: [2] });
	});

	test("never asks the caller to re-persist a message already on the branch", () => {
		// Whole turn was already persisted (e.g. message_end hooks ran the slot
		// to completion before onTurnEnd reached us). We have nothing to do.
		const plan = planTurnPersistence(["a", "b"], new Set(["a", "b"]));
		expect(plan).toEqual({ kind: "ok", toPersist: [] });
	});
});

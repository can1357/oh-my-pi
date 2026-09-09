import { describe, expect, it } from "bun:test";
import { type AgentToolCall, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { SessionMessageEntry } from "@oh-my-pi/pi-agent-core/compaction/entries";
import { DEFAULT_PRUNE_CONFIG, pruneToolOutputs } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import { AGGRESSIVE_SHAKE_CONFIG, collectShakeRegions } from "@oh-my-pi/pi-agent-core/compaction/shake";
import type { ProtectedToolContext } from "@oh-my-pi/pi-agent-core/compaction/tool-protection";
import type { AssistantMessage, TextContent, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { createPlanReadMatcher } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-protection";

const tokenizer = new Tokenizer();

function context(opts: { toolName?: string; callName?: string | undefined; path?: string }): ProtectedToolContext {
	const toolResult = {
		role: "toolResult",
		toolCallId: "c1",
		toolName: opts.toolName ?? "read",
		content: [],
		isError: false,
		timestamp: 0,
	} as ToolResultMessage;
	const callName = "callName" in opts ? opts.callName : "read";
	const toolCall =
		callName === undefined
			? undefined
			: ({
					type: "toolCall",
					id: "c1",
					name: callName,
					arguments: opts.path === undefined ? {} : { path: opts.path },
				} as unknown as AgentToolCall);
	return { toolResult, toolCall };
}

describe("createPlanReadMatcher", () => {
	it("protects reads of the canonical local://PLAN.md alias", () => {
		const matcher = createPlanReadMatcher(() => "local://PLAN.md");
		expect(matcher(context({ path: "local://PLAN.md" }))).toBe(true);
	});

	it("protects reads of a titled plan path from the reference getter", () => {
		const matcher = createPlanReadMatcher(() => "local://wp-migration.md");
		expect(matcher(context({ path: "local://wp-migration.md" }))).toBe(true);
		// The canonical alias stays protected even when the reference is titled.
		expect(matcher(context({ path: "local://PLAN.md" }))).toBe(true);
	});

	it("tolerates read selectors and single-slash scheme spelling", () => {
		const matcher = createPlanReadMatcher(() => "local://wp-migration.md");
		expect(matcher(context({ path: "local://PLAN.md:1-50" }))).toBe(true);
		expect(matcher(context({ path: "local://PLAN.md:raw" }))).toBe(true);
		expect(matcher(context({ path: "local:/PLAN.md" }))).toBe(true);
		expect(matcher(context({ path: "local://wp-migration.md:10-20" }))).toBe(true);
	});

	it("reflects a mid-session retitle at match time", () => {
		let planPath = "local://PLAN.md";
		const matcher = createPlanReadMatcher(() => planPath);
		expect(matcher(context({ path: "local://renamed.md" }))).toBe(false);
		planPath = "local://renamed.md";
		expect(matcher(context({ path: "local://renamed.md" }))).toBe(true);
	});

	it("does not protect non-plan reads or non-read tools", () => {
		const matcher = createPlanReadMatcher(() => "local://wp-migration.md");
		// A different local artifact (shared subagent content) is not the plan.
		expect(matcher(context({ path: "local://scratch.md" }))).toBe(false);
		// Prefix collisions must not match (PLAN.md vs PLAN.md.bak / PLANNER.md).
		expect(matcher(context({ path: "local://PLAN.md.bak" }))).toBe(false);
		expect(matcher(context({ path: "local://PLANNER.md" }))).toBe(false);
		// Ordinary filesystem read.
		expect(matcher(context({ path: "src/index.ts" }))).toBe(false);
		// A non-read tool that happens to carry a plan-looking path.
		expect(matcher(context({ toolName: "edit", callName: "edit", path: "local://PLAN.md" }))).toBe(false);
		// Read with no/invalid path argument.
		expect(matcher(context({ path: undefined }))).toBe(false);
		// Result with no paired tool call.
		expect(matcher(context({ callName: undefined, path: "local://PLAN.md" }))).toBe(false);
	});
});

// --- Integration: plan reads survive prune/shake, regular reads do not -------

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function entry(id: string, message: AssistantMessage | ToolResultMessage): SessionMessageEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-06-03T00:00:00.000Z", message };
}

function readCall(toolCallId: string, path: string): SessionMessageEntry {
	return entry(`assistant-${toolCallId}`, {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path } }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: usage(),
		stopReason: "toolUse",
		timestamp: 0,
	});
}

function readResult(toolCallId: string, text: string): SessionMessageEntry {
	const content: TextContent[] = [{ type: "text", text }];
	return entry(`result-${toolCallId}`, {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content,
		isError: false,
		timestamp: 0,
	});
}

describe("plan-read protection in compaction", () => {
	const matcher = createPlanReadMatcher(() => "local://wp-migration.md");

	it("prunes regular reads but keeps the plan read intact", () => {
		const planResult = readResult("plan-read", "plan body that must remain intact");
		const fileResult = readResult("file-read", "file body that can be pruned ".repeat(20));
		const entries = [
			readCall("plan-read", "local://wp-migration.md"),
			planResult,
			readCall("file-read", "packages/coding-agent/src/index.ts"),
			fileResult,
		];

		const result = pruneToolOutputs(entries, tokenizer, {
			...DEFAULT_PRUNE_CONFIG,
			protectTokens: 0,
			minimumSavings: 0,
			protectedTools: [...DEFAULT_PRUNE_CONFIG.protectedTools, matcher],
		});

		expect(result.prunedCount).toBe(1);
		expect((planResult.message as ToolResultMessage).prunedAt).toBeUndefined();
		expect(typeof (fileResult.message as ToolResultMessage).prunedAt).toBe("number");
	});

	it("excludes the plan read from shake regions", () => {
		const planResult = readResult("plan-read", "plan body that must not be shaken ".repeat(40));
		const fileResult = readResult("file-read", "file body eligible for shake ".repeat(40));
		const entries = [
			readCall("plan-read", "local://wp-migration.md"),
			planResult,
			readCall("file-read", "src/index.ts"),
			fileResult,
		];

		const regions = collectShakeRegions(entries, tokenizer, {
			...AGGRESSIVE_SHAKE_CONFIG,
			protectTokens: 0,
			protectedTools: [...AGGRESSIVE_SHAKE_CONFIG.protectedTools, matcher],
		});

		expect(regions).toHaveLength(1);
		expect(regions[0]?.entry).toBe(fileResult);
	});
});

import { describe, expect, test } from "bun:test";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { SessionMessageEntry } from "@oh-my-pi/pi-agent-core/compaction";
import {
	applyShakeRegion,
	collectShakeRegions,
	DEFAULT_PRUNE_CONFIG,
	invalidateMessageCache,
	isEstimateCacheable,
	pruneToolOutputs,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";

const tokenizer = new Tokenizer();

let idCounter = 0;
function nextId(): string {
	return `mc-${idCounter++}`;
}

function messageEntry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: nextId(), parentId: null, timestamp: new Date().toISOString(), message };
}

function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function settledAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "bench",
		usage: usage(120),
		stopReason: "stop",
		timestamp: 1,
	};
}

function toolResult(text: string, extra?: Partial<ToolResultMessage>): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${idCounter++}`,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
		...extra,
	};
}

describe("estimate cache settle gate", () => {
	test("caches settled assistants (terminal stopReason + real usage)", () => {
		expect(isEstimateCacheable(settledAssistant("done"))).toBe(true);
	});

	test("bypasses a streaming assistant (zero usage seed)", () => {
		const streaming: AssistantMessage = { ...settledAssistant("partial"), usage: usage(0), stopReason: "stop" };
		expect(isEstimateCacheable(streaming)).toBe(false);
	});

	test("bypasses aborted and error assistants even with usage", () => {
		expect(isEstimateCacheable({ ...settledAssistant("x"), stopReason: "aborted" })).toBe(false);
		expect(isEstimateCacheable({ ...settledAssistant("x"), stopReason: "error" })).toBe(false);
	});

	test("caches non-assistant roles unconditionally", () => {
		expect(isEstimateCacheable(toolResult("out") as AgentMessage)).toBe(true);
		expect(isEstimateCacheable({ role: "user", content: "hi", timestamp: 1 } as AgentMessage)).toBe(true);
	});

	test("a streaming assistant re-estimates as its content grows", () => {
		const streaming: AssistantMessage = {
			...settledAssistant("first chunk"),
			usage: usage(0),
			stopReason: "stop",
		};
		const before = tokenizer.countMessage(streaming as AgentMessage);
		streaming.content = [{ type: "text", text: "first chunk plus a much longer continuation of streamed text" }];
		const after = tokenizer.countMessage(streaming as AgentMessage);
		// Unsettled assistants never read the cache, so the grown content is recounted.
		expect(after).toBeGreaterThan(before);
	});
});

describe("estimate cache option split", () => {
	test("default and floored estimates do not collide in one map", () => {
		const blob = "blob ".repeat(4000);
		const msg: AssistantMessage = {
			...settledAssistant("thinking heavy"),
			content: [
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "reasoning", thinkingSignature: blob },
			],
		};
		// Prime the default map first, then the floored one; the floored estimate
		// (which drops the encrypted-reasoning blob) must not read the default entry.
		const withBlob = tokenizer.countMessage(msg as AgentMessage);
		const floored = tokenizer.countMessage(msg as AgentMessage, { excludeEncryptedReasoning: true });
		expect(withBlob).toBeGreaterThan(floored + 500);
		// Cached reads return the same split values.
		expect(tokenizer.countMessage(msg as AgentMessage)).toBe(withBlob);
		expect(tokenizer.countMessage(msg as AgentMessage, { excludeEncryptedReasoning: true })).toBe(floored);
	});

	test("counts native server-tool blocks by default and drops them from the compaction floor", () => {
		const encrypted = "cipher".repeat(4000);
		const msg: AssistantMessage = {
			...settledAssistant("with search"),
			content: [
				{ type: "text", text: "answer" },
				{
					type: "anthropicServerTool",
					block: {
						type: "web_search_tool_result",
						tool_use_id: "srvtoolu_1",
						content: [{ type: "web_search_result", encrypted_content: encrypted }],
					},
				},
			],
		};
		const textOnly = tokenizer.countMessage({
			...settledAssistant("x"),
			content: [{ type: "text", text: "answer" }],
		} as AgentMessage);
		const withServerTool = tokenizer.countMessage(msg as AgentMessage);
		const floored = tokenizer.countMessage(msg as AgentMessage, { excludeEncryptedReasoning: true });
		// Default estimate charges for the serialized server-tool payload…
		expect(withServerTool).toBeGreaterThan(floored + 500);
		// …while the compaction floor ignores the opaque encrypted blob entirely.
		expect(floored).toBe(textOnly);
	});
});

describe("estimate cache invalidation seams", () => {
	test("pruneToolOutputs drops the cached estimate of a pruned result", () => {
		const big = toolResult("x".repeat(20_000));
		const entries = [messageEntry(big as AgentMessage)];
		const before = tokenizer.countMessage(big as AgentMessage);
		expect(before).toBeGreaterThan(1000);

		const result = pruneToolOutputs(entries, tokenizer, {
			...DEFAULT_PRUNE_CONFIG,
			protectTokens: 0,
			minimumSavings: 0,
		});
		expect(result.prunedCount).toBe(1);

		// After the in-place prune the estimate must reflect the short placeholder,
		// not the stale full-content count.
		const after = tokenizer.countMessage(big as AgentMessage);
		expect(after).toBeLessThan(before);
	});

	test("applyShakeRegion drops the cached estimate of a shaken result", () => {
		const big = toolResult(`\`\`\`ts\n${"const value = compute(a, b, c, d, e);\n".repeat(400)}\`\`\``);
		const entry = messageEntry(big as AgentMessage);
		const before = tokenizer.countMessage(big as AgentMessage);

		const regions = collectShakeRegions([entry], tokenizer, {
			protectTokens: 0,
			minSavings: 0,
			protectedTools: [],
			fenceMinTokens: 0,
		});
		expect(regions.length).toBeGreaterThan(0);
		applyShakeRegion(regions[0], "[shaken]");

		const after = tokenizer.countMessage(big as AgentMessage);
		expect(after).toBeLessThan(before);
	});

	test("explicit invalidateMessageCache forces a recount in every tokenizer instance", () => {
		const result = toolResult("original content here");
		const second = new Tokenizer();
		const before = tokenizer.countMessage(result as AgentMessage);
		expect(second.countMessage(result as AgentMessage)).toBe(before);
		// Mutate content directly (simulating an owner rewrite); without
		// invalidation both instances still return their stale memo.
		result.content = [{ type: "text", text: "a much longer replacement body that should count higher than before" }];
		expect(tokenizer.countMessage(result as AgentMessage)).toBe(before);
		expect(second.countMessage(result as AgentMessage)).toBe(before);
		// One version-tag bump invalidates the memo in BOTH instances.
		invalidateMessageCache(result as AgentMessage);
		expect(tokenizer.countMessage(result as AgentMessage)).toBeGreaterThan(before);
		expect(second.countMessage(result as AgentMessage)).toBeGreaterThan(before);
	});
});

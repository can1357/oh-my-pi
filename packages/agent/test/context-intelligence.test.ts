import { describe, expect, test } from "bun:test";
import { assembleContext, contextBudgetForComplexity, rankContextCandidates } from "../src/context-intelligence";
import { classifyTask } from "../src/task-router";
import type { AgentMessage } from "../src/types";

const counter = {
	countMessage(message: AgentMessage): number {
		const value = message as unknown as { content?: unknown };
		const content = value.content;
		if (typeof content === "string") return Math.ceil(content.length / 4);
		if (!Array.isArray(content)) return 0;
		return Math.ceil(
			content.reduce((sum, block) => {
				if (!block || typeof block !== "object") return sum;
				return sum + String((block as { text?: unknown }).text ?? "").length;
			}, 0) / 4,
		);
	},
};

function user(content: string): AgentMessage {
	return { role: "user", content, timestamp: Date.now() } as AgentMessage;
}

function toolResult(
	content: string,
	options: { toolName?: string; isError?: boolean; timestamp?: number } = {},
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "tc",
		toolName: options.toolName ?? "read",
		content: [{ type: "text", text: content }],
		isError: options.isError ?? false,
		timestamp: options.timestamp ?? Date.now(),
	} as AgentMessage;
}

describe("context intelligence", () => {
	test("direct file references outrank unrelated context", () => {
		const task = "Fix the bug in src/auth/session.ts";
		const messages = [
			toolResult("components/footer.tsx\nFooter", { toolName: "read", timestamp: 1 }),
			toolResult("src/auth/session.ts\nSessionManager refreshSession implementation", { toolName: "read", timestamp: 2 }),
		];
		const ranked = rankContextCandidates(task, messages, counter);
		expect(ranked[0]?.location).toContain("src/auth/session.ts");
	});

	test("related test output is ranked highly for a behavior task", () => {
		const task = "Fix session expiration";
		const messages = [
			toolResult("auth/session.ts\nfunction refreshSession()", { toolName: "read", timestamp: 1 }),
			toolResult("auth/session.test.ts\nexpected expiration after 3600s", { toolName: "read_tests", timestamp: 2 }),
			toolResult("components/footer.tsx\nFooter", { toolName: "read", timestamp: 3 }),
		];
		const ranked = rankContextCandidates(task, messages, counter);
		const top = ranked.slice(0, 2).map(candidate => candidate.content);
		expect(top.some(content => content.includes("session.ts"))).toBe(true);
		expect(top.some(content => content.includes("session.test.ts"))).toBe(true);
	});

	test("recent failure evidence outranks old unrelated output", () => {
		const task = "Fix session expiration";
		const messages = [
			toolResult("old unrelated output", { toolName: "bash", timestamp: 1 }),
			toolResult("ERROR: session.test.ts expected 401, received 200", { toolName: "test", isError: true, timestamp: 2 }),
		];
		const ranked = rankContextCandidates(task, messages, counter);
		expect(ranked[0]?.type).toBe("previous_failure");
	});

	test("unchanged duplicate reads are compacted while changed reads remain authoritative", () => {
		const task = "Fix src/auth/session.ts";
		const messages = [
			toolResult("src/auth/session.ts\nold session implementation", { toolName: "read", timestamp: 1 }),
			toolResult("src/auth/session.ts\nold session implementation", { toolName: "read", timestamp: 2 }),
			toolResult("src/auth/session.ts\nnew session implementation after edit", { toolName: "read", timestamp: 3 }),
		];
		const result = assembleContext(task, messages, counter, {
			complexity: classifyTask(task).complexity,
			budgetTokens: 1000,
		});
		expect(result.telemetry.deduplicatedCandidates).toBeGreaterThanOrEqual(1);
		expect(result.telemetry.staleCandidates).toBeGreaterThanOrEqual(1);
		const texts = result.messages.map(message => JSON.stringify((message as unknown as { content?: unknown }).content));
		expect(texts.some(text => text.includes("new session implementation after edit"))).toBe(true);
	});

	test("budget compacts historical tool output and preserves failure evidence", () => {
		const long = "useful session detail ".repeat(500);
		const messages = [
			toolResult("src/auth/session.ts\n" + long, { toolName: "read", timestamp: 1 }),
			toolResult("session.test.ts\nERROR: expected 401, received 200", { toolName: "test", isError: true, timestamp: 2 }),
			toolResult("old unrelated search output", { toolName: "search", timestamp: 3 }),
			user("background note"),
			user("another background note"),
			user("Fix session expiration"),
		];
		const result = assembleContext("Fix session expiration", messages, counter, {
			complexity: "NORMAL",
			budgetTokens: 500,
			recentMessageCount: 3,
		});
		expect(result.telemetry.estimatedTokensAfter).toBeLessThanOrEqual(500);
		expect(result.telemetry.discardedCandidates + result.telemetry.deduplicatedCandidates).toBeGreaterThan(0);
		expect(JSON.stringify(result.messages[1])).toContain("expected 401, received 200");
	});

	test("complexity changes context depth without creating another classifier", () => {
		expect(contextBudgetForComplexity("SIMPLE", 100_000)).toBeLessThan(contextBudgetForComplexity("NORMAL", 100_000));
		expect(contextBudgetForComplexity("NORMAL", 100_000)).toBeLessThan(contextBudgetForComplexity("COMPLEX", 100_000));
		expect(contextBudgetForComplexity("COMPLEX", 100_000)).toBeLessThan(contextBudgetForComplexity("VERY_COMPLEX", 100_000));
	});
});

import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("SessionManager usage statistics", () => {
	const modelUsage = {
		purpose: "auto-thinking",
		role: "smol",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		stopReason: "stop",
		usage: {
			input: 11,
			output: 2,
			cacheRead: 3,
			cacheWrite: 0,
			totalTokens: 16,
			cost: { input: 0.0011, output: 0.0004, cacheRead: 0.00003, cacheWrite: 0, total: 0.00153 },
		},
	} as const;

	it("counts non-transcript model calls without adding conversation messages", () => {
		const session = SessionManager.inMemory();

		session.appendModelUsage(modelUsage, { sessionId: session.getSessionId(), parentId: session.getLeafId() });

		expect(session.getUsageStatistics()).toMatchObject({
			input: 11,
			output: 2,
			cacheRead: 3,
			totalTokens: 16,
			cost: 0.00153,
		});
		expect(session.buildSessionContext().messages).toEqual([]);
	});

	it("records late usage on its initiating branch without moving the active leaf", () => {
		const session = SessionManager.inMemory();
		const ownerParent = session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const activeLeaf = session.appendMessage({ role: "user", content: "successor", timestamp: 2 });

		const usageId = session.appendModelUsage(modelUsage, {
			sessionId: session.getSessionId(),
			parentId: ownerParent,
		});

		expect(usageId).toBeDefined();
		expect(session.getLeafId()).toBe(activeLeaf);
		expect(session.getBranch().some(entry => entry.id === usageId)).toBe(false);
		expect(session.getBranch(usageId).at(-1)).toMatchObject({ type: "model_usage", parentId: ownerParent });
	});

	it("accumulates premium requests from assistant messages and task tool results", () => {
		const session = SessionManager.inMemory();

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-completions",
			provider: "github-copilot",
			model: "gpt-4o",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				premiumRequests: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "task_1",
			toolName: "task",
			content: [{ type: "text", text: "task output" }],
			details: {
				usage: {
					input: 2,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					premiumRequests: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			isError: false,
			timestamp: 3,
		});

		const usage = session.getUsageStatistics();
		expect(usage.input).toBe(12);
		expect(usage.output).toBe(8);
		expect(usage.premiumRequests).toBe(3);
	});

	it("keeps orchestration usage out of ordinary input while preserving total tokens", () => {
		const session = SessionManager.inMemory();

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.5",
			usage: {
				input: 0,
				output: 29,
				cacheRead: 180_224,
				cacheWrite: 0,
				totalTokens: 185_882,
				orchestration: { input: 5_629 },
				cost: { input: 5.629, output: 0, cacheRead: 0, cacheWrite: 0, total: 5.629 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		});

		const usage = session.getUsageStatistics();
		expect(usage.input).toBe(0);
		expect(usage.cacheRead).toBe(180_224);
		expect(usage.totalTokens).toBe(185_882);
		expect(usage.orchestrationInput).toBe(5_629);
		expect(usage.cost).toBeCloseTo(5.629, 8);
	});

	it("preserves fractional premium request multipliers", () => {
		const session = SessionManager.inMemory();

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "haiku" }],
			api: "anthropic-messages",
			provider: "github-copilot",
			model: "claude-haiku-4.5",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				premiumRequests: 0.33,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "task_1",
			toolName: "task",
			content: [{ type: "text", text: "task output" }],
			details: {
				usage: {
					input: 2,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					premiumRequests: 3,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			isError: false,
			timestamp: 3,
		});

		const usage = session.getUsageStatistics();
		expect(usage.premiumRequests).toBeCloseTo(3.33, 8);
	});
	it("defaults premium requests to zero when usage payload omits the field", () => {
		const session = SessionManager.inMemory();

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4o",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		const usage = session.getUsageStatistics();
		expect(usage.premiumRequests).toBe(0);
	});

	it("accumulates the full billed cost across turns, including cache-read cost", () => {
		// Contract: the session cost aggregate sums each turn's full `cost.total`
		// (input+output+cacheRead+cacheWrite), not a cache-excluded "new-work"
		// subset. Cache-read cost is real billed spend — the cached context is
		// re-read at the cache-read rate every turn — so it must stay in the
		// ledger that /usage, ACP usage_update, and hooks consume. Two turns with
		// nonzero cacheRead make the readings diverge: full total = 18 vs the
		// excluded subset (input+output+cacheWrite) = 8.
		const session = SessionManager.inMemory();

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		for (const timestamp of [2, 3]) {
			session.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4",
				usage: {
					input: 1,
					output: 2,
					cacheRead: 100,
					cacheWrite: 10,
					totalTokens: 113,
					cost: { input: 1, output: 2, cacheRead: 5, cacheWrite: 1, total: 9 },
				},
				stopReason: "stop",
				timestamp,
			});
		}

		const usage = session.getUsageStatistics();
		expect(usage.cacheRead).toBe(200);
		expect(usage.cost).toBeCloseTo(18, 8);
	});
});

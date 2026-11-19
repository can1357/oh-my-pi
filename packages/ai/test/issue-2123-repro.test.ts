/**
 * Issue #2123 — `Error while using Claude Opus models`
 *
 * Reporter (omp 15.10.4, Windows, Claude Pro/Max OAuth): a fresh chat on
 * Claude Opus 4.6 fails immediately with
 *   `400 ... clear_thinking_20251015 strategy requires thinking to be enabled or adaptive`.
 *
 * Root cause: OAuth requests on adaptive-thinking Opus models attach a
 * `context_management.edits[clear_thinking_20251015]` block. On the very
 * first user turn the coding-agent's eager-todo prelude pins a forced
 * `tool_choice: { type: "tool", name: "todo" }`, which routes through
 * `disableThinkingIfToolChoiceForced` in `providers/anthropic.ts`. The
 * 15.10.4 implementation stripped `params.thinking` but left
 * `params.context_management` in place, sending an orphan strategy that
 * the Anthropic API rejects with the exact message above.
 *
 * Fix: when forced tool_choice removes `thinking`, also remove
 * `context_management` so the wire payload satisfies the
 * "thinking enabled or adaptive" precondition (i.e. neither is sent, and
 * the strategy goes with them).
 */
import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const OPUS_46_OAUTH: Model<"anthropic-messages"> = buildModel({
	id: "claude-opus-4-6",
	name: "Claude Opus 4.6",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	thinking: {
		mode: "anthropic-adaptive",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	},
});

const todoTool: Tool = {
	name: "todo",
	description: "Manage a phased task list",
	parameters: {
		type: "object",
		properties: { ops: { type: "array", items: { type: "object" } } },
		required: ["ops"],
	} as unknown as Tool["parameters"],
};

const firstTurnContext: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Plan my migration", timestamp: Date.now() }],
	tools: [todoTool],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type CapturedPayload = {
	thinking?: unknown;
	context_management?: unknown;
	tool_choice?: { type?: string; name?: string };
};

function capturePayload(toolChoice: "any" | { type: "tool"; name: string }): Promise<CapturedPayload> {
	const { promise, resolve } = Promise.withResolvers<CapturedPayload>();
	void streamAnthropic(OPUS_46_OAUTH, firstTurnContext, {
		apiKey: "sk-ant-oat-test",
		isOAuth: true,
		signal: abortedSignal(),
		thinkingEnabled: true,
		reasoning: Effort.High,
		toolChoice,
		onPayload: payload => {
			resolve(payload as CapturedPayload);
			return undefined;
		},
	});
	return promise;
}

describe("issue #2123 — OAuth Opus + forced tool_choice must strip context_management with thinking", () => {
	it("strips context_management when forced named tool_choice deletes adaptive thinking", async () => {
		// Mirrors the eager-todo prelude: first user turn on Opus pins
		// tool_choice: { type: "tool", name: "<active-tool>" } while adaptive
		// thinking is still requested at default `high` effort.
		const payload = await capturePayload({ type: "tool", name: "todo" });
		expect(payload.thinking).toBeUndefined();
		expect(payload.context_management).toBeUndefined();
	});

	it("strips context_management when forced `any` tool_choice deletes adaptive thinking", async () => {
		// Plan-mode and other "must call something" enforcement paths use
		// the broader tool_choice "any" (Anthropic's `any`). Same invariant:
		// orphan context_management must NOT survive the strip.
		const payload = await capturePayload("any");
		expect(payload.thinking).toBeUndefined();
		expect(payload.context_management).toBeUndefined();
	});
});

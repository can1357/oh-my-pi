import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AssistantTextRenderer } from "@oh-my-pi/pi-tui/chat/extension-types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}

describe("EventController with assistant text renderers", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		// Smooth streaming stays at its default (on): renderers must still see every delta in full.
		await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": true } });
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("hands renderers the full text of every drawn update instead of smooth-reveal frames", async () => {
		const seen: [string, boolean][] = [];
		const renderer: AssistantTextRenderer = ({ text, streaming }) => {
			seen.push([text, streaming]);
			return undefined;
		};
		const extensionRunner = {
			getAssistantThinkingRenderers: () => [],
			getAssistantTextRenderers: () => [renderer],
		} as unknown as ExtensionRunner;
		const ctx = createInteractiveModeContext({ viewSession: { extensionRunner } });
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message: assistant("") } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		// Several deltas land before any reveal tick could run.
		const deltas = [
			"The cache key",
			"The cache key only hashes package.json,",
			"The cache key only hashes package.json, so it drifts.",
		];
		for (const text of deltas) {
			await controller.handleEvent({ type: "message_update", message: assistant(text) } as Extract<
				AgentSessionEvent,
				{ type: "message_update" }
			>);
		}

		expect(seen).toEqual(deltas.map(text => [text, true]));
	});

	it("hands renderers the full text at once when they are enabled during a smooth reveal", async () => {
		let renderers: AssistantTextRenderer[] = [];
		const seen: string[] = [];
		const renderer: AssistantTextRenderer = ({ text }) => {
			seen.push(text);
			return undefined;
		};
		const extensionRunner = {
			getAssistantThinkingRenderers: () => [],
			getAssistantTextRenderers: () => renderers,
		} as unknown as ExtensionRunner;
		const ctx = createInteractiveModeContext({ viewSession: { extensionRunner, agent: { state: {} } } });
		const controller = new EventController(ctx);
		const full = "The cache key only hashes package.json, so it keeps hitting while the lockfile drifts.";
		await controller.handleEvent({ type: "message_start", message: assistant("") } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		// Smooth streaming is revealing this; with fake timers no tick has run, so a backlog is pending.
		await controller.handleEvent({ type: "message_update", message: assistant(full) } as Extract<
			AgentSessionEvent,
			{ type: "message_update" }
		>);

		renderers = [renderer];
		controller.applyAssistantTextRenderers();
		vi.advanceTimersByTime(200);

		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every(text => text === full)).toBe(true);
	});
});

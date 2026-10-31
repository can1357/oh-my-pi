/**
 * Disposal must stop in-flight judge work at `beginDispose()` — the synchronous
 * entry every teardown path shares, including the wrappers that call it and then
 * await other work before `dispose()`. A verdict that lands after that point must
 * not journal usage, append a retry reminder, persist a thinking level, or emit a
 * thinking-level event into a disposed session.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as unexpectedStopClassifier from "@oh-my-pi/pi-coding-agent/session/unexpected-stop-classifier";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

type Phase = "live-control" | "disposed";

const sessions: AgentSession[] = [];
const authStorages: AuthStorage[] = [];

function createAuth(): AuthStorage {
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("anthropic", "test-key");
	auth.keys.setRuntime("mock", "test-key");
	authStorages.push(auth);
	return auth;
}

function judgmentUsage(purpose: string, role: string, model: { api: string; provider: string; id: string }) {
	return {
		purpose,
		role,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop" as const,
		usage: {
			input: 7,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 8,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function entryCount(session: AgentSession, type: string): number {
	return session.sessionManager.getEntries().filter(entry => entry.type === type).length;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const auth of authStorages.splice(0)) auth.close();
});

describe("AgentSession disposal and in-flight judge calls", () => {
	it.each<Phase>(["live-control", "disposed"])(
		"unexpected-stop judge verdict arriving %s",
		async phase => {
			const auth = createAuth();
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled Claude Sonnet 4.5 model");
			const mock = createMockModel({
				responses: [
					{
						content: [
							{ type: "text", text: "I should apply the same fix to the JS eval worker. Doing that now." },
						],
						stopReason: "stop",
					},
					{ content: ["done now"], stopReason: "stop" },
				],
			});
			const registry = new ModelRegistry(auth);
			const getAvailable = registry.getAvailable.bind(registry);
			vi.spyOn(registry, "getAvailable").mockImplementation(kind => (kind === "all" ? [mock] : getAvailable(kind)));
			const current: { session?: AgentSession } = {};
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				getToolChoice: () => current.session?.nextToolChoiceDirective(),
				streamFn: mock.stream,
			});
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				modelRegistry: registry,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"retry.enabled": false,
					"todo.enabled": false,
					"todo.reminders": false,
					"features.unexpectedStopDetection": "smart",
					modelRoles: { default: `${mock.provider}/${mock.id}`, judge: `${mock.provider}/${mock.id}` },
					"retry.fallbackChains": { judge: [] },
				}),
			});
			current.session = session;
			sessions.push(session);

			const judgeStarted = Promise.withResolvers<void>();
			const releaseJudge = Promise.withResolvers<void>();
			let judgeSignal: AbortSignal | undefined;
			vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockImplementation(async (_stop, deps) => {
				judgeSignal = deps.signal;
				judgeStarted.resolve();
				await releaseJudge.promise;
				// A cancelled provider call reports no usage and no verdict.
				if (deps.signal?.aborted) return undefined;
				deps.onUsage?.(judgmentUsage("unexpected-stop", "judge", model));
				return true;
			});

			const prompt = session.prompt("Fix the eval worker");
			await judgeStarted.promise;
			const usageBefore = entryCount(session, "model_usage");
			const messagesBefore = session.agent.state.messages.length;
			if (phase === "disposed") session.beginDispose();
			const abortedAtBeginDispose = judgeSignal?.aborted === true;
			releaseJudge.resolve();
			await prompt;

			const reminders = session.agent.state.messages
				.slice(messagesBefore)
				.filter(
					message =>
						message.role === "developer" &&
						JSON.stringify(message.content).includes("You said you would continue"),
				);
			const usageWritten = entryCount(session, "model_usage") - usageBefore;

			if (phase === "live-control") {
				expect({ abortedAtBeginDispose, usageWritten, reminders: reminders.length }).toEqual({
					abortedAtBeginDispose: false,
					usageWritten: 1,
					reminders: 1,
				});
			} else {
				expect({ abortedAtBeginDispose, usageWritten, reminders: reminders.length }).toEqual({
					abortedAtBeginDispose: true,
					usageWritten: 0,
					reminders: 0,
				});
			}
		},
		20_000,
	);

	it.each<Phase>(["live-control", "disposed"])(
		"auto-thinking classification arriving %s",
		async phase => {
			const auth = createAuth();
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled Claude Sonnet 4.5 model");
			const mock = createMockModel({ responses: [{ content: ["ok"] }] });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
			});
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				modelRegistry: new ModelRegistry(auth),
				settings: Settings.isolated({
					"compaction.enabled": false,
					"retry.enabled": false,
					"todo.enabled": false,
					"features.unexpectedStopDetection": "none",
					modelRoles: { default: `${model.provider}/${model.id}` },
				}),
			});
			sessions.push(session);

			const levelEvents: string[] = [];
			session.subscribe(event => {
				if (event.type === "thinking_level_changed") levelEvents.push(String(event.thinkingLevel));
			});

			const classifierStarted = Promise.withResolvers<void>();
			const releaseClassifier = Promise.withResolvers<void>();
			let classifierSignal: AbortSignal | undefined;
			vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockImplementation(async (_input, options) => {
				classifierSignal = options.signal;
				classifierStarted.resolve();
				await releaseClassifier.promise;
				// A cancelled provider call reports no usage; the classifier rejects.
				if (options.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
				options.onUsage?.(judgmentUsage("auto-thinking", "smol", model));
				return Effort.Low;
			});
			vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

			session.setThinkingLevel(AUTO_THINKING);
			const usageBefore = entryCount(session, "model_usage");
			const levelEntriesBefore = entryCount(session, "thinking_level_change");
			const eventsBefore = levelEvents.length;

			const prompt = session.prompt("Implement a focused parser fix");
			await classifierStarted.promise;
			if (phase === "disposed") session.beginDispose();
			const abortedAtBeginDispose = classifierSignal?.aborted === true;
			releaseClassifier.resolve();
			await prompt;

			const observed = {
				abortedAtBeginDispose,
				usageWritten: entryCount(session, "model_usage") - usageBefore,
				levelEntriesWritten: entryCount(session, "thinking_level_change") - levelEntriesBefore,
				eventsEmitted: levelEvents.slice(eventsBefore),
			};
			if (phase === "live-control") {
				expect(observed).toEqual({
					abortedAtBeginDispose: false,
					usageWritten: 1,
					levelEntriesWritten: 1,
					eventsEmitted: [Effort.Low],
				});
			} else {
				expect(observed).toEqual({
					abortedAtBeginDispose: true,
					usageWritten: 0,
					levelEntriesWritten: 0,
					eventsEmitted: [],
				});
			}
		},
		20_000,
	);
});

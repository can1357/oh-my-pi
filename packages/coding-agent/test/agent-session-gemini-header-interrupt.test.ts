import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	ThinkingContent,
} from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { GEMINI_HEADER_RUNAWAY_THRESHOLD } from "@oh-my-pi/pi-ai/utils/thinking-loop";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Concatenate the text of a developer/user/custom LLM message. */
function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	let text = "";
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
	}
	return text;
}

/**
 * First-call stream: a genuinely-distinct planning runaway — each thought summary
 * has a fresh title + a paragraph naming new code anchors, so the similarity loop
 * guard never fires; only the header-count guard catches it. Mirrors
 * `streaming-edit-abort`: an abort listener pushes the terminal `aborted` event,
 * and deltas are spaced with `Bun.sleep(0)` so the interceptor's `agent.abort()`
 * lands before the turn would otherwise finish `stop`.
 *
 * When `finalText` is provided, a non-interrupted run ends with visible prose so
 * the empty-stop handler does not auto-retry; used to prove the reminder setting
 * alone controls this feature.
 */
function headerRunawayStream(
	model: Model<Api>,
	options?: SimpleStreamOptions,
	finalText?: string,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const thinking: ThinkingContent = { type: "thinking", thinking: "" };
	const timestamp = Date.now();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [thinking],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp,
	};
	let aborted = false;
	options?.signal?.addEventListener(
		"abort",
		() => {
			if (aborted) return;
			aborted = true;
			stream.push({
				type: "error",
				reason: "aborted",
				error: { ...partial, content: [{ ...thinking }], stopReason: "aborted" },
			});
		},
		{ once: true },
	);

	void (async () => {
		stream.push({ type: "start", partial });
		stream.push({ type: "thinking_start", contentIndex: 0, partial });
		for (let i = 0; i < GEMINI_HEADER_RUNAWAY_THRESHOLD + 2; i++) {
			if (aborted) return;
			const delta = `**Refining Stage ${i}**\n\nReworking module_${i} so handler_${i} routes Stage${i}Result through render_${i}.\n\n`;
			thinking.thinking += delta;
			stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial });
			await Bun.sleep(0);
		}
		if (aborted) return;
		stream.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial });
		if (!finalText) {
			stream.push({ type: "done", reason: "stop", message: partial });
			return;
		}
		const finalMessage: AssistantMessage = {
			...partial,
			content: [{ ...thinking }, { type: "text", text: finalText }],
		};
		stream.push({ type: "text_start", contentIndex: 1, partial: finalMessage });
		stream.push({ type: "text_delta", contentIndex: 1, delta: finalText, partial: finalMessage });
		stream.push({ type: "text_end", contentIndex: 1, content: finalText, partial: finalMessage });
		stream.push({ type: "done", reason: "stop", message: finalMessage });
	})();
	return stream;
}

function successStream(model: Model<Api>, text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

describe("AgentSession Gemini header-runaway interrupt", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-gemini-header-interrupt-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	function buildSession(
		streamFn: Agent["streamFn"],
		overrides?: Record<string, unknown>,
		modelId = "google/gemini-3.5-flash",
	): void {
		const model = createMockModel({ provider: "openrouter", id: modelId }).model;
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn,
			convertToLlm,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"advisor.enabled": false,
			"model.loopGuard.enabled": true,
			"model.loopGuard.toolCallReminder": true,
			...overrides,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
	}

	it("interrupts the reasoning runaway, injects a tool-call reminder, and continues", async () => {
		const contexts: Context[] = [];
		let call = 0;
		buildSession((model, context, options) => {
			contexts.push(context);
			call++;
			return call === 1 ? headerRunawayStream(model, options) : successStream(model, "Acted: called a tool.");
		});
		const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
		session?.subscribe(event => {
			if (event.type === "notice") notices.push(event);
		});

		await session?.prompt("Do the task");
		await session?.waitForIdle();

		// The runaway was interrupted and the turn was re-driven.
		expect(call).toBe(2);

		// The user saw a transparency notice from the loop guard.
		const guardNotice = notices.find(n => n.source === "loop-guard");
		expect(guardNotice).toBeDefined();
		// The continuation carried the hidden tool-call reminder (custom -> developer).
		const reminderInContext = contexts[1].messages.some(
			m =>
				m.role === "developer" &&
				/consecutive planning headers/.test(messageText(m)) &&
				/tool call/.test(messageText(m)),
		);
		expect(reminderInContext).toBe(true);
		// It names the header count that tripped the guard.
		const reminderText = contexts[1].messages.map(messageText).join("\n");
		expect(reminderText).toContain(String(GEMINI_HEADER_RUNAWAY_THRESHOLD));

		// The stalled reasoning-only turn was discarded (not replayed as loop fuel).
		const messages = session?.agent.state.messages ?? [];
		const assistants = messages.filter((m): m is AssistantMessage => m.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0].content).toEqual([{ type: "text", text: "Acted: called a tool." }]);
		const replaysHeaders = messages.some(m => m.role === "assistant" && /Refining Stage/.test(messageText(m)));
		expect(replaysHeaders).toBe(false);
	});

	it("does not interrupt when the tool-call reminder setting is off", async () => {
		let call = 0;
		buildSession(
			(model, _context, options) => {
				call++;
				return headerRunawayStream(model, options, "Visible final answer.");
			},
			{ "model.loopGuard.toolCallReminder": false },
		);
		const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
		session?.subscribe(event => {
			if (event.type === "notice") notices.push(event);
		});

		await session?.prompt("Do the task");
		await session?.waitForIdle();

		expect(call).toBe(1);
		expect(notices.some(n => n.source === "loop-guard")).toBe(false);
		const messages = session?.agent.state.messages ?? [];
		const reminderInjected = messages.some(m => m.role === "custom" && m.customType === "gemini-tool-call-reminder");
		expect(reminderInjected).toBe(false);
		const assistants = messages.filter((m): m is AssistantMessage => m.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0].content.at(-1)).toEqual({ type: "text", text: "Visible final answer." });
	});

	it("does not interrupt a DeepSeek header run", async () => {
		let call = 0;
		buildSession(
			(model, _context, options) => {
				call++;
				return headerRunawayStream(model, options, "Visible DeepSeek answer.");
			},
			undefined,
			"deepseek-reasoner",
		);

		await session?.prompt("Do the task");
		await session?.waitForIdle();

		expect(call).toBe(1);
		const messages = session?.agent.state.messages ?? [];
		expect(
			messages.some(message => message.role === "custom" && message.customType === "gemini-tool-call-reminder"),
		).toBe(false);
	});
});

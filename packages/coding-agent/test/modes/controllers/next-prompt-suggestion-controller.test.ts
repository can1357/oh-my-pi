import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, UserMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { NextPromptSuggestionController } from "@oh-my-pi/pi-coding-agent/modes/controllers/next-prompt-suggestion-controller";
import {
	NEXT_PROMPT_EXPIRY_MS,
	NEXT_PROMPT_TIMEOUT_MS,
	type NextPromptSuggestionGenerator,
} from "@oh-my-pi/pi-coding-agent/modes/next-prompt-suggestion";
import { cfgNextPromptSuggestionEnabled } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function userMessage(text: string, timestamp: number): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

interface ControllerHarnessState {
	enabled: boolean;
	focused: boolean;
	focusedAgentId: string | undefined;
	text: string;
	popup: boolean;
	viewSession: AgentSession | undefined;
}

interface GateHarness {
	state: ControllerHarnessState;
	event: Extract<AgentSessionEvent, { type: "agent_end" }>;
	editor: {
		pendingImages: ImageContent[];
		pendingImageLinks: (string | undefined)[];
	};
	session: AgentSession;
	ctx: InteractiveModeContext;
	generate: Mock<NextPromptSuggestionGenerator>;
}

interface SessionLifecycleHarness {
	authStorage: AuthStorage;
	controller: NextPromptSuggestionController;
	generate: Mock<NextPromptSuggestionGenerator>;
	session: AgentSession;
}

function createHarness(generateResult: Promise<string | null> = Promise.resolve("Suggested next prompt")) {
	const state: ControllerHarnessState = {
		enabled: true,
		focused: true,
		focusedAgentId: undefined,
		text: "",
		popup: false,
		viewSession: undefined,
	};
	const setNextPromptSuggestion = vi.fn();
	const clearNextPromptSuggestion = vi.fn();
	const editor = {
		getText: () => state.text,
		isShowingAutocomplete: () => state.popup,
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		setNextPromptSuggestion,
		clearNextPromptSuggestion,
	};
	const session = {
		isStreaming: false,
		isCompacting: false,
		hasDeferredPostPromptWork: false,
		isGeneratingHandoff: false,
		queuedMessageCount: 0,
	} as unknown as AgentSession;
	const settings = Settings.isolated({ "nextPromptSuggestion.enabled": true });
	Object.defineProperty(state, "enabled", {
		get: () => cfgNextPromptSuggestionEnabled.get(settings),
		set: (enabled: boolean) => cfgNextPromptSuggestionEnabled.override(settings, enabled),
	});
	const requestComponentRender = vi.fn();
	const ui = {
		getFocused: () => (state.focused ? editor : null),
		requestComponentRender,
	};
	const ctx = {
		ui,
		editor,
		session,
		get viewSession() {
			return state.viewSession ?? session;
		},
		get focusedAgentId() {
			return state.focusedAgentId;
		},
		settings,
		retryLoader: undefined,
		planModeEnabled: false,
		goalModeEnabled: false,
		loopModeEnabled: false,
	} as unknown as InteractiveModeContext;
	const event: Extract<AgentSessionEvent, { type: "agent_end" }> = {
		type: "agent_end",
		isTerminal: true,
		messages: [userMessage("Question", 1), assistantMessage("Answer", 2)] as AgentMessage[],
	};
	const generate = vi.fn(() => generateResult) as Mock<NextPromptSuggestionGenerator>;
	return {
		clearNextPromptSuggestion,
		ctx,
		editor,
		event,
		generate,
		requestComponentRender,
		session,
		setNextPromptSuggestion,
		state,
	};
}

async function createSessionLifecycleHarness(): Promise<SessionLifecycleHarness> {
	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"nextPromptSuggestion.enabled": true,
		"retry.enabled": false,
		"todo.reminders": false,
	});
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		}),
		sessionManager: SessionManager.inMemory(process.cwd()),
		settings,
		modelRegistry,
	});
	const editor = {
		getText: () => "",
		isShowingAutocomplete: () => false,
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		setNextPromptSuggestion: vi.fn(),
		clearNextPromptSuggestion: vi.fn(),
	};
	const ctx = {
		ui: {
			getFocused: () => editor,
			requestComponentRender: vi.fn(),
		},
		editor,
		session,
		viewSession: session,
		focusedAgentId: undefined,
		settings,
		retryLoader: undefined,
		planModeEnabled: false,
		goalModeEnabled: false,
		loopModeEnabled: false,
	} as unknown as InteractiveModeContext;
	const generate = vi.fn(async () => "Inspect the current result") as Mock<NextPromptSuggestionGenerator>;
	const controller = new NextPromptSuggestionController(ctx, generate);
	return { authStorage, controller, generate, session };
}

async function emitTerminalAgentEnd(harness: SessionLifecycleHarness): Promise<boolean[]> {
	const observedPostPromptWork: boolean[] = [];
	const terminal = Promise.withResolvers<void>();
	const unsubscribe = harness.session.subscribe(event => {
		if (event.type !== "agent_end") return;
		observedPostPromptWork.push(harness.session.hasPostPromptWork);
		harness.controller.request(event);
		terminal.resolve();
	});
	const user = userMessage("What should I do next?", Date.now() - 1);
	const assistant = assistantMessage("The current task is complete.", Date.now());
	harness.session.agent.emitExternalEvent({ type: "message_end", message: assistant });
	harness.session.agent.emitExternalEvent({ type: "agent_end", messages: [user, assistant] });
	await terminal.promise;
	unsubscribe();
	return observedPostPromptWork;
}

const controllers: NextPromptSuggestionController[] = [];
const sessionLifecycleHarnesses: SessionLifecycleHarness[] = [];

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(async () => {
	for (const controller of controllers.splice(0)) controller.dispose();
	for (const harness of sessionLifecycleHarnesses.splice(0)) {
		harness.controller.dispose();
		await harness.session.dispose();
		harness.authStorage.close();
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("NextPromptSuggestionController", () => {
	it("installs and repaints one eligible generated suggestion", async () => {
		const harness = createHarness();
		const controller = new NextPromptSuggestionController(harness.ctx, harness.generate);
		controllers.push(controller);

		controller.request(harness.event);

		expect(harness.generate).toHaveBeenCalledTimes(1);
		const options = harness.generate.mock.calls[0]?.[0];
		expect(options).toMatchObject({
			session: harness.session,
			settings: harness.ctx.settings,
			event: harness.event,
		});
		expect(options?.signal.aborted).toBe(false);
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.setNextPromptSuggestion).toHaveBeenCalledWith("Suggested next prompt");
		expect(harness.requestComponentRender).toHaveBeenCalledWith(harness.editor);
	});

	it("rejects every ineligible gate before invoking the generator", () => {
		const cases: Array<{
			name: string;
			arrange: (harness: GateHarness) => void;
		}> = [
			{
				name: "setting disabled",
				arrange: harness => {
					harness.state.enabled = false;
				},
			},
			{
				name: "non-terminal event",
				arrange: harness => {
					harness.event.isTerminal = false;
				},
			},
			{
				name: "different view session",
				arrange: harness => {
					harness.state.viewSession = {} as AgentSession;
				},
			},
			{
				name: "focused subagent",
				arrange: harness => {
					harness.state.focusedAgentId = "worker";
				},
			},
			{
				name: "editor not focused",
				arrange: harness => {
					harness.state.focused = false;
				},
			},
			{
				name: "non-empty editor",
				arrange: harness => {
					harness.state.text = " ";
				},
			},
			{
				name: "autocomplete popup",
				arrange: harness => {
					harness.state.popup = true;
				},
			},
			{
				name: "pending image",
				arrange: harness => {
					harness.editor.pendingImages.push({ type: "image", data: "AA==", mimeType: "image/png" });
				},
			},
			{
				name: "pending image link",
				arrange: harness => {
					harness.editor.pendingImageLinks.push("file:///tmp/image.png");
				},
			},
			{
				name: "streaming",
				arrange: harness => {
					Object.assign(harness.session as unknown as { isStreaming: boolean }, { isStreaming: true });
				},
			},
			{
				name: "compacting",
				arrange: harness => {
					Object.assign(harness.session as unknown as { isCompacting: boolean }, { isCompacting: true });
				},
			},
			{
				name: "deferred post-prompt work",
				arrange: harness => {
					Object.assign(harness.session as unknown as { hasDeferredPostPromptWork: boolean }, {
						hasDeferredPostPromptWork: true,
					});
				},
			},
			{
				name: "handoff",
				arrange: harness => {
					Object.assign(harness.session as unknown as { isGeneratingHandoff: boolean }, {
						isGeneratingHandoff: true,
					});
				},
			},
			{
				name: "queued message",
				arrange: harness => {
					Object.assign(harness.session as unknown as { queuedMessageCount: number }, {
						queuedMessageCount: 1,
					});
				},
			},
			{
				name: "retry loader",
				arrange: harness => {
					Object.assign(harness.ctx as unknown as { retryLoader: object | undefined }, { retryLoader: {} });
				},
			},
			{
				name: "plan mode",
				arrange: harness => {
					Object.assign(harness.ctx as unknown as { planModeEnabled: boolean }, { planModeEnabled: true });
				},
			},
			{
				name: "goal mode",
				arrange: harness => {
					Object.assign(harness.ctx as unknown as { goalModeEnabled: boolean }, { goalModeEnabled: true });
				},
			},
			{
				name: "loop mode",
				arrange: harness => {
					Object.assign(harness.ctx as unknown as { loopModeEnabled: boolean }, { loopModeEnabled: true });
				},
			},
			{
				name: "missing current user",
				arrange: harness => {
					harness.event.messages = [assistantMessage("Answer only", 2)];
				},
			},
		];

		for (const gate of cases) {
			const harness = createHarness();
			gate.arrange(harness);
			const controller = new NextPromptSuggestionController(harness.ctx, harness.generate);
			controllers.push(controller);

			controller.request(harness.event);

			expect({ gate: gate.name, calls: harness.generate.mock.calls.length }).toEqual({
				gate: gate.name,
				calls: 0,
			});
		}
	});

	it("arms the timeout before one invocation, aborts on deadline, and ignores a late result", async () => {
		const deferred = Promise.withResolvers<string | null>();
		const harness = createHarness(deferred.promise);
		const baselineTimers = vi.getTimerCount();
		let timersAtInvocation = -1;
		let requestSignal: AbortSignal | undefined;
		harness.generate.mockImplementation(options => {
			timersAtInvocation = vi.getTimerCount();
			requestSignal = options.signal;
			return deferred.promise;
		});
		const controller = new NextPromptSuggestionController(harness.ctx, harness.generate);
		controllers.push(controller);

		controller.request(harness.event);

		expect(timersAtInvocation).toBe(baselineTimers + 1);
		expect(harness.generate).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(NEXT_PROMPT_TIMEOUT_MS - 1);
		expect(requestSignal?.aborted).toBe(false);
		harness.clearNextPromptSuggestion.mockClear();
		harness.requestComponentRender.mockClear();
		vi.advanceTimersByTime(1);
		expect(requestSignal?.aborted).toBe(true);
		expect(harness.clearNextPromptSuggestion).toHaveBeenCalledTimes(1);
		expect(harness.requestComponentRender).toHaveBeenCalledWith(harness.editor);
		expect(harness.generate).toHaveBeenCalledTimes(1);

		deferred.resolve("Too late");
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.setNextPromptSuggestion).not.toHaveBeenCalled();
		expect(harness.generate).toHaveBeenCalledTimes(1);
	});

	it("expires the installed ghost from its installation time", async () => {
		const deferred = Promise.withResolvers<string | null>();
		const harness = createHarness(deferred.promise);
		const controller = new NextPromptSuggestionController(harness.ctx, harness.generate);
		controllers.push(controller);

		controller.request(harness.event);
		vi.advanceTimersByTime(NEXT_PROMPT_TIMEOUT_MS - 1);
		deferred.resolve("Expires later");
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.setNextPromptSuggestion).toHaveBeenCalledWith("Expires later");
		harness.clearNextPromptSuggestion.mockClear();
		harness.requestComponentRender.mockClear();

		vi.advanceTimersByTime(NEXT_PROMPT_EXPIRY_MS - 1);
		expect(harness.clearNextPromptSuggestion).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(harness.clearNextPromptSuggestion).toHaveBeenCalledTimes(1);
		expect(harness.requestComponentRender).toHaveBeenCalledWith(harness.editor);
		expect(harness.generate).toHaveBeenCalledTimes(1);
	});

	it("aborts invalidated work and repaints when discarding its late result", async () => {
		const deferred = Promise.withResolvers<string | null>();
		const harness = createHarness(deferred.promise);
		const controller = new NextPromptSuggestionController(harness.ctx, harness.generate);
		controllers.push(controller);

		controller.request(harness.event);
		const signal = harness.generate.mock.calls[0]?.[0].signal;
		harness.clearNextPromptSuggestion.mockClear();
		harness.requestComponentRender.mockClear();
		controller.invalidate();
		expect(signal?.aborted).toBe(true);
		expect(harness.clearNextPromptSuggestion).toHaveBeenCalledTimes(1);
		expect(harness.requestComponentRender).toHaveBeenCalledWith(harness.editor);
		harness.requestComponentRender.mockClear();

		deferred.resolve("Stale suggestion");
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.setNextPromptSuggestion).not.toHaveBeenCalled();
		expect(harness.requestComponentRender).toHaveBeenCalledWith(harness.editor);
		expect(harness.generate).toHaveBeenCalledTimes(1);
	});

	it("lets only the newest monotonic generation install a suggestion", async () => {
		const first = Promise.withResolvers<string | null>();
		const second = Promise.withResolvers<string | null>();
		const harness = createHarness(first.promise);
		harness.generate.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
		const controller = new NextPromptSuggestionController(harness.ctx, harness.generate);
		controllers.push(controller);

		controller.request(harness.event);
		const firstSignal = harness.generate.mock.calls[0]?.[0].signal;
		controller.request(harness.event);
		expect(firstSignal?.aborted).toBe(true);
		expect(harness.generate).toHaveBeenCalledTimes(2);

		second.resolve("Newest suggestion");
		await Promise.resolve();
		await Promise.resolve();
		first.resolve("Obsolete suggestion");
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.setNextPromptSuggestion).toHaveBeenCalledTimes(1);
		expect(harness.setNextPromptSuggestion).toHaveBeenCalledWith("Newest suggestion");
	});

	it("revalidates mutable gates and captured session or editor identities before delivery", async () => {
		const cases: Array<{
			name: string;
			arrange: (harness: GateHarness) => void;
		}> = [
			{
				name: "draft changed",
				arrange: harness => {
					harness.state.text = "new draft";
				},
			},
			{
				name: "session changed",
				arrange: harness => {
					Object.assign(harness.ctx as unknown as { session: AgentSession }, {
						session: {} as AgentSession,
					});
				},
			},
			{
				name: "editor changed",
				arrange: harness => {
					Object.assign(harness.ctx as unknown as { editor: InteractiveModeContext["editor"] }, {
						editor: { ...harness.editor } as unknown as InteractiveModeContext["editor"],
					});
				},
			},
		];

		for (const gate of cases) {
			const deferred = Promise.withResolvers<string | null>();
			const harness = createHarness(deferred.promise);
			const controller = new NextPromptSuggestionController(harness.ctx, harness.generate);
			controllers.push(controller);
			controller.request(harness.event);
			gate.arrange(harness);
			harness.clearNextPromptSuggestion.mockClear();
			harness.requestComponentRender.mockClear();

			deferred.resolve("Stale after state change");
			await Promise.resolve();
			await Promise.resolve();

			expect({ gate: gate.name, installs: harness.setNextPromptSuggestion.mock.calls.length }).toEqual({
				gate: gate.name,
				installs: 0,
			});
			expect(harness.clearNextPromptSuggestion).toHaveBeenCalledTimes(1);
			expect(harness.requestComponentRender).toHaveBeenCalledWith(harness.editor);
		}
	});

	it("does not retry after generator rejection", async () => {
		const deferred = Promise.withResolvers<string | null>();
		const harness = createHarness(deferred.promise);
		const controller = new NextPromptSuggestionController(harness.ctx, harness.generate);
		controllers.push(controller);
		controller.request(harness.event);
		harness.clearNextPromptSuggestion.mockClear();
		harness.requestComponentRender.mockClear();

		deferred.reject(new Error("generation failed"));
		await Promise.resolve();
		await Promise.resolve();

		expect(harness.generate).toHaveBeenCalledTimes(1);
		expect(harness.setNextPromptSuggestion).not.toHaveBeenCalled();
		expect(harness.clearNextPromptSuggestion).toHaveBeenCalledTimes(1);
		expect(harness.requestComponentRender).toHaveBeenCalledWith(harness.editor);
	});

	it("disposes pending work and timers idempotently", async () => {
		const deferred = Promise.withResolvers<string | null>();
		const harness = createHarness(deferred.promise);
		const baselineTimers = vi.getTimerCount();
		const controller = new NextPromptSuggestionController(harness.ctx, harness.generate);
		controllers.push(controller);
		controller.request(harness.event);
		const signal = harness.generate.mock.calls[0]?.[0].signal;
		expect(vi.getTimerCount()).toBe(baselineTimers + 1);
		harness.clearNextPromptSuggestion.mockClear();
		harness.requestComponentRender.mockClear();

		controller.dispose();
		controller.dispose();

		expect(signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(baselineTimers);
		expect(harness.clearNextPromptSuggestion).toHaveBeenCalledTimes(1);
		expect(harness.requestComponentRender).toHaveBeenCalledTimes(1);
		harness.requestComponentRender.mockClear();
		deferred.resolve("Disposed suggestion");
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.setNextPromptSuggestion).not.toHaveBeenCalled();
		expect(harness.requestComponentRender).not.toHaveBeenCalled();
	});

	it("generates during agent_end settlement without changing the public post-prompt work signal", async () => {
		vi.useRealTimers();
		const harness = await createSessionLifecycleHarness();
		sessionLifecycleHarnesses.push(harness);

		const observedPostPromptWork = await emitTerminalAgentEnd(harness);

		expect(observedPostPromptWork).toEqual([true]);
		expect(harness.generate).toHaveBeenCalledTimes(1);
		await harness.session.waitForIdle();
	});

	it("keeps terminal suggestion generation blocked while external post-prompt work is tracked", async () => {
		vi.useRealTimers();
		const harness = await createSessionLifecycleHarness();
		sessionLifecycleHarnesses.push(harness);
		const externalPostPromptWork = Promise.withResolvers<void>();
		harness.session.trackPostPromptTaskForTests(externalPostPromptWork.promise);

		const observedPostPromptWork = await emitTerminalAgentEnd(harness);
		let idle = false;
		void harness.session.waitForIdle().then(() => {
			idle = true;
		});
		await Promise.resolve();

		expect(observedPostPromptWork).toEqual([true]);
		expect(harness.generate).not.toHaveBeenCalled();
		expect(idle).toBe(false);

		externalPostPromptWork.resolve();
		await harness.session.waitForIdle();

		expect(harness.generate).not.toHaveBeenCalled();
	});
});

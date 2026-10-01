import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { NextPromptSuggestionController } from "@oh-my-pi/pi-coding-agent/modes/controllers/next-prompt-suggestion-controller";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Loader, TERMINAL } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

/**
 * Models the loader lifecycle InteractiveMode owns: `agent_start` creates the
 * loader via `ensureLoadingAnimation`; `agent_end` stops and drops it. The
 * streaming getter is backed by mutable flags the tests drive directly.
 */
function createContext(options?: { flushPendingModelSwitch?: () => Promise<void> }) {
	const streamState = { isStreaming: false };
	let nextPromptSuggestionRevision = 0;
	const invalidateNextPromptSuggestion = vi.fn(() => {
		nextPromptSuggestionRevision++;
	});
	const requestNextPromptSuggestion = vi.fn();
	const nextPromptSuggestionController = {
		get revision() {
			return nextPromptSuggestionRevision;
		},
		invalidate: invalidateNextPromptSuggestion,
		request: requestNextPromptSuggestion,
	} as unknown as NextPromptSuggestionController;
	const ctx = createInteractiveModeContext({
		nextPromptSuggestionController,
		flushPendingModelSwitch: vi.fn(options?.flushPendingModelSwitch ?? (async () => {})),
		session: {
			get isStreaming() {
				return streamState.isStreaming;
			},
		},
		viewSession: {
			isCompacting: false,
			getLastAssistantMessage: () => undefined,
		},
	});
	const loader = new Loader(
		ctx.ui,
		text => text,
		text => text,
	);
	vi.spyOn(loader, "stop");
	const ensureLoadingAnimation = vi.fn(() => {
		ctx.loadingAnimation ??= loader;
	});
	ctx.ensureLoadingAnimation = ensureLoadingAnimation;
	return {
		ctx,
		streamState,
		loader,
		invalidateNextPromptSuggestion,
		requestNextPromptSuggestion,
		ensureLoadingAnimation,
	};
}

const AGENT_START = { type: "agent_start" } as unknown as AgentSessionEvent;
const AGENT_END = { type: "agent_end", isTerminal: true, messages: [] } as unknown as AgentSessionEvent;

describe("EventController superseded agent_end", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		resetSettingsForTest();
	});

	it("keeps the loader alive when a stale agent_end lands after the resumed turn's agent_start", async () => {
		const { ctx, streamState, loader } = createContext();
		const controller = new EventController(ctx);

		// Turn 1 begins and creates the loader.
		await controller.handleEvent(AGENT_START);
		expect(ctx.loadingAnimation).toBeDefined();

		// User abort of a queued steer: the resumed turn's agent_start arrives and
		// the agent is streaming again. The interrupted turn's agent_end is still in
		// flight through the async event pipeline.
		streamState.isStreaming = true;
		await controller.handleEvent(AGENT_START);

		// The interrupted turn's agent_end finally propagates. Because the agent is
		// already streaming the resumed turn, it must not tear down the live loader —
		// otherwise "Working…" vanishes while the agent keeps running.
		await controller.handleEvent(AGENT_END);

		expect(loader.stop).not.toHaveBeenCalled();
		expect(ctx.loadingAnimation).toBeDefined();
		expect(TERMINAL.sendNotification).not.toHaveBeenCalled();
	});

	it("tears the loader down on the live turn's own final agent_end", async () => {
		const { ctx, streamState, loader } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		expect(ctx.loadingAnimation).toBeDefined();

		// A genuine turn boundary: the agent is no longer streaming, so the guard
		// must not fire and the loader is torn down as before.
		streamState.isStreaming = false;
		await controller.handleEvent(AGENT_END);

		expect(loader.stop).toHaveBeenCalledTimes(1);
		expect(ctx.loadingAnimation).toBeUndefined();
	});

	it("invalidates before the agent-start visual work and requests only after a terminal end finishes", async () => {
		const finish = Promise.withResolvers<void>();
		const { ctx, invalidateNextPromptSuggestion, requestNextPromptSuggestion, ensureLoadingAnimation } =
			createContext({
				flushPendingModelSwitch: () => finish.promise,
			});
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);

		expect(invalidateNextPromptSuggestion).toHaveBeenCalledTimes(1);
		expect(invalidateNextPromptSuggestion.mock.invocationCallOrder[0]!).toBeLessThan(
			ensureLoadingAnimation.mock.invocationCallOrder[0]!,
		);
		invalidateNextPromptSuggestion.mockClear();

		const ending = controller.handleEvent(AGENT_END);
		await Promise.resolve();
		expect(requestNextPromptSuggestion).not.toHaveBeenCalled();

		finish.resolve();
		await ending;

		expect(requestNextPromptSuggestion).toHaveBeenCalledTimes(1);
		expect(requestNextPromptSuggestion).toHaveBeenCalledWith(AGENT_END);
	});

	it("does not request after an agent_start supersedes an agent_end while it awaits teardown", async () => {
		const finish = Promise.withResolvers<void>();
		const { ctx, invalidateNextPromptSuggestion, requestNextPromptSuggestion } = createContext({
			flushPendingModelSwitch: () => finish.promise,
		});
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		invalidateNextPromptSuggestion.mockClear();

		const ending = controller.handleEvent(AGENT_END);
		await Promise.resolve();
		await controller.handleEvent(AGENT_START);
		finish.resolve();
		await ending;

		expect(invalidateNextPromptSuggestion).toHaveBeenCalledTimes(1);
		expect(requestNextPromptSuggestion).not.toHaveBeenCalled();
	});

	it("does not request when the suggestion controller is invalidated while terminal teardown is pending", async () => {
		const finish = Promise.withResolvers<void>();
		const { ctx, invalidateNextPromptSuggestion, requestNextPromptSuggestion } = createContext({
			flushPendingModelSwitch: () => finish.promise,
		});
		const controller = new EventController(ctx);

		const ending = controller.handleEvent(AGENT_END);
		await Promise.resolve();
		invalidateNextPromptSuggestion();
		finish.resolve();
		await ending;

		expect(requestNextPromptSuggestion).not.toHaveBeenCalled();
	});

	it("preserves a shutdown requested during terminal teardown even when the suggestion is invalidated", async () => {
		const finish = Promise.withResolvers<void>();
		const { ctx, invalidateNextPromptSuggestion, requestNextPromptSuggestion } = createContext({
			flushPendingModelSwitch: () => finish.promise,
		});
		const shutdown = vi.fn();
		ctx.requestShutdown = shutdown;
		const controller = new EventController(ctx);

		const ending = controller.handleEvent(AGENT_END);
		await Promise.resolve();
		ctx.shutdownRequested = true;
		invalidateNextPromptSuggestion();
		finish.resolve();
		await ending;

		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(requestNextPromptSuggestion).not.toHaveBeenCalled();
	});

	it("flushes queued command panels at a non-terminal settle", async () => {
		const { ctx, streamState } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		// An async fan-out settles the loop without ending the run. `isStreaming`
		// is already false here, so any command issued now mounts immediately —
		// panels queued during the turn have to mount too, or they render out of
		// order whenever the terminal settle finally lands.
		streamState.isStreaming = false;
		await controller.handleEvent({
			type: "agent_end",
			messages: [],
			isTerminal: false,
		} as unknown as AgentSessionEvent);

		expect(ctx.flushPendingModelSwitch).toHaveBeenCalled();
		expect(ctx.flushPendingCommandOutput).toHaveBeenCalled();
	});
});

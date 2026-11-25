import { describe, expect, test } from "bun:test";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

async function createHost() {
	let actions: ExtensionContextActions | undefined;
	const state = {
		streaming: false,
		queued: 0,
		runActive: false,
		closed: false,
		admitted: 0,
		pendingSubmission: false,
		settleAdmitted: undefined as (() => void) | undefined,
	};
	const errors: string[] = [];
	const runner = {
		initialize(
			_actions: ExtensionActions,
			contextActions: ExtensionContextActions,
			_commandActions?: ExtensionCommandContextActions,
			_uiContext?: ExtensionUIContext,
		) {
			actions = contextActions;
		},
		getComposerShapes: () => [],
		onError() {},
		async emit() {},
	};
	// Own data properties shadow the mode's accessors (which read private state this fake never has).
	const host = Object.create(
		InteractiveMode.prototype,
		Object.getOwnPropertyDescriptors({
			shutdownRequested: false,
			syncComposerShape() {},
			syncExtensionLinks() {},
			session: {
				extensionRunner: runner,
				get isStreaming() {
					return state.streaming;
				},
				get queuedMessageCount() {
					return state.queued;
				},
				get hasAdmittedSubmission() {
					return state.admitted > 0;
				},
				get isRunActive() {
					return state.runActive;
				},
				async waitForIdle() {},
				waitForAdmittedSubmissions() {
					if (state.admitted === 0) return Promise.resolve();
					const settled = Promise.withResolvers<void>();
					state.settleAdmitted = settled.resolve;
					return settled.promise;
				},
			},
			hasPendingSubmission: () => state.pendingSubmission,
			async shutdown() {
				state.closed = true;
			},
			showError(message: string) {
				errors.push(message);
			},
			setToolUIContext() {},
			composer: { setText() {}, insertText() {}, text: () => "" },
			setWorkingMessage() {},
			toolOutputExpanded: false,
			setToolsExpanded() {},
			get isShuttingDown() {
				return state.closed;
			},
		}),
	) as InteractiveModeContext;
	const controller = new ExtensionUiController(host);
	await controller.initHooksAndCustomTools();
	if (!actions) throw new Error("Extension runtime was not initialized");
	return { host, actions, state, errors };
}

async function flushShutdown() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("interactive extension shutdown", () => {
	test("an idle background request closes the initialized host without terminal input", async () => {
		const { actions, state, errors } = await createHost();
		actions.shutdown();
		await flushShutdown();
		expect(state.closed).toBe(true);
		expect(errors).toEqual([]);
	});

	test("keeps the request pending until streaming, queued input and the open run settle", async () => {
		const { host, actions, state, errors } = await createHost();
		state.streaming = true;
		actions.shutdown();
		await flushShutdown();
		expect(state.closed).toBe(false);

		state.streaming = false;
		state.queued = 1;
		await host.checkShutdownRequested();
		expect(state.closed).toBe(false);

		state.queued = 0;
		state.runActive = true;
		await host.checkShutdownRequested();
		expect(state.closed).toBe(false);

		state.runActive = false;
		host.requestShutdown();
		await flushShutdown();
		expect(state.closed).toBe(true);
		expect(errors).toEqual([]);
	});

	test("waits for an admitted extension submission and re-evaluates the turn it started", async () => {
		const { host, actions, state, errors } = await createHost();
		state.admitted = 1;
		actions.shutdown();
		await flushShutdown();
		expect(state.closed).toBe(false);

		// The submission dispatches a turn as it settles: still not a shutdown boundary.
		state.streaming = true;
		state.admitted = 0;
		state.settleAdmitted?.();
		await flushShutdown();
		expect(state.closed).toBe(false);

		state.streaming = false;
		host.requestShutdown();
		await flushShutdown();
		expect(state.closed).toBe(true);
		expect(errors).toEqual([]);
	});

	test("keeps the request pending while a foreground submission is still being prepared", async () => {
		const { host, actions, state, errors } = await createHost();
		state.pendingSubmission = true;
		actions.shutdown();
		await flushShutdown();
		expect(state.closed).toBe(false);

		state.pendingSubmission = false;
		await host.checkShutdownRequested();
		expect(state.closed).toBe(true);
		expect(errors).toEqual([]);
	});
});

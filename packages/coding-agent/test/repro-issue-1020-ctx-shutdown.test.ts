import { describe, expect, test } from "bun:test";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Container } from "@oh-my-pi/pi-tui";

/**
 * Issue #1020: `ctx.shutdown()` is a no-op in interactive mode.
 *
 * The `contextActions.shutdown` handler wired by
 * `ExtensionUiController.initializeHookRunner` is supposed to flip
 * `InteractiveMode.shutdownRequested` so the main loop's
 * `checkShutdownRequested()` can drive the graceful shutdown path.
 */
describe("issue #1020 - ctx.shutdown() in interactive mode", () => {
	test("contextActions.shutdown sets InteractiveModeContext.shutdownRequested", () => {
		let capturedContextActions: ExtensionContextActions | undefined;

		const fakeExtensionRunner = {
			initialize(
				_actions: ExtensionActions,
				contextActions: ExtensionContextActions,
				_commandContextActions?: ExtensionCommandContextActions,
				_uiContext?: ExtensionUIContext,
			): void {
				capturedContextActions = contextActions;
			},
			getComposerShapes: () => [],
		};

		const ctxStub = {
			shutdownRequested: false,
			syncComposerShape: () => {},
			session: {
				extensionRunner: fakeExtensionRunner,
				// other session fields are only touched lazily by other actions; we
				// only invoke `shutdown`, so leave them out.
			},
		} as unknown as InteractiveModeContext;

		const controller = new ExtensionUiController(ctxStub);
		controller.initializeHookRunner({} as ExtensionUIContext, false);

		expect(capturedContextActions).toBeDefined();
		expect(typeof capturedContextActions?.shutdown).toBe("function");

		capturedContextActions?.shutdown();

		expect(ctxStub.shutdownRequested).toBe(true);
	});

	test("initHooksAndCustomTools wires shutdown to set shutdownRequested", async () => {
		let capturedContextActions: ExtensionContextActions | undefined;

		const fakeExtensionRunner = {
			initialize(
				_actions: ExtensionActions,
				contextActions: ExtensionContextActions,
				_commandContextActions?: ExtensionCommandContextActions,
				_uiContext?: ExtensionUIContext,
			): void {
				capturedContextActions = contextActions;
			},
			onError(_handler: (error: unknown) => void): void {},
			getComposerShapes: () => [],
			async emit(_event: unknown): Promise<void> {},
		};

		const ctxStub = {
			shutdownRequested: false,
			syncComposerShape: () => {},
			session: {
				extensionRunner: fakeExtensionRunner,
			},
			setToolUIContext: () => {},
			editor: {
				setText: () => {},
				handleInput: () => {},
				getText: () => "",
			},
			setWorkingMessage: () => {},
			setRightInfo: (_blocks?: unknown) => {},
			setEditorComponent: () => {},
			toolOutputExpanded: false,
			setToolsExpanded: () => {},
			hookWidgetContainerAbove: new Container(),
			hookWidgetContainerBelow: new Container(),
			ui: { requestRender: () => {} },
		} as unknown as InteractiveModeContext;

		const controller = new ExtensionUiController(ctxStub);
		await controller.initHooksAndCustomTools();

		expect(capturedContextActions).toBeDefined();
		expect(typeof capturedContextActions?.shutdown).toBe("function");

		capturedContextActions?.shutdown();

		expect(ctxStub.shutdownRequested).toBe(true);
	});

	test("reloadHooksAndCustomTools tears down extensions before replaying session_start", async () => {
		const emittedEvents: string[] = [];
		let initializeCount = 0;

		const fakeExtensionRunner = {
			initialize(
				_actions: ExtensionActions,
				_contextActions: ExtensionContextActions,
				_commandContextActions?: ExtensionCommandContextActions,
				_uiContext?: ExtensionUIContext,
			): void {
				initializeCount += 1;
			},
			onError(_handler: (error: unknown) => void): void {},
			disposeFileFallbacks(): void {},
			clearManagedTimers(): void {},
			getComposerShapes(): readonly [] {
				return [];
			},
			hasHandlers(event: string): boolean {
				return event === "session_shutdown";
			},
			async emit(event: { type: string }): Promise<void> {
				emittedEvents.push(event.type);
			},
		};

		const ctxStub = {
			session: {
				extensionRunner: fakeExtensionRunner,
			},
			setToolUIContext: () => {},
			editor: {
				setText: () => {},
				handleInput: () => {},
				getText: () => "",
			},
			setWorkingMessage: () => {},
			setRightInfo: (_blocks?: unknown) => {},
			setEditorComponent: () => {},
			syncComposerShape: () => {},
			syncEditorSpelling: () => {},
			toolOutputExpanded: false,
			setToolsExpanded: () => {},
			hookWidgetContainerAbove: new Container(),
			hookWidgetContainerBelow: new Container(),
			ui: { requestRender: () => {} },
		} as unknown as InteractiveModeContext;

		const controller = new ExtensionUiController(ctxStub);
		await controller.reloadHooksAndCustomTools();

		expect(initializeCount).toBe(1);
		expect(emittedEvents).toEqual(["session_shutdown", "session_start"]);
	});
});

/**
 * Regression tests for the extension compaction contract (issue #12041).
 *
 * `AgentSession.compact()` reports a failed compaction through
 * `CompactOptions.onError` and then rethrows. `ctx.compact()` used to await
 * that rejection without a catch, so extensions that fire `ctx.compact()`
 * without awaiting it produced an unhandled rejection that tore down RPC
 * hosts. The handler must report the failure through the extension's error
 * path and resolve instead of rejecting.
 *
 * The contract is exercised through the contexts an extension actually
 * receives — the TUI event and command contexts, the headless (print/RPC)
 * event and command contexts, and the runner-less session command context —
 * because every one of them is a separate call site that can regress on its
 * own.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import { Container } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { getThemeByName, setThemeInstance, type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { runExtensionCompact } from "../src/extensibility/extensions/compact-handler";
import type { CustomCommandContext } from "../src/extensibility/custom-commands/types";
import type {
	CompactOptions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
} from "../src/extensibility/extensions/types";
import { CommandController } from "../src/modes/controllers/command-controller";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import { initializeExtensions } from "../src/modes/runtime-init";
import type { InteractiveModeContext } from "../src/modes/types";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** Shape of the log records the sink below captures. */
interface CapturedLog {
	level: string;
	message: string;
	context: Record<string, unknown> | undefined;
}

/** The action sets an extension host hands to its extension runner. */
interface ExtensionContexts {
	contextActions: ExtensionContextActions;
	commandActions: ExtensionCommandContextActions;
}

describe("runExtensionCompact", () => {
	it("reports a failed compaction through onError and resolves", async () => {
		const errors: Error[] = [];
		const session = {
			compact: async (): Promise<void> => {
				throw new Error("Nothing to compact (session too small)");
			},
		};

		await expect(
			runExtensionCompact(session, {
				onError: error => errors.push(error),
			}),
		).resolves.toBeUndefined();

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("Nothing to compact (session too small)");
	});

	it("reports the failure once when the session already called onError", async () => {
		const errors: Error[] = [];
		const failure = new Error("Nothing to compact (session too small)");
		const session = {
			compact: async (_instructions?: string, options?: CompactOptions): Promise<void> => {
				// Mirrors `session-maintenance.ts`: report, then rethrow.
				options?.onError?.(failure);
				throw failure;
			},
		};

		await expect(
			runExtensionCompact(session, {
				onError: error => errors.push(error),
			}),
		).resolves.toBeUndefined();

		expect(errors).toHaveLength(1);
		expect(errors[0]).toBe(failure);
	});

	it("forwards instructions and options to the session", async () => {
		const calls: Array<[string | undefined, CompactOptions | undefined]> = [];
		const session = {
			compact: async (instructions?: string, options?: CompactOptions): Promise<void> => {
				calls.push([instructions, options]);
			},
		};

		await runExtensionCompact(session, { mode: "soft" });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBeUndefined();
		expect(calls[0]?.[1]?.mode).toBe("soft");
	});

	it("resolves instead of rejecting when the extension supplies no onError callback", async () => {
		const session = {
			compact: async (): Promise<void> => {
				throw new Error("Nothing to compact (session too small)");
			},
		};

		// An extension that fires `ctx.compact()` without awaiting it must not
		// leave a rejected promise behind — that is the unhandled rejection
		// that kills RPC hosts.
		const outcome = await runExtensionCompact(session, undefined).then(
			() => "resolved" as const,
			() => "rejected" as const,
		);

		expect(outcome).toBe("resolved");
	});

	it("logs a throwing extension onError instead of dropping it", async () => {
		const events: CapturedLog[] = [];
		const dispose = logger.registerLogSink(event => {
			events.push(event);
		});
		const session = {
			compact: async (): Promise<void> => {
				throw new Error("Nothing to compact (session too small)");
			},
		};

		try {
			const outcome = await runExtensionCompact(session, {
				onError: () => {
					throw new Error("extension handler exploded");
				},
			}).then(
				() => "resolved" as const,
				() => "rejected" as const,
			);

			// The extension's own handler threw; the promise must still resolve.
			expect(outcome).toBe("resolved");
		} finally {
			dispose();
		}

		const warnings = events.filter(event => event.level === "warn");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe("Extension compaction onError threw");
		expect(warnings[0]?.context?.error).toBe("extension handler exploded");
	});

	it("logs a throwing extension onError when the session reported the failure first", async () => {
		const events: CapturedLog[] = [];
		const dispose = logger.registerLogSink(event => {
			events.push(event);
		});
		const failure = new Error("Nothing to compact (session too small)");
		const session = {
			compact: async (_instructions?: string, options?: CompactOptions): Promise<void> => {
				// Mirrors `session-maintenance.ts`: report, then rethrow.
				options?.onError?.(failure);
				throw failure;
			},
		};

		try {
			const outcome = await runExtensionCompact(session, {
				onError: () => {
					throw new Error("extension handler exploded");
				},
			}).then(
				() => "resolved" as const,
				() => "rejected" as const,
			);

			expect(outcome).toBe("resolved");
		} finally {
			dispose();
		}

		const warnings = events.filter(event => event.level === "warn");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe("Extension compaction onError threw");
	});
});

/**
 * The contract every extension-facing `ctx.compact()` context owes the
 * extension: the returned promise resolves — a rejection there becomes an
 * unhandled rejection when the extension fires `ctx.compact()` without
 * awaiting it — and `onError` fires exactly once for the failure.
 */
async function expectFailureReportedOnce(
	compact: (options: CompactOptions) => Promise<unknown>,
	expectedMessage: string,
): Promise<void> {
	const errors: Error[] = [];
	const outcome = await compact({ onError: error => errors.push(error) }).then(
		() => "resolved" as const,
		() => "rejected" as const,
	);

	expect(outcome).toBe("resolved");
	expect(errors).toHaveLength(1);
	expect(errors[0]?.message).toBe(expectedMessage);
}

/**
 * Wire the interactive host the way the TUI does: the real
 * `ExtensionUiController` over a real `CommandController`, so an extension
 * compaction travels controller → command controller → session exactly as it
 * does in the app.
 */
function makeTuiHost(compact: (instructions?: string, options?: CompactOptions) => Promise<unknown>) {
	let contexts: ExtensionContexts | undefined;
	const extensionRunner = {
		initialize: (
			_actions: unknown,
			contextActions: ExtensionContextActions,
			commandActions: ExtensionCommandContextActions,
		): void => {
			contexts = { contextActions, commandActions };
		},
		onError: vi.fn(),
		emit: vi.fn(async () => {}),
		getComposerShapes: () => [],
		getAllRegisteredTools: () => [],
	};
	const showError = vi.fn();
	const ctx = {
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		statusContainer: new Container(),
		keybindings: KeybindingsManager.inMemory(),
		session: {
			extensionRunner,
			compact,
			agent: { waitForIdle: async () => {} },
			model: undefined,
			isStreaming: false,
			queuedMessageCount: 0,
			systemPrompt: "system",
			thinkingLevel: "off",
			serviceTierByFamily: undefined,
			getEnabledToolNames: () => [],
			getAllToolInfos: () => [],
			getContextUsage: () => undefined,
			runEphemeralTurn: vi.fn(),
			setUsageFallbackConfirmer: vi.fn(),
		},
		sessionManager: {
			getSessionName: () => "session",
			getCwd: () => process.cwd(),
			appendCustomEntry: vi.fn(),
			appendLabelChange: vi.fn(),
		},
		setToolUIContext: vi.fn(),
		addAutocompleteProvider: vi.fn(),
		syncComposerShape: vi.fn(),
		getEditorComponent: () => undefined,
		setEditorComponent: vi.fn(),
		toolOutputExpanded: false,
		setToolsExpanded: vi.fn(),
		showStatus: vi.fn(),
		present: vi.fn(),
		rebuildChatFromMessages: vi.fn(),
		statusLine: { invalidate: vi.fn() },
		flushCompactionQueue: vi.fn(async () => undefined),
		showError,
		maintenanceInterruptKey: () => "esc",
		interruptFromPointer: vi.fn(),
		settings: Settings.isolated({ "display.collapseCompacted": true }),
	} as unknown as InteractiveModeContext;

	const commandController = new CommandController(ctx);
	// The interactive host runs an extension compaction through the command
	// controller, which owns the loader and the failure reporting.
	const host = ctx as unknown as { executeCompaction: InteractiveModeContext["executeCompaction"] };
	host.executeCompaction = (instructionsOrOptions, isAuto) =>
		commandController.executeCompaction(instructionsOrOptions, isAuto);

	const controller = new ExtensionUiController(ctx);
	return {
		controller,
		showError,
		contexts: (): ExtensionContexts => {
			if (!contexts) throw new Error("Extension contexts were never initialized");
			return contexts;
		},
	};
}

describe("TUI extension compaction contexts", () => {
	let priorTheme: Theme | undefined;

	beforeAll(async () => {
		// The compacting loader colorizes through the active theme on construction.
		priorTheme = theme;
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("Expected dark theme");
		setThemeInstance(dark);
	});

	afterAll(() => {
		if (priorTheme) setThemeInstance(priorTheme);
	});

	it("reports a failed compaction through onError exactly once in the event context", async () => {
		const host = makeTuiHost(async () => {
			throw new Error("Nothing to compact (session too small)");
		});
		await host.controller.initHooksAndCustomTools();

		const { contextActions } = host.contexts();
		await expectFailureReportedOnce(contextActions.compact, "Nothing to compact (session too small)");
	});

	it("reports a compaction rejected before it starts through onError exactly once in the command context", async () => {
		// `SessionMaintenance.compact` rejects with "Compaction already in
		// progress" before it reaches the report that invokes the callback, so
		// the command context has to deliver that failure itself.
		const host = makeTuiHost(async () => {
			throw new Error("Compaction already in progress");
		});
		await host.controller.initHooksAndCustomTools();

		const { commandActions } = host.contexts();
		await expectFailureReportedOnce(commandActions.compact, "Compaction already in progress");
		// The failure is still surfaced in the TUI.
		expect(host.showError).toHaveBeenCalledWith("Compaction failed: Compaction already in progress");
	});

	it("does not report a session-reported compaction failure twice in the command context", async () => {
		const failure = new Error("Nothing to compact (session too small)");
		const host = makeTuiHost(async (_instructions, options) => {
			// Mirrors `session-maintenance.ts`: report, then rethrow.
			options?.onError?.(failure);
			throw failure;
		});
		await host.controller.initHooksAndCustomTools();

		const { commandActions } = host.contexts();
		await expectFailureReportedOnce(commandActions.compact, "Nothing to compact (session too small)");
	});
});

describe("headless extension compaction contexts", () => {
	it("reports a failed compaction through onError exactly once in the event and command contexts", async () => {
		let contexts: ExtensionContexts | undefined;
		const session = {
			extensionRunner: {
				initialize: (
					_actions: unknown,
					contextActions: ExtensionContextActions,
					commandActions: ExtensionCommandContextActions,
				): void => {
					contexts = { contextActions, commandActions };
				},
				onError: vi.fn(),
				emit: vi.fn(async () => {}),
				getRegisteredCommands: () => [],
			},
			compact: async (): Promise<void> => {
				throw new Error("Nothing to compact (session too small)");
			},
			customCommands: [],
			skills: [],
		};

		await initializeExtensions(session as unknown as AgentSession, {
			reportSendError: vi.fn(),
			reportRuntimeError: vi.fn(),
		});

		if (!contexts) throw new Error("Extension contexts were never initialized");
		await expectFailureReportedOnce(contexts.contextActions.compact, "Nothing to compact (session too small)");
		await expectFailureReportedOnce(contexts.commandActions.compact, "Nothing to compact (session too small)");
	});
});

describe("runner-less session command context", () => {
	it("reports a failed compaction through onError exactly once", async () => {
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const errors: Error[] = [];
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		// A hand-constructed session has no extension runner, so its custom
		// commands receive the runner-less command context.
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			memoryEnabled: false,
			customCommands: [
				{
					path: "/tmp/compact-probe.ts",
					resolvedPath: "/tmp/compact-probe.ts",
					source: "bundled",
					command: {
						name: "compact-probe",
						description: "Report a failed compaction",
						execute: async (_args, ctx) => {
							// The runner-less command context carries `compact`; the
							// hook-facing command type omits it.
							const commandCtx = ctx as CustomCommandContext & {
								compact: (options?: CompactOptions) => Promise<void>;
							};
							await commandCtx.compact({ onError: error => errors.push(error) });
							return undefined;
						},
					},
				},
			],
		});

		try {
			vi.spyOn(session, "compact").mockRejectedValue(new Error("Compaction already in progress"));
			await session.prompt("/compact-probe");
		} finally {
			await session.dispose();
			authStorage.close();
		}

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("Compaction already in progress");
	});
});

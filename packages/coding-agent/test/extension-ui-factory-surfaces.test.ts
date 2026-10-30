/**
 * What a `ctx.ui` factory is handed besides its theme — the TUI, the keybindings, the provider an
 * autocomplete factory wraps — is the host's own, and the host keeps using it after the session
 * that was handed it has gone. Each test lets an extension do what it can with what it was handed,
 * disposes or retires its session, and then drives the host the way the next session's user does.
 * The last group checks that a handed context reads every member the host can change when it is
 * asked for, not once when the context was made.
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	handLocalProtocolOptions,
	handUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/context-surfaces";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus, extensionCallbackScope } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { type AutocompleteProvider, type Component, Container, TUI } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { bindInputScope } from "@oh-my-pi/pi-tui/tools/renderer-scope";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

beforeAll(async () => {
	await initTheme();
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A real session in interactive mode, with an extension runner whose `ctx.ui` the test holds. */
async function interactiveSession() {
	resetSettingsForTest();
	const dir = TempDir.createSync("@ui-factory-surfaces-");
	await Settings.init({ inMemory: true, cwd: dir.path() });
	const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	const registry = new ModelRegistry(auth);
	const model = registry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("the bundled catalog has no claude-sonnet-4-5");
	const owner = new ExtensionRuntime();
	const sessionManager = SessionManager.inMemory(dir.path());
	const runner = new ExtensionRunner([], owner, dir.path(), sessionManager, registry);
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry: registry,
		extensionRunner: runner,
	});
	const mode = new InteractiveMode(session, "test");
	// InteractiveMode implements the controller's hooks; its declared context also lists private wiring.
	const controller = new ExtensionUiController(mode as unknown as InteractiveModeContext);
	const hostUI: ExtensionUIContext = {
		...runner.getUIContext(),
		setWidget: controller.setHookWidget.bind(controller),
		setEditorComponent: mode.setEditorComponent.bind(mode),
		addAutocompleteProvider: mode.addAutocompleteProvider.bind(mode),
		custom: controller.showHookCustom.bind(controller),
	};
	const ui = runner.handedUIContext(hostUI);
	cleanups.push(async () => {
		mode.stop();
		await session.dispose();
		auth.close();
		dir.removeSync();
		resetSettingsForTest();
	});
	return { dir, owner, runner, session, mode, ui };
}

/** Three microtask turns: what an overlay dialog's mount takes after `custom()` returns. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 3; turn++) await Promise.resolve();
}

describe("what a ui factory is handed", () => {
	test("the TUI is the session's: a key listener it added hears nothing after the session is disposed", async () => {
		const h = await interactiveSession();
		const seen: string[] = [];
		let handedHost = true;
		let refused = "";
		h.ui.setWidget("listener", tui => {
			handedHost = tui === h.mode.ui;
			tui.addInputListener(key => {
				seen.push(key);
				return undefined;
			});
			try {
				tui.injectDebugInput("forged");
			} catch (error) {
				refused = String(error);
			}
			return { render: () => ["listening"], invalidate() {} };
		});
		await h.session.dispose();
		h.mode.ui.injectDebugInput("after-dispose");

		expect(seen).toEqual([]);
		expect(handedHost).toBe(false);
		expect(refused).toContain("injectDebugInput()");
	});

	test("the keybindings are a copy: an editor factory's change survives in neither the host nor its restored editor", async () => {
		const h = await interactiveSession();
		const refresh = spyOn(h.mode, "refreshSlashCommandState").mockResolvedValue();
		cleanups.push(() => refresh.mockRestore());
		const before = h.mode.keybindings.getKeys("tui.input.submit");
		let handedHost = true;
		h.ui.setEditorComponent((_tui, editorTheme, keybindings) => {
			handedHost = keybindings === h.mode.keybindings;
			keybindings.setUserBindings({ "tui.input.submit": "ctrl+g" });
			return new CustomEditor(editorTheme);
		});
		const whileInstalled = h.mode.keybindings.getKeys("tui.input.submit");
		await h.session.dispose();
		h.mode.ui.renderNow();

		expect(handedHost).toBe(false);
		expect(whileInstalled).toEqual(before);
		expect(h.mode.keybindings.getKeys("tui.input.submit")).toEqual(before);
	});

	test("the provider an autocomplete factory wraps is the session's: the host's fallback stays the host's", async () => {
		const h = await interactiveSession();
		const seen: string[] = [];
		const installed: AutocompleteProvider[] = [];
		const install = h.mode.editor.setAutocompleteProvider.bind(h.mode.editor);
		const spy = spyOn(h.mode.editor, "setAutocompleteProvider").mockImplementation(provider => {
			installed.push(provider);
			install(provider);
		});
		cleanups.push(() => spy.mockRestore());
		await h.mode.refreshSlashCommandState(h.dir.path());
		h.ui.addAutocompleteProvider(base => {
			base.getSuggestions = async lines => {
				seen.push(lines.join("\n"));
				return null;
			};
			return base;
		});
		const active = installed.at(-1);
		if (!active) throw new Error("no autocomplete provider was mounted");
		await h.session.dispose();
		await active.getSuggestions(["next-session-draft"], 0, 18);

		expect(seen).toEqual([]);
	});

	test("an async handleInput a key started is work its session owns until it ends, dispose included", async () => {
		const h = await interactiveSession();
		const started = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		const pending = h.ui.custom<undefined>(
			() => ({
				render: () => ["async key"],
				invalidate() {},
				async handleInput() {
					started.resolve();
					await proceed.promise;
					finished.resolve();
				},
			}),
			{ overlay: true },
		);
		// The session's retirement closes the dialog as an aborted one: that is its answer here.
		const closed = pending.catch(() => undefined);
		await settle();
		h.mode.ui.injectDebugInput("x");
		await started.promise;
		const whileLive = h.runner.hasPendingHandlerWork();
		// Dispose returns within its window; what is still running is the session's to wait for,
		// and the account pools and the transcript are held until it ends.
		await h.session.dispose();
		const afterDispose = h.runner.hasPendingHandlerWork();
		proceed.resolve();
		await finished.promise;
		await h.runner.waitForPendingHandlerWork();
		await closed;

		expect({ whileLive, afterDispose, ended: h.runner.hasPendingHandlerWork() }).toEqual({
			whileLive: true,
			afterDispose: true,
			ended: false,
		});
	});
});

/** A host with a real TUI and the extension controller, the session's `ctx.ui`, and its release. */
async function controllerHost() {
	const owner = new ExtensionRuntime();
	const release = owner.beginSession();
	// Only the UI surfaces are exercised; nothing here reaches the registry.
	const registry = {} as ModelRegistry;
	const runner = new ExtensionRunner([], owner, process.cwd(), SessionManager.inMemory(), registry);
	const tui = new TUI(new VirtualTerminal(80, 24));
	const editor = new CustomEditor(getEditorTheme());
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	tui.addChild(editorContainer);
	tui.setFocus(editor);
	// The controller reads only these members of its context.
	const context = {
		ui: tui,
		editor,
		editorContainer,
		hookWidgetContainerAbove: new Container(),
		hookWidgetContainerBelow: new Container(),
		statusRowOccupied: false,
		session: { extensionRunner: runner },
	} as unknown as InteractiveModeContext;
	const controller = new ExtensionUiController(context);
	const ui = handUIContext(
		{ ...runner.getUIContext(), custom: controller.showHookCustom.bind(controller) },
		owner,
		runner.rendererScope,
	);
	const inside = (): boolean => extensionCallbackScope.getStore() === owner;
	cleanups.push(() => {
		release();
		tui.stop();
	});
	return { owner, release, runner, tui, editor, ui, inside };
}

describe("a key an extension's dialog takes", () => {
	test("is not handled by a dialog that closed itself while reserving it", async () => {
		const h = await controllerHost();
		const seen: string[] = [];
		let disposed = false;
		const pending = h.ui.custom<string>(
			(_tui, _theme, _keybindings, done) => ({
				render: () => ["dialog"],
				invalidate() {},
				dispose() {
					disposed = true;
				},
				capturesInput() {
					done("closed");
					return true;
				},
				handleInput(key: string) {
					seen.push(`${disposed}:${key}`);
				},
			}),
			{ overlay: true },
		);
		await settle();
		h.tui.injectDebugInput("x");

		expect(await pending).toBe("closed");
		expect(disposed).toBe(true);
		expect(seen).toEqual([]);
	});

	test("is not handled by a component whose session ended while it was reserving it", async () => {
		const h = await controllerHost();
		const seen: string[] = [];
		const child: Component = {
			render: () => ["child"],
			invalidate() {},
			capturesInput() {
				h.release();
				return true;
			},
			handleInput(key: string) {
				seen.push(`${h.owner.isRetired}:${key}`);
			},
		};
		bindInputScope(child, h.runner.rendererScope, () => {
			h.tui.setFocus(h.editor);
			return h.editor;
		});
		h.tui.setFocus(child);
		h.tui.injectDebugInput("x");

		expect(seen).toEqual([]);
	});

	test("reaches a focus target the dialog owns inside the dialog's session, and nothing once it has gone", async () => {
		const h = await controllerHost();
		const seen: Array<[string, boolean]> = [];
		const child: Component = {
			render: () => ["child"],
			invalidate() {},
			capturesInput() {
				seen.push(["capture", h.inside()]);
				return false;
			},
			handleInput(key: string) {
				seen.push([key, h.inside()]);
			},
		};
		const pending = h.ui.custom(
			() => ({
				render: () => ["parent"],
				invalidate() {},
				handleInput() {},
				ownsOverlayFocusTarget: (target: Component) => target === child,
			}),
			{ overlay: true },
		);
		await settle();
		h.tui.setFocus(child);
		h.tui.injectDebugInput("live-child");
		h.release();
		h.tui.injectDebugInput("retired-child");
		await pending.catch(() => undefined);

		expect(seen).toEqual([
			["capture", true],
			["live-child", true],
		]);
	});
});

/** The actions a runner is initialized with: only what these tests read is real. */
function actions(getModel: () => Model | undefined): [ExtensionActions, ExtensionContextActions] {
	// The runner stores these and calls only the members a test exercises.
	const host = {
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
		setLabel() {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: async () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => undefined,
		setThinkingLevel() {},
		getSessionName: () => undefined,
		setSessionName: async () => {},
	} as unknown as ExtensionActions;
	const context = {
		getModel,
		isIdle: () => true,
		abort() {},
		hasPendingMessages: () => false,
		shutdown() {},
		getContextUsage: () => undefined,
		compact: async () => {},
		getSystemPrompt: () => [],
	} as unknown as ExtensionContextActions;
	return [host, context];
}

describe("a handed context reads what the host can change when it is asked for", () => {
	test("a handler's ui offers a dialog the host enabled after the handler started", async () => {
		const owner = new ExtensionRuntime();
		cleanups.push(owner.beginSession());
		const entered = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		let handlerUI: ExtensionUIContext | undefined;
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_start", async (_event, ctx) => {
					handlerUI = ctx.ui;
					entered.resolve();
					await proceed.promise;
				});
			},
			process.cwd(),
			new EventBus(),
			owner,
			"late-dialog",
		);
		const runner = new ExtensionRunner(
			[extension],
			owner,
			process.cwd(),
			SessionManager.inMemory(),
			{} as ModelRegistry,
		);
		const ui: ExtensionUIContext = { ...runner.getUIContext() };
		const [host, context] = actions(() => undefined);
		runner.initialize(host, context, undefined, ui, "rpc");
		const dispatched = runner.emit({ type: "session_start" });
		await entered.promise;
		ui.askDialog = async () => ({ kind: "chat" }) as never;
		ui.approve = async () => "once";
		const seen = { askDialog: typeof handlerUI?.askDialog, approve: typeof handlerUI?.approve };
		proceed.resolve();
		await dispatched;

		expect(seen).toEqual({ askDialog: "function", approve: "function" });
	});

	test("`local://` options follow a host that replaces an answer", () => {
		const options = { getArtifactsDir: () => "/old-artifacts", getSessionId: () => "old-id" };
		const handed = handLocalProtocolOptions(options);
		options.getArtifactsDir = () => "/new-artifacts";
		options.getSessionId = () => "new-id";

		expect(handed.getArtifactsDir?.()).toBe("/new-artifacts");
		expect(handed.getSessionId?.()).toBe("new-id");
	});

	test("a saved context sees the ui, the mode and the model the host has now", async () => {
		const owner = new ExtensionRuntime();
		cleanups.push(owner.beginSession());
		const registry = new ModelRegistry(await AuthStorage.create(":memory:"));
		const [first, second] = registry.getAll();
		if (!first || !second) throw new Error("the bundled catalog has fewer than two models");
		let current: Model = first;
		const runner = new ExtensionRunner([], owner, process.cwd(), SessionManager.inMemory(), registry);
		const [host, context] = actions(() => current);
		const printUI: ExtensionUIContext = { ...runner.getUIContext() };
		runner.initialize(host, context, undefined, printUI, "rpc");
		const saved = runner.createContext();
		const command = runner.createCommandContext();
		const tuiUI: ExtensionUIContext = { ...runner.getUIContext(), notify() {} };
		runner.initialize(host, context, undefined, tuiUI, "tui");
		current = second;

		expect(saved.mode).toBe("tui");
		expect(saved.ui).toBe(runner.handedUIContext(tuiUI));
		expect(saved.model?.id).toBe(second.id);
		expect(command.model?.id).toBe(second.id);
	});
});

import type { Component, OverlayHandle, TUI } from "@oh-my-pi/pi-tui";
import { Container, Spacer, Text } from "@oh-my-pi/pi-tui";
import type { CollabUiRequestDraft, CollabUiSelectItem } from "@oh-my-pi/pi-wire";
import { KeybindingsManager } from "../../config/keybindings";
import type {
	CompactOptions,
	ExtensionActions,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionCustomOptions,
	ExtensionError,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
	ExtensionUiComponent,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	SendUserMessageHandler,
	TerminalInputHandler,
} from "../../extensibility/extensions";
import { getSessionSlashCommands } from "../../extensibility/extensions/get-commands-handler";
import { AskDialogComponent, boundPromptTitle } from "../../modes/components/ask-dialog";
import { installExtensionComposerShape } from "../../modes/components/composer-shape-registry";
import { EditorTopGap } from "../../modes/components/editor-top-gap";
import { HookEditorComponent } from "../../modes/components/hook-editor";
import { HookInputComponent } from "../../modes/components/hook-input";
import { HookSelectorComponent, type HookSelectorSlider } from "../../modes/components/hook-selector";
import { getAvailableThemesWithPaths, getThemeByName, setTheme, type Theme, theme } from "../../modes/theme/theme";
import type { InteractiveModeContext, InteractiveSelectorDialogOptions } from "../../modes/types";
import { normalizeCustomMessagePayload, USER_INTERRUPT_LABEL } from "../../session/messages";
import { setExtensionTerminalTitle, setSessionTerminalTitle } from "../../utils/title-generator";

const MAX_WIDGET_LINES = 10;
const ASK_OTHER_OPTION = "Other (type your own)";
const ASK_CHAT_OPTION = "Chat about this";
const ASK_NEXT_OPTION = "Next →";

interface CollabDialogWinner {
	source: "local" | "remote";
	value: string | undefined;
}

interface CollabAskDialogWinner {
	source: "local" | "remote";
	value: ExtensionAskDialogResult | undefined;
}
/** Tagged result from a guest UI request, distinguishing a real answer (even
 *  one whose literal value is "unavailable"), an explicit guest cancel, and a
 *  transport-unavailable sentinel (collab teardown / abort). Replaces the old
 *  `string | "unavailable" | undefined` channel that let a guest answer of
 *  "unavailable" collide with the transport sentinel. */
type GuestUiResult = { kind: "answered"; value: string } | { kind: "cancelled" } | { kind: "unavailable" };

function toWireSelectOptions(options: ExtensionUISelectItem[]): CollabUiSelectItem[] {
	return options.map(option =>
		typeof option === "string"
			? option
			: option.description
				? { label: option.label, description: option.description }
				: { label: option.label },
	);
}

export class ExtensionUiController {
	#extensionTerminalInputUnsubscribers = new Set<() => void>();
	#composerShapeDisposers: Array<() => void> = [];
	#hookWidgetsAbove = new Map<string, ExtensionUiComponent>();
	#hookWidgetsBelow = new Map<string, ExtensionUiComponent>();
	// Single-file dialog surface (`editorContainer` + focus) is shared by the
	// selector / input / editor modals, so only one may be presented at a time;
	// the rest queue. See `#presentDialog`.
	#dialogActive = false;
	#dialogQueue: Array<() => void> = [];
	/**
	 * Built once in `initHooksAndCustomTools()`. Reused directly by `/tree`
	 * `ask` re-answer (issue #5642) to drive a standalone `AskTool.execute()`
	 * call with the same picker/dialog primitives a live tool call would get.
	 */
	#toolUIContext: ExtensionUIContext | undefined;
	constructor(private ctx: InteractiveModeContext) {}

	#syncExtensionComposerShapes(): void {
		this.disposeComposerShapes();
		for (const definition of this.ctx.session.extensionRunner?.getComposerShapes() ?? []) {
			this.#composerShapeDisposers.push(installExtensionComposerShape(definition));
		}
		this.ctx.syncComposerShape();
	}

	/** Remove extension-owned composer styles from the process registries. */
	disposeComposerShapes(): void {
		for (const dispose of this.#composerShapeDisposers.splice(0)) dispose();
	}

	/**
	 * Initialize the hook system with TUI-based UI context.
	 */
	async initHooksAndCustomTools(): Promise<void> {
		// Create and set hook & tool UI context
		const uiContext: ExtensionUIContext = {
			timeoutStartsOnPresentation: true,
			select: (title, options, dialogOptions) => this.showCollabAwareSelector(title, options, dialogOptions),
			confirm: (title, message, dialogOptions) => this.showHookConfirm(title, message, dialogOptions),
			input: (title, placeholder, dialogOptions) => this.showHookInput(title, placeholder, dialogOptions),
			askDialog: (questions, dialogOptions) => this.showAskDialog(questions, dialogOptions),
			notify: (message, type) => this.showHookNotify(message, type),
			onTerminalInput: handler => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setHookStatus(key, text),
			setWorkingMessage: message => this.ctx.setWorkingMessage(message),
			setWidget: (key, content, options) => this.setHookWidget(key, content, options),
			setTitle: title => setExtensionTerminalTitle(title),
			custom: (factory, options) => this.showHookCustom(factory, options),
			setEditorText: text => {
				this.ctx.editor.setText(text);
				this.ctx.ui.requestRender();
			},
			pasteToEditor: text => {
				this.ctx.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
				this.ctx.ui.requestRender();
			},
			getEditorText: () => this.ctx.editor.getText(),
			editor: (title, prefill, dialogOptions, editorOptions) =>
				this.showCollabAwareEditor(title, prefill, dialogOptions, editorOptions),
			addAutocompleteProvider: factory => this.ctx.addAutocompleteProvider(factory),
			get theme() {
				return theme;
			},
			getAllThemes: async () => (await getAvailableThemesWithPaths()).map(t => ({ name: t.name, path: t.path })),
			getTheme: name => getThemeByName(name),
			setTheme: async themeArg => {
				if (typeof themeArg === "string") {
					return await setTheme(themeArg, true);
				}
				// Theme object passed directly - not supported in current implementation
				return Promise.resolve({ success: false, error: "Direct theme object not supported" });
			},
			setFooter: () => {},
			setHeader: () => {},
			setEditorComponent: factory => this.ctx.setEditorComponent(factory),
			getToolsExpanded: () => this.ctx.toolOutputExpanded,
			setToolsExpanded: expanded => this.ctx.setToolsExpanded(expanded),
		};
		this.ctx.setToolUIContext(uiContext, true);
		this.#toolUIContext = uiContext;
		this.ctx.session.setUsageFallbackConfirmer?.((confirmation, signal) => {
			const reserve =
				confirmation.remainingPercent === undefined
					? "inside the configured reserve margin"
					: `${confirmation.remainingPercent.toFixed(1)}% remaining`;
			return this.showHookConfirm(
				"Coding-plan reserve reached",
				`${confirmation.from} has ${reserve}. Switch to ${confirmation.to}? Choose No to keep using the current plan.`,
				{ signal },
			);
		});

		const extensionRunner = this.ctx.session.extensionRunner;
		this.#syncExtensionComposerShapes();
		if (!extensionRunner) {
			return; // No hooks loaded
		}

		const actions: ExtensionActions = {
			sendMessage: (message, options) => {
				const wasStreaming = this.ctx.session.isStreaming;
				const normalized = normalizeCustomMessagePayload(message);
				this.ctx.session
					.sendCustomMessage(normalized, options)
					.then(() => this.#applyCustomMessageDisplay(wasStreaming, normalized.display))
					.catch((err: unknown) => {
						this.ctx.showError(
							`Extension sendMessage failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					});
			},
			sendUserMessage: this.#sendExtensionUserMessage,
			appendEntry: (customType, data) => {
				this.ctx.sessionManager.appendCustomEntry(customType, data);
			},
			setLabel: (targetId, label) => {
				this.ctx.sessionManager.appendLabelChange(targetId, label);
			},
			getActiveTools: () => this.ctx.session.getEnabledToolNames(),
			getAllTools: () => this.ctx.session.getAllToolInfos(),
			setActiveTools: toolNames => this.ctx.session.setActiveToolsByName(toolNames),
			setModel: async model => {
				const key = await this.ctx.session.modelRegistry.getApiKey(model);
				if (!key) return false;
				await this.ctx.session.setModel(model);
				return true;
			},
			getThinkingLevel: () => this.ctx.session.thinkingLevel,
			setThinkingLevel: level => this.ctx.session.setThinkingLevel(level),
			getServiceTiers: () => this.ctx.session.serviceTierByFamily,
			setServiceTier: (family, tier) => this.ctx.session.setServiceTierFamily(family, tier),
			getCommands: () => getSessionSlashCommands(this.ctx.session),
			getSessionName: () => this.ctx.sessionManager.getSessionName(),
			setSessionName: name => this.#updateSessionName(name),
		};
		const contextActions: ExtensionContextActions = {
			getModel: () => this.ctx.session.model,
			isIdle: () => !this.ctx.session.isStreaming,
			abort: () => this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL }),
			hasPendingMessages: () => this.ctx.session.queuedMessageCount > 0,
			shutdown: () => {
				// Defer the actual teardown to the main loop, which calls
				// `checkShutdownRequested()` at idle boundaries so any queued
				// steering / follow-up messages drain first (see issue #1020).
				this.ctx.shutdownRequested = true;
			},
			getContextUsage: () => this.ctx.session.getContextUsage(),
			compact: instructionsOrOptions => this.#compactSession(instructionsOrOptions),
			getSystemPrompt: () => this.ctx.session.systemPrompt,
		};
		const commandActions: ExtensionCommandContextActions = {
			getContextUsage: () => this.ctx.session.getContextUsage(),
			waitForIdle: () => this.ctx.session.agent.waitForIdle(),
			reload: async () => {
				await this.ctx.session.reload();
				await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				this.ctx.showStatus("Reloaded session");
			},
			newSession: async options => {
				this.ctx.clearTransientSessionUi();

				// Create new session
				this.clearExtensionTerminalInputListeners();
				this.clearHookWidgets();
				const success = await this.ctx.session.newSession({ parentSession: options?.parentSession });
				if (!success) {
					return { cancelled: true };
				}
				setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());

				// Call setup callback if provided
				if (options?.setup) {
					await options.setup(this.ctx.sessionManager);
				}

				// Reset and update status line
				this.ctx.statusLine.invalidate();
				this.ctx.statusLine.resetActiveTime();
				this.ctx.clearTransientSessionUi();
				this.ctx.resetTranscript();

				this.ctx.present([
					new Spacer(1),
					new Text(`${theme.fg("accent", `${theme.status.success} New session started`)}`, 1, 1),
				]);
				await this.ctx.reloadTodos();
				this.ctx.ui.requestRender(true, { clearScrollback: true });

				return { cancelled: false };
			},
			branch: async entryId => {
				const result = await this.ctx.session.branch(entryId);
				if (result.cancelled) {
					return { cancelled: true };
				}

				// Update UI
				await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				this.ctx.editor.setDraft(result.selectedText, result.selectedImages);
				this.ctx.showStatus("Branched to new session");

				return { cancelled: false };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.ctx.session.navigateTree(targetId, { summarize: options?.summarize });
				if (result.cancelled) {
					return { cancelled: true };
				}

				// Update UI
				await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				if (result.editorText && !this.ctx.editor.getText().trim()) {
					this.ctx.editor.setDraft(result.editorText, result.editorImages);
				}
				this.ctx.showStatus("Navigated to selected point");

				return { cancelled: false };
			},
			compact: async instructionsOrOptions => this.#handleInteractiveCompact(instructionsOrOptions),
			switchSession: async sessionPath => {
				this.clearHookWidgets();
				const result = await this.ctx.session.switchSession(sessionPath);
				if (!result) {
					return { cancelled: true };
				}
				setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());
				await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				return { cancelled: false };
			},
		};

		extensionRunner.initialize(actions, contextActions, commandActions, uiContext, "tui");

		// Subscribe to extension errors
		extensionRunner.onError((error: ExtensionError) => {
			this.showExtensionError(error.extensionPath, error.error);
		});

		// Emit session_start event
		await extensionRunner.emit({
			type: "session_start",
		});
	}

	/**
	 * The `ExtensionUIContext` built in `initHooksAndCustomTools()` — the same
	 * picker/dialog primitives passed as `context.ui` for every live tool
	 * call. `/tree` `ask` re-answer (issue #5642) reuses this to drive a
	 * standalone `AskTool.execute()` call outside a normal agent turn.
	 * `undefined` before hooks have initialized.
	 */
	getToolUIContext(): ExtensionUIContext | undefined {
		return this.#toolUIContext;
	}

	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		const placement = options?.placement ?? "aboveEditor";
		this.#removeHookWidget(this.#hookWidgetsAbove, key);
		this.#removeHookWidget(this.#hookWidgetsBelow, key);

		if (content === undefined) {
			this.#rebuildHookWidgets();
			return;
		}

		const target = placement === "belowEditor" ? this.#hookWidgetsBelow : this.#hookWidgetsAbove;
		target.set(key, this.#createHookWidget(content));
		this.#rebuildHookWidgets();
	}

	#removeHookWidget(widgets: Map<string, ExtensionUiComponent>, key: string): void {
		const existing = widgets.get(key);
		existing?.dispose?.();
		widgets.delete(key);
	}

	#createHookWidget(content: ExtensionWidgetContent): ExtensionUiComponent {
		if (Array.isArray(content)) {
			const container = new Container();
			for (const line of content.slice(0, MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			return container;
		}
		if (content === undefined) {
			throw new Error("Widget content missing");
		}
		return content(this.ctx.ui, theme);
	}

	#rebuildHookWidgets(): void {
		this.#renderHookWidgetContainer(this.ctx.hookWidgetContainerAbove, this.#hookWidgetsAbove, true, true);
		this.#renderHookWidgetContainer(this.ctx.hookWidgetContainerBelow, this.#hookWidgetsBelow, false, false);
		this.ctx.ui.requestRender();
	}

	#renderHookWidgetContainer(
		container: Container,
		widgets: Map<string, ExtensionUiComponent>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new EditorTopGap(() => this.ctx.statusRowOccupied));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const widget of widgets.values()) {
			container.addChild(widget);
		}
	}

	initializeHookRunner(uiContext: ExtensionUIContext, _hasUI: boolean): void {
		const extensionRunner = this.ctx.session.extensionRunner;
		if (!extensionRunner) {
			return;
		}

		const actions: ExtensionActions = {
			sendMessage: (message, options) => {
				const wasStreaming = this.ctx.session.isStreaming;
				const normalized = normalizeCustomMessagePayload(message);
				this.ctx.session
					.sendCustomMessage(normalized, options)
					.then(() => this.#applyCustomMessageDisplay(wasStreaming, normalized.display))
					.catch((err: unknown) => {
						const errorText = `Extension sendMessage failed: ${err instanceof Error ? err.message : String(err)}`;
						this.ctx.showError(errorText);
					});
			},
			sendUserMessage: this.#sendExtensionUserMessage,
			appendEntry: (customType, data) => {
				this.ctx.sessionManager.appendCustomEntry(customType, data);
			},
			setLabel: (targetId, label) => {
				this.ctx.sessionManager.appendLabelChange(targetId, label);
			},
			getActiveTools: () => this.ctx.session.getEnabledToolNames(),
			getAllTools: () => this.ctx.session.getAllToolInfos(),
			setActiveTools: toolNames => this.ctx.session.setActiveToolsByName(toolNames),
			setModel: async model => {
				const key = await this.ctx.session.modelRegistry.getApiKey(model);
				if (!key) return false;
				await this.ctx.session.setModel(model);
				return true;
			},
			getThinkingLevel: () => this.ctx.session.thinkingLevel,
			setThinkingLevel: (level, persist) => this.ctx.session.setThinkingLevel(level, persist),
			getServiceTiers: () => this.ctx.session.serviceTierByFamily,
			setServiceTier: (family, tier) => this.ctx.session.setServiceTierFamily(family, tier),
			getCommands: () => getSessionSlashCommands(this.ctx.session),
			getSessionName: () => this.ctx.sessionManager.getSessionName(),
			setSessionName: name => this.#updateSessionName(name),
		};
		const contextActions: ExtensionContextActions = {
			getModel: () => this.ctx.session.model,
			isIdle: () => !this.ctx.session.isStreaming,
			abort: () => this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL }),
			hasPendingMessages: () => this.ctx.session.queuedMessageCount > 0,
			shutdown: () => {
				// Defer the actual teardown to the main loop, which calls
				// `checkShutdownRequested()` at idle boundaries so any queued
				// steering / follow-up messages drain first (see issue #1020).
				this.ctx.shutdownRequested = true;
			},
			getContextUsage: () => this.ctx.session.getContextUsage(),
			compact: instructionsOrOptions => this.#compactSession(instructionsOrOptions),
			getSystemPrompt: () => this.ctx.session.systemPrompt,
		};
		const commandActions: ExtensionCommandContextActions = {
			getContextUsage: () => this.ctx.session.getContextUsage(),
			waitForIdle: () => this.ctx.session.agent.waitForIdle(),
			reload: async () => {
				await this.ctx.session.reload();
				await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				this.ctx.showStatus("Reloaded session");
			},
			newSession: async options => {
				this.ctx.clearTransientSessionUi();

				// Create new session
				this.clearExtensionTerminalInputListeners();
				this.clearHookWidgets();
				const success = await this.ctx.session.newSession({ parentSession: options?.parentSession });
				if (!success) {
					return { cancelled: true };
				}

				// Call setup callback if provided
				if (options?.setup) {
					await options.setup(this.ctx.sessionManager);
				}

				// Clear UI state
				this.ctx.clearTransientSessionUi();
				this.ctx.resetTranscript();

				this.ctx.present([
					new Spacer(1),
					new Text(`${theme.fg("accent", `${theme.status.success} New session started`)}`, 1, 1),
				]);
				await this.ctx.reloadTodos();
				this.ctx.ui.requestRender(true, { clearScrollback: true });

				return { cancelled: false };
			},
			branch: async entryId => {
				const result = await this.ctx.session.branch(entryId);
				if (result.cancelled) {
					return { cancelled: true };
				}

				// Update UI
				await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				this.ctx.editor.setDraft(result.selectedText, result.selectedImages);
				this.ctx.showStatus("Branched to new session");

				return { cancelled: false };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.ctx.session.navigateTree(targetId, { summarize: options?.summarize });
				if (result.cancelled) {
					return { cancelled: true };
				}

				// Update UI
				await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				if (result.editorText && !this.ctx.editor.getText().trim()) {
					this.ctx.editor.setDraft(result.editorText, result.editorImages);
				}
				this.ctx.showStatus("Navigated to selected point");

				return { cancelled: false };
			},
			compact: async instructionsOrOptions => this.#handleInteractiveCompact(instructionsOrOptions),
			switchSession: async sessionPath => {
				this.clearHookWidgets();
				const result = await this.ctx.session.switchSession(sessionPath);
				if (!result) {
					return { cancelled: true };
				}
				await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				return { cancelled: false };
			},
		};

		extensionRunner.initialize(actions, contextActions, commandActions, uiContext, "tui");
		this.#syncExtensionComposerShapes();
	}

	/**
	 * Emit session event to all extension tools.
	 */
	async emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void> {
		const event = { reason, previousSessionFile };
		const uiContext = this.ctx.session.extensionRunner?.getUIContext();
		if (!uiContext) {
			return;
		}
		const runner = this.ctx.session.extensionRunner;
		for (const registeredTool of runner?.getAllRegisteredTools() ?? []) {
			if (registeredTool.definition.onSession) {
				try {
					await registeredTool.definition.onSession(event, {
						...runner!.createContext(),
						ui: uiContext,
						hasUI: true,
						compact: instructionsOrOptions => this.#compactSession(instructionsOrOptions),
					});
				} catch (err) {
					this.showToolError(registeredTool.definition.name, err instanceof Error ? err.message : String(err));
				}
			}
		}
	}

	/**
	 * Show a tool error in the chat.
	 */
	showToolError(toolName: string, error: string): void {
		const errorText = new Text(`Tool "${toolName}" error: ${error}`, 1, 0).setStyleFn(t => theme.fg("error", t));
		this.ctx.present(errorText);
	}

	/**
	 * Set hook status text in the footer.
	 */
	setHookStatus(key: string, text: string | undefined): void {
		this.ctx.statusLine.setHookStatus(key, text);
		this.ctx.ui.requestRender();
	}

	async showCollabAwareSelector(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
		extra?: { slider?: HookSelectorSlider },
	): Promise<string | undefined> {
		const request: CollabUiRequestDraft = {
			kind: "select",
			title,
			options: toWireSelectOptions(options),
			initialIndex: dialogOptions?.initialIndex,
			selectionMarker: dialogOptions?.selectionMarker,
			checkedIndices: dialogOptions?.checkedIndices ? [...dialogOptions.checkedIndices] : undefined,
			markableCount: dialogOptions?.markableCount,
			helpText: dialogOptions?.helpText,
		};
		return this.#raceCollabDialog(request, dialogOptions?.signal, signal =>
			this.showHookSelector(title, options, { ...dialogOptions, signal }, extra),
		);
	}

	async showCollabAwareEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		const request: CollabUiRequestDraft = { kind: "editor", title, prefill };
		return this.#raceCollabDialog(request, dialogOptions?.signal, signal =>
			this.showHookEditor(title, prefill, { ...dialogOptions, signal }, editorOptions),
		);
	}

	async showAskDialog(
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		const host = this.ctx.collabHost;
		if (!host) return this.#showLocalAskDialog(questions, dialogOptions);
		const localAbort = new AbortController();
		const remoteAbort = new AbortController();
		const parentSignal = dialogOptions?.signal;
		const localSignal = parentSignal ? AbortSignal.any([parentSignal, localAbort.signal]) : localAbort.signal;
		const remoteSignal = parentSignal ? AbortSignal.any([parentSignal, remoteAbort.signal]) : remoteAbort.signal;
		const localWinner = this.#showLocalAskDialog(questions, { ...dialogOptions, signal: localSignal }).then(
			(value): CollabAskDialogWinner => ({ source: "local", value }),
		);
		const remoteWinner: Promise<CollabAskDialogWinner> = this.#runGuestAskDialog(questions, remoteSignal).then(
			result => (result === "unavailable" ? localWinner : { source: "remote", value: result }),
		);
		const winner = await Promise.race([localWinner, remoteWinner]);
		if (winner.source === "remote") localAbort.abort();
		else remoteAbort.abort();
		return winner.value;
	}

	#showLocalAskDialog(
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		return this.#presentDialog<ExtensionAskDialogResult>(dialogOptions?.signal, settle => {
			let askDialog: AskDialogComponent | undefined;
			let promptEditor: HookEditorComponent | undefined;
			let promptResolve: ((value: string | undefined) => void) | undefined;
			let closed = false;
			const draftEditor = this.ctx.editor;
			const inputGuard =
				draftEditor.getText().length > 0
					? {
							isBlocked: () => draftEditor.getText().length > 0,
							handleInput: (keyData: string) => draftEditor.handleDraftEdit(keyData),
							hint: "Finish or clear the current prompt to answer",
							// Show the draft's insertion cursor while it owns input; drop it
							// once the draft clears and the ask controls take over.
							syncPresentation: () => {
								draftEditor.focused = draftEditor.getText().length > 0;
							},
						}
					: undefined;

			const restoreAskDialog = (): void => {
				if (closed || !askDialog) return;
				this.ctx.editorContainer.clear();
				this.ctx.editorContainer.addChild(askDialog);
				// Keep the draft editor mounted beneath the restored ask, matching the
				// initial presentation: the guard re-blocks whenever the draft is
				// non-empty (e.g. a failed submit restored its text while a nested
				// prompt was open), and routed input must land on a visible surface.
				if (inputGuard) this.ctx.editorContainer.addChild(this.ctx.editor);
				this.ctx.ui.setFocus(askDialog);
				this.ctx.ui.requestRender();
			};

			const finishPrompt = (value: string | undefined): void => {
				const resolvePrompt = promptResolve;
				promptResolve = undefined;
				promptEditor = undefined;
				restoreAskDialog();
				resolvePrompt?.(value);
			};

			const promptForText = (title: string, prefill?: string): Promise<string | undefined> => {
				if (closed) return Promise.resolve(undefined);
				const { promise, resolve } = Promise.withResolvers<string | undefined>();
				promptResolve = resolve;
				promptEditor = new HookEditorComponent(
					this.ctx.ui,
					title,
					prefill,
					value => finishPrompt(value),
					() => finishPrompt(undefined),
					{ promptStyle: true },
				);
				this.ctx.editorContainer.clear();
				this.ctx.editorContainer.addChild(promptEditor);
				this.ctx.ui.setFocus(promptEditor);
				this.ctx.ui.requestRender();
				return promise;
			};

			askDialog = new AskDialogComponent(
				questions,
				{
					onSubmit: result => settle(result),
					onCancel: () => settle(undefined),
					onPrompt: promptForText,
				},
				{
					timeout: dialogOptions?.timeout,
					onTimeout: dialogOptions?.onTimeout,
					tui: this.ctx.ui,
					inputGuard,
				},
			);
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(askDialog);
			if (inputGuard) this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(askDialog);
			this.ctx.ui.requestRender();

			return () => {
				closed = true;
				askDialog?.dispose();
				promptResolve?.(undefined);
				promptResolve = undefined;
				promptEditor = undefined;
				this.ctx.editorContainer.clear();
				this.ctx.editorContainer.addChild(this.ctx.editor);
				this.ctx.ui.setFocus(this.ctx.editor);
				this.ctx.ui.requestRender();
			};
		});
	}

	/**
	 * Race the local hook dialog against a mirrored guest ask. First *answer*
	 * wins and cancels the other side. A remote `unavailable` settlement
	 * (collab teardown, relay drop, abort) is NOT an answer: the local dialog
	 * keeps running — the host user may be mid-keystroke in it — and its
	 * eventual result is returned.
	 */
	async #raceCollabDialog(
		request: CollabUiRequestDraft,
		signal: AbortSignal | undefined,
		local: (signal: AbortSignal | undefined) => Promise<string | undefined>,
	): Promise<string | undefined> {
		const host = this.ctx.collabHost;
		if (!host) return local(signal);
		const localAbort = new AbortController();
		const remoteAbort = new AbortController();
		const remote = host.requestGuestUi(
			request,
			signal ? AbortSignal.any([signal, remoteAbort.signal]) : remoteAbort.signal,
		);
		if (!remote) return local(signal);
		const localWinner = local(signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal).then(
			(value): CollabDialogWinner => ({ source: "local", value }),
		);
		const remoteWinner: Promise<CollabDialogWinner> = remote.then(result =>
			result.kind === "answered" ? { source: "remote", value: result.value } : localWinner,
		);
		const winner = await Promise.race([localWinner, remoteWinner]);
		if (winner.source === "remote") localAbort.abort();
		else remoteAbort.abort();
		return winner.value;
	}

	async #runGuestAskDialog(
		questions: ExtensionAskDialogQuestion[],
		signal: AbortSignal,
	): Promise<ExtensionAskDialogResult | "unavailable" | undefined> {
		const results: ExtensionAskDialogResultItem[] = [];
		for (const question of questions) {
			const result = await this.#runGuestAskQuestion(question, signal);
			if (result === "unavailable" || result === undefined) return result;
			if (result === "chat") return { kind: "chat" };
			results.push(result);
		}
		return { kind: "submit", results };
	}

	async #runGuestAskQuestion(
		question: ExtensionAskDialogQuestion,
		signal: AbortSignal,
	): Promise<ExtensionAskDialogResultItem | "chat" | "unavailable" | undefined> {
		const selected = new Set<string>();
		let customInput: string | undefined;
		const baseOptions: CollabUiSelectItem[] = question.options.map(option =>
			option.description?.trim() ? { label: option.label, description: option.description.trim() } : option.label,
		);
		if (question.multi) {
			while (true) {
				const checkedIndices = question.options
					.map((option, index) => (selected.has(option.label) ? index : -1))
					.filter(index => index >= 0);
				// Mirror the local dialog's Next gating: omit the Next option until
				// at least one option is checked or a custom answer exists, so a
				// guest cannot submit an empty multi-select result
				// (PRRT_kwDOQxs0bc6OFbDW). The remote select has no "disabled" row
				// concept, so we omit rather than dim it.
				const hasAnswer = selected.size > 0 || customInput !== undefined;
				const options = [...baseOptions, ASK_OTHER_OPTION];
				if (hasAnswer) options.push(ASK_NEXT_OPTION);
				options.push(ASK_CHAT_OPTION);
				const choice = await this.#requestGuestUiString(
					{
						kind: "select",
						title: question.question,
						options,
						selectionMarker: "checkbox",
						checkedIndices,
						markableCount: question.options.length,
						helpText: hasAnswer
							? "up/down navigate  enter toggle  Next → continue  esc cancel"
							: "up/down navigate  enter toggle  esc cancel",
					},
					signal,
				);
				if (choice.kind === "unavailable") return "unavailable";
				if (choice.kind === "cancelled") return undefined;
				if (choice.value === ASK_CHAT_OPTION) return "chat";
				if (choice.value === ASK_NEXT_OPTION) break;
				if (choice.value === ASK_OTHER_OPTION) {
					const input = await this.#requestGuestUiString(
						{ kind: "editor", title: boundPromptTitle("Custom answer: ", question.question) },
						signal,
					);
					if (input.kind === "unavailable") return "unavailable";
					// Guest cancelled the Other editor: keep the ask open and
					// return to the option list instead of cancelling the whole ask.
					if (input.kind === "cancelled") continue;
					customInput = input.value;
					break;
				}
				if (selected.has(choice.value)) selected.delete(choice.value);
				else selected.add(choice.value);
			}
		} else {
			const recommended =
				typeof question.recommended === "number" && Number.isInteger(question.recommended)
					? question.recommended
					: 0;
			const initialIndex = Math.max(0, Math.min(recommended, Math.max(0, question.options.length - 1)));
			while (true) {
				const choice = await this.#requestGuestUiString(
					{
						kind: "select",
						title: question.question,
						options: [...baseOptions, ASK_OTHER_OPTION, ASK_CHAT_OPTION],
						initialIndex,
						selectionMarker: "radio",
						markableCount: question.options.length,
						helpText: "up/down navigate  enter select  esc cancel",
					},
					signal,
				);
				if (choice.kind === "unavailable") return "unavailable";
				if (choice.kind === "cancelled") return undefined;
				if (choice.value === ASK_CHAT_OPTION) return "chat";
				if (choice.value === ASK_OTHER_OPTION) {
					const input = await this.#requestGuestUiString(
						{ kind: "editor", title: boundPromptTitle("Custom answer: ", question.question) },
						signal,
					);
					if (input.kind === "unavailable") return "unavailable";
					// Guest cancelled the Other editor: re-show the select list
					// instead of cancelling the whole ask.
					if (input.kind === "cancelled") continue;
					customInput = input.value;
				} else {
					selected.add(choice.value);
				}
				break;
			}
		}
		return {
			id: question.id,
			question: question.question,
			options: question.options.map(option => option.label),
			multi: question.multi ?? false,
			selectedOptions: question.options.map(option => option.label).filter(label => selected.has(label)),
			customInput,
		};
	}

	async #requestGuestUiString(request: CollabUiRequestDraft, signal: AbortSignal): Promise<GuestUiResult> {
		const host = this.ctx.collabHost;
		if (!host) return { kind: "unavailable" };
		const remote = host.requestGuestUi(request, signal);
		if (!remote) return { kind: "unavailable" };
		const result = await remote;
		if (result.kind === "unavailable") return { kind: "unavailable" };
		return typeof result.value === "string" ? { kind: "answered", value: result.value } : { kind: "cancelled" };
	}

	/**
	 * Show a selector for hooks.
	 */
	showHookSelector(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
		extra?: { slider?: HookSelectorSlider },
	): Promise<string | undefined> {
		return this.#presentDialog(dialogOptions?.signal, settle => {
			const maxVisible = Math.max(4, Math.min(15, this.ctx.ui.terminal.rows - 12));
			this.ctx.hookSelector = new HookSelectorComponent(
				title,
				options,
				option => settle(option),
				() => settle(undefined),
				{
					onLeft: dialogOptions?.onLeft
						? () => {
								dialogOptions.onLeft?.();
								settle(undefined);
							}
						: undefined,
					onRight: dialogOptions?.onRight
						? () => {
								dialogOptions.onRight?.();
								settle(undefined);
							}
						: undefined,
					onExternalEditor: dialogOptions?.onExternalEditor,
					helpText: dialogOptions?.helpText,
					initialIndex: dialogOptions?.initialIndex,
					timeout: dialogOptions?.timeout,
					onTimeout: dialogOptions?.onTimeout,
					onTimeoutStart: dialogOptions?.onTimeoutStart,
					onTimeoutReset: dialogOptions?.onTimeoutReset,
					tui: this.ctx.ui,
					outline: dialogOptions?.outline,
					disabledIndices: dialogOptions?.disabledIndices,
					selectionMarker: dialogOptions?.selectionMarker,
					checkedIndices: dialogOptions?.checkedIndices,
					markableCount: dialogOptions?.markableCount,
					maxVisible,
					slider: extra?.slider,
				},
			);
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.hookSelector);
			this.ctx.ui.setFocus(this.ctx.hookSelector);
			this.ctx.ui.requestRender();
			return () => this.hideHookSelector();
		});
	}
	/**
	 * Hide the hook selector.
	 */
	hideHookSelector(): void {
		this.ctx.hookSelector?.dispose();
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(this.ctx.editor);
		this.ctx.hookSelector = undefined;
		this.ctx.ui.setFocus(this.ctx.editor);
		this.ctx.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for hooks.
	 */
	async showHookConfirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
		const result = await this.showHookSelector(`${title}\n${message}`, ["Yes", "No"], dialogOptions);
		return result === "Yes";
	}

	/**
	 * Show a text input for hooks.
	 */
	showHookInput(
		title: string,
		placeholder?: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.#presentDialog(dialogOptions?.signal, settle => {
			this.ctx.hookInput = new HookInputComponent(
				title,
				placeholder,
				value => settle(value),
				() => settle(undefined),
				{
					timeout: dialogOptions?.timeout,
					onTimeout: dialogOptions?.onTimeout,
					tui: this.ctx.ui,
				},
			);
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.hookInput);
			this.ctx.ui.setFocus(this.ctx.hookInput);
			this.ctx.ui.requestRender();
			return () => this.hideHookInput();
		});
	}

	/**
	 * Hide the hook input.
	 */
	hideHookInput(): void {
		this.ctx.hookInput?.dispose();
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(this.ctx.editor);
		this.ctx.hookInput = undefined;
		this.ctx.ui.setFocus(this.ctx.editor);
		this.ctx.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for hooks (with Ctrl+G support).
	 */
	showHookEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		return this.#presentDialog(dialogOptions?.signal, settle => {
			this.ctx.hookEditor = new HookEditorComponent(
				this.ctx.ui,
				title,
				prefill,
				value => settle(value),
				() => settle(undefined),
				editorOptions,
			);
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.hookEditor);
			this.ctx.ui.setFocus(this.ctx.hookEditor);
			this.ctx.ui.requestRender();
			return () => this.hideHookEditor();
		});
	}

	/**
	 * Hide the hook editor.
	 */
	hideHookEditor(): void {
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(this.ctx.editor);
		this.ctx.hookEditor = undefined;
		this.ctx.ui.setFocus(this.ctx.editor);
		this.ctx.ui.requestRender();
	}

	/**
	 * Show a notification for hooks.
	 */
	showHookNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.ctx.showError(message);
		} else if (type === "warning") {
			this.ctx.showWarning(message);
		} else {
			this.ctx.showStatus(message);
		}
	}

	/**
	 * Show a custom component with keyboard focus.
	 */
	async showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: ExtensionCustomOptions,
	): Promise<T> {
		const savedText = this.ctx.editor.getText();
		const keybindings = KeybindingsManager.inMemory();

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let component: (Component & { dispose?(): void }) | undefined;
		let overlayHandle: OverlayHandle | undefined;
		let closed = false;
		let editorReplaced = false;

		const cleanup = () => {
			component?.dispose?.();
			overlayHandle?.hide();
			overlayHandle = undefined;
			if (editorReplaced) {
				this.ctx.editorContainer.clear();
				this.ctx.editorContainer.addChild(this.ctx.editor);
				this.ctx.editor.setText(savedText);
			}
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
		};
		const finish = (settle: () => void) => {
			if (closed) return;
			closed = true;
			options?.signal?.removeEventListener("abort", onAbort);
			try {
				cleanup();
			} finally {
				settle();
			}
		};
		const fail = (error: unknown) => finish(() => reject(error));
		const onAbort = () => fail(options?.signal?.reason ?? new DOMException("Dialog aborted", "AbortError"));
		const close = (result: T) => finish(() => resolve(result));

		if (options?.signal?.aborted) {
			fail(options.signal.reason ?? new DOMException("Dialog aborted", "AbortError"));
			return promise;
		}
		options?.signal?.addEventListener("abort", onAbort, { once: true });

		Promise.try(() => factory(this.ctx.ui, theme, keybindings, close))
			.then(c => {
				if (closed) {
					c.dispose?.();
					return;
				}
				component = c;
				if (options?.overlay) {
					const overlayOptions =
						typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
					overlayHandle = this.ctx.ui.showOverlay(
						component,
						overlayOptions ?? {
							anchor: "bottom-center",
							width: "100%",
							maxHeight: "100%",
							margin: 0,
						},
					);
					options.onHandle?.(overlayHandle);
					return;
				}
				editorReplaced = true;
				this.ctx.editorContainer.clear();
				this.ctx.editorContainer.addChild(component);
				this.ctx.ui.setFocus(component);
				this.ctx.ui.requestRender();
			})
			.catch(fail);
		return promise;
	}

	/**
	 * Show an extension error in the UI.
	 */
	addExtensionTerminalInputListener(handler: TerminalInputHandler): () => void {
		const unsubscribe = this.ctx.ui.addInputListener(handler);
		this.#extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.#extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	clearHookWidgets(): void {
		for (const widget of this.#hookWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.#hookWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.#hookWidgetsAbove.clear();
		this.#hookWidgetsBelow.clear();
		this.#rebuildHookWidgets();
	}

	clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.#extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.#extensionTerminalInputUnsubscribers.clear();
	}

	showExtensionError(extensionPath: string, error: string): void {
		const errorText = new Text(`Extension "${extensionPath}" error: ${error}`, 1, 0).setStyleFn(t =>
			theme.fg("error", t),
		);
		this.ctx.present(errorText);
	}
	async #handleInteractiveCompact(instructionsOrOptions: string | CompactOptions | undefined): Promise<void> {
		await this.ctx.executeCompaction(instructionsOrOptions, false);
	}

	async #compactSession(instructionsOrOptions: string | CompactOptions | undefined): Promise<void> {
		const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
		const options =
			instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
		await this.ctx.session.compact(instructions, options);
	}

	async #updateSessionName(name: string): Promise<void> {
		await this.ctx.sessionManager.setSessionName(name, "user");
	}

	#sendExtensionUserMessage: SendUserMessageHandler = (content, options) => {
		this.ctx.session.sendUserMessage(content, options).catch((err: unknown) => {
			this.ctx.showError(`Extension sendUserMessage failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	};

	#applyCustomMessageDisplay(wasStreaming: boolean, shouldDisplay: boolean | undefined): void {
		// For non-streaming cases with display=true, update UI
		// (streaming cases update via message_end event).
		// Gate on initialChatRendered (#1955): an extension's session_start
		// sendMessage({display:true}) runs before renderInitialMessages, which would
		// re-render from session entries AND re-append via preserveExistingChat,
		// duplicating the message. After the initial render the rebuild must run.
		if (!wasStreaming && shouldDisplay && this.ctx.initialChatRendered) {
			this.ctx.rebuildChatFromMessages();
		}
	}

	/**
	 * Present a modal dialog on the shared editor surface, serializing against any
	 * dialog already open. `present` builds the component, swaps it into
	 * `editorContainer`, steals focus, and returns a `hide` closure; it is invoked
	 * with a single `settle` callback that the component fires on submit/cancel.
	 *
	 * Because selector / input / editor all clear `editorContainer` and re-focus,
	 * showing a second one while the first is open would orphan the first — its
	 * promise would hang until the caller's signal aborts. So at most one dialog is
	 * presented at a time and the rest queue (FIFO). `settle` (or an abort) hides
	 * the current dialog and hands the surface to the next queued request. A request
	 * whose signal aborts before its turn resolves `undefined` and is never shown.
	 */
	#presentDialog<T = string>(
		signal: AbortSignal | undefined,
		present: (settle: (value: T | undefined) => void) => () => void,
	): Promise<T | undefined> {
		const { promise, resolve, reject } = Promise.withResolvers<T | undefined>();
		let settled = false;
		let started = false;
		let hide: (() => void) | undefined;

		function onAbort(): void {
			settle(undefined);
		}

		const settle = (value: T | undefined): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (started) {
				hide?.();
				this.#dialogActive = false;
				this.#advanceDialogQueue();
			}
			resolve(value);
		};

		const startPresentation = (): void => {
			if (settled) {
				// Aborted before its turn arrived — never present, hand off the surface.
				this.#advanceDialogQueue();
				return;
			}
			started = true;
			this.#dialogActive = true;
			try {
				hide = present(settle);
			} catch (error) {
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				this.#dialogActive = false;
				reject(error);
				this.#advanceDialogQueue();
			}
		};

		if (signal?.aborted) {
			resolve(undefined);
			return promise;
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		if (this.#dialogActive) {
			this.#dialogQueue.push(startPresentation);
		} else {
			startPresentation();
		}
		return promise;
	}

	#advanceDialogQueue(): void {
		this.#dialogQueue.shift()?.();
	}
}

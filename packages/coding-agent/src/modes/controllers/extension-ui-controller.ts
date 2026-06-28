import type { Component, OverlayHandle, TUI } from "@pk-nerdsaver-ai/pi-tui";
import { Container, Spacer, Text } from "@pk-nerdsaver-ai/pi-tui";
import { KeybindingsManager } from "../../config/keybindings";
import type {
	CompactOptions,
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
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
import { createExtensionModelQuery } from "../../extensibility/extensions/model-api";
import { HookEditorComponent } from "../../modes/components/hook-editor";
import { HookInputComponent } from "../../modes/components/hook-input";
import { HookSelectorComponent, type HookSelectorSlider } from "../../modes/components/hook-selector";
import { getAvailableThemesWithPaths, getThemeByName, setTheme, type Theme, theme } from "../../modes/theme/theme";
import type { InteractiveModeContext, InteractiveSelectorDialogOptions } from "../../modes/types";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { setSessionTerminalTitle, setTerminalTitle } from "../../utils/title-generator";

const MAX_WIDGET_LINES = 10;

export class ExtensionUiController {
	#extensionTerminalInputUnsubscribers = new Set<() => void>();
	#hookWidgetsAbove = new Map<string, ExtensionUiComponent>();
	#hookWidgetsBelow = new Map<string, ExtensionUiComponent>();
	// Single-file dialog surface (`editorContainer` + focus) is shared by the
	// selector / input / editor modals, so only one may be presented at a time;
	// the rest queue. See `#presentDialog`.
	#dialogActive = false;
	#dialogQueue: Array<() => void> = [];
	constructor(private ctx: InteractiveModeContext) {}

	/**
	 * Initialize the hook system with TUI-based UI context.
	 */
	async initHooksAndCustomTools(): Promise<void> {
		// Create and set hook & tool UI context
		const uiContext: ExtensionUIContext = {
			select: (title, options, dialogOptions) => this.showHookSelector(title, options, dialogOptions),
			confirm: (title, message, _dialogOptions) => this.showHookConfirm(title, message),
			input: (title, placeholder, dialogOptions) => this.showHookInput(title, placeholder, dialogOptions),
			notify: (message, type) => this.showHookNotify(message, type),
			onTerminalInput: handler => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setHookStatus(key, text),
			setWorkingMessage: message => this.ctx.setWorkingMessage(message),
			setWidget: (key, content, options) => this.setHookWidget(key, content, options),
			setTitle: title => setTerminalTitle(title),
			custom: (factory, options) => this.showHookCustom(factory, options),
			setEditorText: text => this.ctx.editor.setText(text),
			pasteToEditor: text => {
				this.ctx.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
			},
			getEditorText: () => this.ctx.editor.getText(),
			editor: (title, prefill, dialogOptions, editorOptions) =>
				this.showHookEditor(title, prefill, dialogOptions, editorOptions),
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

		const extensionRunner = this.ctx.session.extensionRunner;
		if (!extensionRunner) {
			return; // No hooks loaded
		}

		const actions: ExtensionActions = {
			sendMessage: (message, options) => {
				const wasStreaming = this.ctx.session.isStreaming;
				this.ctx.session
					.sendCustomMessage(message, options)
					.then(() => this.#applyCustomMessageDisplay(wasStreaming, message.display))
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
			getActiveTools: () => this.ctx.session.getActiveToolNames(),
			getAllTools: () => this.ctx.session.getAllToolNames(),
			setActiveTools: toolNames => this.ctx.session.setActiveToolsByName(toolNames),
			setModel: async model => {
				const key = await this.ctx.session.modelRegistry.getApiKey(model);
				if (!key) return false;
				await this.ctx.session.setModel(model);
				return true;
			},
			getThinkingLevel: () => this.ctx.session.thinkingLevel,
			setThinkingLevel: level => this.ctx.session.setThinkingLevel(level),
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
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				this.ctx.showStatus("Reloaded session");
			},
			newSession: async options => {
				// Stop any loading animation
				if (this.ctx.loadingAnimation) {
					this.ctx.loadingAnimation.stop();
					this.ctx.loadingAnimation = undefined;
				}
				this.ctx.statusContainer.clear();

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
				this.ctx.statusLine.setSessionStartTime(Date.now());
				this.ctx.updateEditorTopBorder();
				this.ctx.ui.requestRender();

				// Clear UI state
				this.ctx.chatContainer.clear();
				this.ctx.pendingMessagesContainer.clear();
				this.ctx.compactionQueuedMessages = [];
				this.ctx.streamingComponent = undefined;
				this.ctx.streamingMessage = undefined;
				this.ctx.pendingTools.clear();

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
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				this.ctx.editor.setText(result.selectedText);
				this.ctx.showStatus("Branched to new session");

				return { cancelled: false };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.ctx.session.navigateTree(targetId, { summarize: options?.summarize });
				if (result.cancelled) {
					return { cancelled: true };
				}

				// Update UI
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				if (result.editorText && !this.ctx.editor.getText().trim()) {
					this.ctx.editor.setText(result.editorText);
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
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				return { cancelled: false };
			},
		};

		extensionRunner.initialize(actions, contextActions, commandActions, uiContext);

		// Subscribe to extension errors
		extensionRunner.onError((error: ExtensionError) => {
			this.showExtensionError(error.extensionPath, error.error);
		});

		// Emit session_start event
		await extensionRunner.emit({
			type: "session_start",
		});
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
				container.addChild(new Spacer(1));
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
				this.ctx.session
					.sendCustomMessage(message, options)
					.then(() => this.#applyCustomMessageDisplay(wasStreaming, message.display))
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
			getActiveTools: () => this.ctx.session.getActiveToolNames(),
			getAllTools: () => this.ctx.session.getAllToolNames(),
			setActiveTools: toolNames => this.ctx.session.setActiveToolsByName(toolNames),
			setModel: async model => {
				const key = await this.ctx.session.modelRegistry.getApiKey(model);
				if (!key) return false;
				await this.ctx.session.setModel(model);
				return true;
			},
			getThinkingLevel: () => this.ctx.session.thinkingLevel,
			setThinkingLevel: (level, persist) => this.ctx.session.setThinkingLevel(level, persist),
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
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				this.ctx.showStatus("Reloaded session");
			},
			newSession: async options => {
				// Stop any loading animation
				if (this.ctx.loadingAnimation) {
					this.ctx.loadingAnimation.stop();
					this.ctx.loadingAnimation = undefined;
				}
				this.ctx.statusContainer.clear();

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
				this.ctx.chatContainer.clear();
				this.ctx.pendingMessagesContainer.clear();
				this.ctx.compactionQueuedMessages = [];
				this.ctx.streamingComponent = undefined;
				this.ctx.streamingMessage = undefined;
				this.ctx.pendingTools.clear();

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
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				this.ctx.editor.setText(result.selectedText);
				this.ctx.showStatus("Branched to new session");

				return { cancelled: false };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.ctx.session.navigateTree(targetId, { summarize: options?.summarize });
				if (result.cancelled) {
					return { cancelled: true };
				}

				// Update UI
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				if (result.editorText && !this.ctx.editor.getText().trim()) {
					this.ctx.editor.setText(result.editorText);
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
				this.ctx.chatContainer.clear();
				this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				return { cancelled: false };
			},
		};

		extensionRunner.initialize(actions, contextActions, commandActions, uiContext);
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
		for (const registeredTool of this.ctx.session.extensionRunner?.getAllRegisteredTools() ?? []) {
			if (registeredTool.definition.onSession) {
				try {
					await registeredTool.definition.onSession(event, {
						ui: uiContext,
						getContextUsage: () => this.ctx.session.getContextUsage(),
						compact: instructionsOrOptions => this.#compactSession(instructionsOrOptions),
						hasUI: true,
						cwd: this.ctx.sessionManager.getCwd(),
						sessionManager: this.ctx.session.sessionManager,
						modelRegistry: this.ctx.session.modelRegistry,
						model: this.ctx.session.model,
						models: createExtensionModelQuery(
							this.ctx.session.modelRegistry,
							this.ctx.session.settings,
							() => this.ctx.session.model,
						),
						isIdle: () => !this.ctx.session.isStreaming,
						hasPendingMessages: () => this.ctx.session.queuedMessageCount > 0,
						abort: () => {
							this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
						},
						shutdown: () => {
							// Signal shutdown request
						},
						getSystemPrompt: () => this.ctx.session.systemPrompt,
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
		const errorText = new Text(theme.fg("error", `Tool "${toolName}" error: ${error}`), 1, 0);
		this.ctx.present(errorText);
	}

	/**
	 * Set hook status text in the footer.
	 */
	setHookStatus(key: string, text: string | undefined): void {
		this.ctx.statusLine.setHookStatus(key, text);
		this.ctx.ui.requestRender();
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
	async showHookConfirm(title: string, message: string): Promise<boolean> {
		const result = await this.showHookSelector(`${title}\n${message}`, ["Yes", "No"]);
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
		options?: { overlay?: boolean },
	): Promise<T> {
		const savedText = this.ctx.editor.getText();
		const keybindings = KeybindingsManager.inMemory();

		const { promise, resolve } = Promise.withResolvers<T>();
		let component: (Component & { dispose?(): void }) | undefined;
		let overlayHandle: OverlayHandle | undefined;
		let closed = false;

		const close = (result: T) => {
			if (closed) return;
			closed = true;
			component?.dispose?.();
			overlayHandle?.hide();
			overlayHandle = undefined;
			if (!options?.overlay) {
				this.ctx.editorContainer.clear();
				this.ctx.editorContainer.addChild(this.ctx.editor);
				this.ctx.editor.setText(savedText);
			}
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
			resolve(result);
		};

		Promise.try(() => factory(this.ctx.ui, theme, keybindings, close)).then(c => {
			if (closed) {
				c.dispose?.();
				return;
			}
			component = c;
			if (options?.overlay) {
				overlayHandle = this.ctx.ui.showOverlay(component, {
					anchor: "bottom-center",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				});
				return;
			}
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(component);
			this.ctx.ui.setFocus(component);
			this.ctx.ui.requestRender();
		});
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
		const errorText = new Text(theme.fg("error", `Extension "${extensionPath}" error: ${error}`), 1, 0);
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
		setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());
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
	#presentDialog(
		signal: AbortSignal | undefined,
		present: (settle: (value: string | undefined) => void) => () => void,
	): Promise<string | undefined> {
		const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
		let settled = false;
		let started = false;
		let hide: (() => void) | undefined;

		function onAbort(): void {
			settle(undefined);
		}

		const settle = (value: string | undefined): void => {
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

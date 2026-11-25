import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createRoot, effect, type JSXNode, onCleanup, type Signal, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { bubblePaste, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import { decodeInput } from "@oh-my-pi/pi-tui/driver/input/decoder";
import { widgetContext, widgetFor } from "@oh-my-pi/pi-tui/term/widgets";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { logger } from "@oh-my-pi/pi-utils";
import type { CollabUiRequestDraft, CollabUiSelectItem } from "@oh-my-pi/pi-wire";
import type { CollabHost } from "../../collab/host";
import type {
	CompactOptions,
	ExtensionActions,
	ExtensionApprovalAnswer,
	ExtensionApprovalPrompt,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionCustomFactory,
	ExtensionCustomOptions,
	ExtensionError,
	ExtensionFormDialogResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	SendMessageHandler,
	SendUserMessageHandler,
	TerminalInputHandler,
} from "../../extensibility/extensions";
import { getSessionSlashCommands } from "../../extensibility/extensions/get-commands-handler";
import { extensionLinkClicksAvailable } from "../../extensibility/extensions/link-clicks";
import type { ExtensionUiHost } from "../../extensibility/extensions/render-types";
import { cfgExtensionAssistantTextRenderers } from "../../extensibility/settings";
import type { ComposerOwner, InteractiveModeContext, InteractiveSelectorDialogOptions } from "../../modes/types";
import { normalizeCustomMessagePayload, USER_INTERRUPT_LABEL } from "../../session/messages";
import { launchTerminal } from "../../subprocess/terminal-launch";
import { approvalAnswerForChoice, approvalChoiceLabels, approvalOnceLabel } from "../../tools/approval";
import {
	choiceValue,
	defaultFormData,
	fieldError,
	fieldQuestions,
	type HtmlFormData,
	type HtmlFormValue,
	type OptionNote,
	textValue,
} from "../../tools/html-form/data";
import { type ChoiceField, type HtmlForm, parseHtmlForm, spansText, type TextField } from "../../tools/html-form/parse";
import { extensionOutput, extensionTheme, singleNode } from "../../ui/extensions/render-output";
import { formMedia, type HtmlFormAction, HtmlFormDialog, HtmlFormModel } from "../../ui/forms/html-form";
import { htmlFormKeyHints } from "../../ui/styles/forms/html-form";
import { formatKeyHint, formatKeyHints } from "../../ui/keys/hints";
import { type ApprovalChoice, ApprovalDialog } from "../../ui/overlays/panels/approval-dialog";
import { AskDialog, AskDialogModel } from "../../ui/overlays/panels/ask-dialog";
import { HookEditor, type HookEditorHandle, HookInput } from "../../ui/overlays/panels/hook-dialogs";
import { HookSelector } from "../../ui/overlays/pickers/hook-selector";
import type { OverlayHandle, OverlayOptions } from "../../ui/shell";
import { findNode } from "../../ui/styles/panels/common";
import { registerComposerShape } from "../../ui/styles/composer/shapes";
import { getAvailableThemesWithPaths, getThemeByName, setTheme } from "../../ui/theme/service";
import { AnsiText } from "../../ui/transcript/ansi-text";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { disambiguateDisplayLabels, sanitizeCarriageReturns } from "../../utils/render-utils";
import { type BlockedKind, type BlockedStatus, holdBlockedStatus } from "../../utils/run-status";
import { setExtensionTerminalTitle, setSessionTerminalTitle } from "../../utils/title-generator";
import {
	type AskDialogPrompt,
	type AskDialogPromptDraft,
	type AskDialogPromptValue,
	normalizeDialogQuestions,
} from "../view-model/overlays/ask-dialog";
import { boundPromptTitle, type HookEditorOptions } from "../view-model/overlays/hook-editor";
import type { HookSelectorSlider } from "../view-model/overlays/hook-selector";
import { extensionOverlay } from "./extension-ui-blocks";

/**
 * Footer hint for a guest-rendered ask selector. The guest's selector handles
 * the keys, so the host can't know its bindings: advertise the defaults.
 */
function guestAskHelpText(enterAction: string, extra = ""): string {
	return `${formatKeyHints(["up", "down"])} navigate  ${formatKeyHint("enter")} ${enterAction}  ${extra}${formatKeyHint("escape")} cancel`;
}

const ASK_OTHER_OPTION = "Other (type your own)";
const ASK_CHAT_OPTION = "Chat about this";
const ASK_NEXT_OPTION = "Next →";
/** What an inline ask warns while sending the composer's draft would skip it. */
const ASK_SKIP_NOTICE = "Sending your message skips these questions";

/** The local ask shown above the composer (`#mountAsk`). */
interface MountedAsk {
	readonly node: UiNode;
	/** The view draws whether it holds the keys (the HTML form's faint state). */
	setFocused?(focused: boolean): void;
	/** Its keys on one line, for the composer under it to show while the ask holds them. */
	keyHints?(): string;
}

/** Where a local ask shows; see `#mountAsk`. */
interface AskSlot {
	/** Shows the ask again, with the keys, after a nested prompt took the composer's place. */
	restore(): void;
	/** Takes the ask down and gives the composer its place and the keys back. */
	unmount(): void;
}

function withTerminalLauncher(uiContext: ExtensionUIContext, hasUI: boolean): ExtensionUIContext {
	if (!hasUI || uiContext.openTerminal) return uiContext;
	const descriptors = Object.getOwnPropertyDescriptors(uiContext);
	descriptors.openTerminal = {
		configurable: true,
		enumerable: true,
		value: launchTerminal,
		writable: true,
	};
	return Object.create(Object.getPrototypeOf(uiContext), descriptors) as ExtensionUIContext;
}

async function editDialogExternally(text: string): Promise<string | null> {
	const command = getEditorCommand();
	return command ? openInEditor(command, text) : null;
}

interface CollabWinner<T> {
	source: "local" | "remote";
	value: T | undefined;
}
/** Tagged result from a guest UI request, distinguishing a real answer (even
 *  one whose literal value is "unavailable"), an explicit guest cancel, and a
 *  transport-unavailable sentinel (collab teardown / abort). Replaces the old
 *  `string | "unavailable" | undefined` channel that let a guest answer of
 *  "unavailable" collide with the transport sentinel. */
type GuestUiResult = { kind: "answered"; value: string } | { kind: "cancelled" } | { kind: "unavailable" };

/** A guest's answer to one form field: its value (none for an unchecked choice), a cancel, or no guest. */
type GuestFieldResult =
	| { kind: "answered"; value: HtmlFormValue | undefined }
	| { kind: "cancelled" }
	| { kind: "unavailable" };

function toWireSelectOptions(options: ExtensionUISelectItem[]): CollabUiSelectItem[] {
	return options.map(option =>
		typeof option === "string"
			? option
			: option.description
				? { label: option.label, description: option.description }
				: { label: option.label },
	);
}

/** Overlay focus on the first node of `kinds` (in order of preference) inside the view, else its root. */
function focusKind(...kinds: string[]): OverlayOptions {
	return {
		focus: root => {
			for (const kind of kinds) {
				const node = findNode(root, candidate => candidate.kind === kind);
				if (node) return node;
			}
			return root;
		},
	};
}

/** What a form held beyond its defaults (changed values, saved notes); undefined when nothing was given. */
function givenFormAnswers(
	form: HtmlForm,
	current: HtmlFormData,
	notes: OptionNote[],
): ExtensionFormDialogResult | undefined {
	const defaults = defaultFormData(form);
	const data: HtmlFormData = {};
	let changed = false;
	for (const name in current) {
		const value = current[name]!;
		if (Bun.deepEquals(value, defaults[name])) continue;
		data[name] = value;
		changed = true;
	}
	return changed || notes.length > 0 ? { data, ...(notes.length ? { notes } : {}) } : undefined;
}

/** The Decline button of a caller that tells declining from cancelling; see `ExtensionUIDialogOptions.onDismiss`. */
const DECLINE_ACTIONS: readonly HtmlFormAction[] = [{ id: "decline", label: "Decline" }];

export class ExtensionUiController {
	#extensionTerminalInputUnsubscribers = new Set<() => void>();
	#composerShapeDisposers: Array<() => void> = [];
	// The composer's place (and the ask slot above it) is shared by the selector / input /
	// editor / approval / ask / form dialogs, so only one may be presented at a time; the rest
	// queue. See `#presentDialog`.
	#dialogActive = false;
	#dialogQueue: Array<() => void> = [];
	/** The local ask shown above the composer (`#mountAsk`). */
	readonly #ask = signal<MountedAsk | undefined>(undefined);
	/**
	 * The steering messages that last denied an approval. Steering waits for the tool batch to
	 * end, so while any of them is still pending, later approvals of that batch (an exclusive call
	 * asks only after the denied one settles) are denied by it as well. Tracked by identity: once
	 * they are delivered, an equal-looking newer steer (another `[Image]` chip) predates its prompt
	 * and does not answer it.
	 */
	#denyingSteering: readonly AgentMessage[] | undefined;
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
			this.#composerShapeDisposers.push(registerComposerShape(definition));
		}
		this.ctx.syncComposerShape();
		this.ctx.syncExtensionLinks();
	}

	/** Remove extension-owned composer styles from the process registries. */
	disposeComposerShapes(): void {
		for (const dispose of this.#composerShapeDisposers.splice(0)) dispose();
	}

	/**
	 * Redraw every transcript block of the reply sent at `timestamp` (one per tool-call segment),
	 * and the link browser's copy while it is open: the reply is handed to its view again, so
	 * the assistant text renderers run anew. A plain terminal cannot repaint rows it already moved
	 * into scrollback, so a reply with retired rows rebuilds the scrollback, as the
	 * thinking-visibility toggle does (once the link browser closes, if it covers the screen); one
	 * still in the live viewport (and any block in Tern's native view) just repaints.
	 */
	#rerenderAssistantMessage(timestamp: number): void {
		if (!cfgExtensionAssistantTextRenderers.get(this.ctx.settings)) return;
		this.ctx.rerenderInLinkBrowser(timestamp);
		this.ctx.redrawTranscriptBlocks(this.ctx.shell.transcript.blocks(), (_block, entry) => {
			if (entry?.kind !== "assistant") return false;
			const message = entry.view.message.peek();
			if (message?.timestamp !== timestamp) return false;
			entry.view.message.set({ ...message });
			return true;
		});
	}

	/**
	 * Initialize the hook system with TUI-based UI context.
	 */
	async initHooksAndCustomTools(): Promise<void> {
		// Create and set hook & tool UI context
		const uiContext: ExtensionUIContext = {
			timeoutStartsOnPresentation: true,
			supportsEditor: true,
			select: (title, options, dialogOptions) => this.showCollabAwareSelector(title, options, dialogOptions),
			confirm: (title, message, dialogOptions) => this.showHookConfirm(title, message, dialogOptions),
			input: (title, placeholder, dialogOptions) => this.showHookInput(title, placeholder, dialogOptions),
			askDialog: (questions, dialogOptions) => this.showAskDialog(questions, dialogOptions),
			formDialog: (html, dialogOptions) => this.showFormDialog(html, dialogOptions),
			approve: (prompt, dialogOptions) => this.showCollabAwareApproval(prompt, dialogOptions),
			notify: (message, type) => this.showHookNotify(message, type),
			onTerminalInput: handler => this.addExtensionTerminalInputListener(handler),
			rerenderMessage: timestamp => this.#rerenderAssistantMessage(timestamp),
			refreshTranscript: ids => this.ctx.refreshTranscriptPresentation(new Set(ids)),
			getLinkClicksAvailable: extensionLinkClicksAvailable,
			setStatus: (key, text) => this.setHookStatus(key, text),
			setWorkingMessage: message => this.ctx.setWorkingMessage(message),
			setWidget: (key, content, options) => this.setHookWidget(key, content, options),
			setTitle: title => setExtensionTerminalTitle(title),
			custom: (factory, options) => this.showHookCustom(factory, options),
			setEditorText: text => this.ctx.composer.setText(text),
			pasteToEditor: text => {
				// Through the composer's paste handling (image paths, large pastes collapsed into a
				// chip) while the composer takes the keys; otherwise straight into the draft.
				if (this.#composerFocused() && this.ctx.shell.paste(text)) return;
				this.ctx.composer.insertText(text);
			},
			getEditorText: () => this.ctx.composer.text(),
			editor: (title, prefill, dialogOptions, editorOptions) =>
				this.showCollabAwareEditor(title, prefill, dialogOptions, editorOptions),
			addAutocompleteProvider: factory => this.ctx.addAutocompleteProvider(factory),
			composer: {
				addKeyHandler: handler => this.ctx.composer.addKeyHandler(key => handler(key)),
				addDecorator: decorator => this.ctx.composer.addDecorator(decorator),
				setSubmitTransform: transform => this.ctx.composer.setSubmitTransform(transform),
				setShape: (id, paddingX) => {
					if (id === undefined) this.ctx.syncComposerShape();
					else this.ctx.composer.setShape(id, paddingX);
				},
			},
			get theme() {
				return extensionTheme(currentTheme());
			},
			getAllThemes: async () => (await getAvailableThemesWithPaths()).map(t => ({ name: t.name, path: t.path })),
			getTheme: async name => {
				const theme = await getThemeByName(name);
				return theme && extensionTheme(theme);
			},
			setTheme: async themeArg => {
				if (typeof themeArg === "string") {
					return await setTheme(themeArg);
				}
				// Theme object passed directly - not supported in current implementation
				return Promise.resolve({ success: false, error: "Direct theme object not supported" });
			},
			setFooter: () => {},
			setHeader: () => {},
			getToolsExpanded: () => this.ctx.toolOutputExpanded,
			setToolsExpanded: expanded => this.ctx.setToolsExpanded(expanded),
		};
		const enrichedUiContext = withTerminalLauncher(uiContext, true);
		this.ctx.setToolUIContext(enrichedUiContext, true);
		this.#toolUIContext = enrichedUiContext;
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
			sendMessage: this.#sendExtensionMessage,
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
			shutdown: () => this.ctx.requestShutdown(),
			resolvePlanReview: (reviewId, choice, input) => this.ctx.resolvePlanReview(reviewId, choice, input),
			getPendingPlanReview: () => this.ctx.getPendingPlanReview(),
			openPlanReview: () => this.ctx.openPlanReview({ fromExtension: true }),
			sessionModes: this.ctx.sessionModes,
			keybindings: this.ctx.keybindings,
			getContextUsage: () => this.ctx.session.getContextUsage(),
			compact: instructionsOrOptions => this.#compactSession(instructionsOrOptions),
			getSystemPrompt: () => this.ctx.session.systemPrompt,
			runEphemeralTurn: args => this.ctx.session.runEphemeralTurn(args),
			startLive: options => this.ctx.startRemoteLive(options),
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
				await this.ctx.prepareSessionSwitch();
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
				this.ctx.statusLine.refresh();
				this.ctx.statusLine.resetActiveTime();
				this.ctx.clearTransientSessionUi();
				this.ctx.resetTranscript();

				this.#presentNewSessionNotice();
				await this.ctx.reloadTodos();

				return { cancelled: false };
			},
			branch: async entryId => {
				await this.ctx.prepareSessionSwitch();
				const result = await this.ctx.session.branch(entryId);
				if (result.cancelled) {
					return { cancelled: true };
				}

				// Update UI
				await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				this.ctx.composer.setDraft(result.selectedText, result.selectedImages);
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
				if (result.editorText && !this.ctx.composer.text().trim()) {
					this.ctx.composer.setDraft(result.editorText, result.editorImages);
				}
				this.ctx.showStatus("Navigated to selected point");

				return { cancelled: false };
			},
			compact: async instructionsOrOptions => this.#handleInteractiveCompact(instructionsOrOptions),
			switchSession: async sessionPath => {
				await this.ctx.prepareSessionSwitch();
				this.clearHookWidgets();
				let modelFallbackWarning: string | undefined;
				const result = await this.ctx.session.switchSession(sessionPath, {
					onModelFallback: warning => {
						modelFallbackWarning = warning;
					},
				});
				if (!result) {
					return { cancelled: true };
				}
				setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());
				await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				if (modelFallbackWarning) this.ctx.showWarning(modelFallbackWarning);
				return { cancelled: false };
			},
		};

		extensionRunner.initialize(actions, contextActions, commandActions, enrichedUiContext, "tui");

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

	/**
	 * Set widget `key` above or below the composer: lines as they are; a factory's output (pi-tui
	 * nodes or a rows object) adapted, repainting rows when the factory's host asks.
	 */
	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		const placement = options?.placement ?? "aboveEditor";
		if (content === undefined || Array.isArray(content)) {
			this.ctx.hud.widgets.set(key, content, placement);
			return;
		}
		const factory = content as Exclude<ExtensionWidgetContent, readonly string[] | undefined>;
		this.ctx.hud.widgets.set(
			key,
			() => {
				const revision = signal(0);
				return extensionOutput(factory(this.#uiHost(revision), extensionTheme(currentTheme())), {
					revision,
					onError: error => this.#reportRenderError(`widget "${key}"`, error),
				});
			},
			placement,
		);
	}

	/** What extension UI factories receive: `requestRender` bumps `revision`, which rows views read. */
	#uiHost(revision: Signal<number>): ExtensionUiHost {
		return {
			requestRender: () => revision.set(revision.peek() + 1),
			size: () => this.ctx.shell.size(),
			suspend: run => this.ctx.suspend(run),
		};
	}

	#reportRenderError(what: string, error: unknown): void {
		this.ctx.showWarning(
			`Extension ${what} failed to render: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	#presentNewSessionNotice(): void {
		const theme = currentTheme();
		const text = theme.fg("accent", `${theme.symbols.symbol("status.success")} New session started`);
		this.ctx.present(() => AnsiText({ text, padX: 1, padY: 1 }));
	}

	initializeHookRunner(uiContext: ExtensionUIContext, _hasUI: boolean): void {
		const extensionRunner = this.ctx.session.extensionRunner;
		if (!extensionRunner) {
			return;
		}

		const actions: ExtensionActions = {
			sendMessage: this.#sendExtensionMessage,
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
			shutdown: () => this.ctx.requestShutdown(),
			resolvePlanReview: (reviewId, choice, input) => this.ctx.resolvePlanReview(reviewId, choice, input),
			getPendingPlanReview: () => this.ctx.getPendingPlanReview(),
			openPlanReview: () => this.ctx.openPlanReview({ fromExtension: true }),
			sessionModes: this.ctx.sessionModes,
			keybindings: this.ctx.keybindings,
			getContextUsage: () => this.ctx.session.getContextUsage(),
			compact: instructionsOrOptions => this.#compactSession(instructionsOrOptions),
			getSystemPrompt: () => this.ctx.session.systemPrompt,
			runEphemeralTurn: args => this.ctx.session.runEphemeralTurn(args),
			startLive: options => this.ctx.startRemoteLive(options),
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
				await this.ctx.prepareSessionSwitch();
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

				this.#presentNewSessionNotice();
				await this.ctx.reloadTodos();

				return { cancelled: false };
			},
			branch: async entryId => {
				await this.ctx.prepareSessionSwitch();
				const result = await this.ctx.session.branch(entryId);
				if (result.cancelled) {
					return { cancelled: true };
				}

				// Update UI
				await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				this.ctx.composer.setDraft(result.selectedText, result.selectedImages);
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
				if (result.editorText && !this.ctx.composer.text().trim()) {
					this.ctx.composer.setDraft(result.editorText, result.editorImages);
				}
				this.ctx.showStatus("Navigated to selected point");

				return { cancelled: false };
			},
			compact: async instructionsOrOptions => this.#handleInteractiveCompact(instructionsOrOptions),
			switchSession: async sessionPath => {
				await this.ctx.prepareSessionSwitch();
				this.clearHookWidgets();
				let modelFallbackWarning: string | undefined;
				const result = await this.ctx.session.switchSession(sessionPath, {
					onModelFallback: warning => {
						modelFallbackWarning = warning;
					},
				});
				if (!result) {
					return { cancelled: true };
				}
				await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				if (modelFallbackWarning) this.ctx.showWarning(modelFallbackWarning);
				return { cancelled: false };
			},
		};

		const runnerUiContext = withTerminalLauncher(uiContext, _hasUI);
		extensionRunner.initialize(actions, contextActions, commandActions, runnerUiContext, "tui");
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
		const text = currentTheme().fg("error", `Tool "${toolName}" error: ${error}`);
		this.ctx.present(() => AnsiText({ text, padX: 1 }));
	}

	/**
	 * Set hook status text in the footer.
	 */
	setHookStatus(key: string, text: string | undefined): void {
		this.ctx.statusLine.setHookStatus(key, text);
	}

	async showCollabAwareSelector(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
		extra?: { slider?: HookSelectorSlider; kind?: BlockedKind },
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
			...(extra?.kind === "permission" ? { approval: true } : {}),
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

	/**
	 * The tool-approval prompt in the composer's place; a collab guest answers it as a select over
	 * the full prompt with the same choices ({@link approvalChoiceLabels}): the prompt's grants when
	 * it offers any, Approve, its "for this session" choice when it offers one, and Deny. Locally it
	 * shows the compact prompt (the details summarized to a
	 * row, so the composer beneath keeps its room) over that list, and the expand key
	 * swaps in the full one, wrapped — even when the two match, since a row the summary kept whole
	 * can still clip. The composer stays mounted beneath it and takes the typing: a user message
	 * queued as steering while the call waits (sent here, from Tern, or by a collab guest) denies
	 * the call, so the message tells the agent why instead of a bare denial. The watch starts with
	 * the request, so approvals still queued behind another dialog are denied by the same message.
	 */
	async showCollabAwareApproval(
		prompt: ExtensionApprovalPrompt,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionApprovalAnswer> {
		const sessionLabel = prompt.session;
		const onceLabel = approvalOnceLabel(prompt);
		const request: CollabUiRequestDraft = {
			kind: "select",
			title: prompt.full,
			options: approvalChoiceLabels(prompt),
			approval: true,
		};
		const session = this.ctx.session;
		const agent = session.agent;
		const pendingSteering = agent.peekSteeringQueue();
		if (this.#denyingSteering?.some(message => pendingSteering.includes(message))) return "deny";
		this.#denyingSteering = undefined;
		const steered = new AbortController();
		let steeringBaseline = session.getQueuedMessages().steering.length;
		let knownSteering = new Set(pendingSteering);
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "queue_update" || steered.signal.aborted) return;
			const current = agent.peekSteeringQueue();
			if (event.steering.length > steeringBaseline) {
				const added = current.filter(message => !knownSteering.has(message));
				this.#denyingSteering = added;
				// One-at-a-time delivery takes the oldest steer at the batch boundary; the
				// message that denied this call must be the one that lands after the denial.
				agent.prioritizeSteering(added);
				steered.abort();
			} else {
				steeringBaseline = event.steering.length;
				knownSteering = new Set(current);
			}
		});
		const signal = dialogOptions?.signal ? AbortSignal.any([dialogOptions.signal, steered.signal]) : steered.signal;
		try {
			const choice = await this.#raceCollabDialog(request, signal, localSignal =>
				this.#presentDialog({ kind: "permission", msg: prompt.compact }, localSignal, settle => {
					const composer = this.ctx.composer;
					const grants = prompt.grants ?? [];
					const answer = (choice: ApprovalChoice): void => {
						if (choice.kind === "once") settle(onceLabel);
						else if (choice.kind === "session") settle(sessionLabel);
						else {
							const grant = grants[choice.index];
							settle(grant && (choice.remember ? grant.alwaysLabel : grant.label));
						}
					};
					const hasDraft = (): boolean => composer.text().length > 0 || composer.pendingImages.length > 0;
					// Keep focus on the dialog, but give edits, pastes and undo to the real composer field.
					const field = composer.field;
					const path = pathTo([composer.node], field);
					const fieldContext = () =>
						widgetContext(path, {
							focus: node => this.ctx.shell.focus(node),
							pageRows: this.ctx.shell.size().rows,
						});
					this.ctx.closeLinkBrowser();
					// Right over the composer, which stays and takes the typing the dialog hands it.
					const slot = this.ctx.shell.dock.slot("approval");
					let node: UiNode | undefined;
					slot.set(
						() =>
							(node = singleNode(
								ApprovalDialog({
									prompt: prompt.compact,
									onApprove: answer,
									onDeny: () => settle("Deny"),
									options: {
										fullPrompt: prompt.full,
										timeout: dialogOptions?.timeout,
										onTimeout: dialogOptions?.onTimeout,
										onTimeoutStart: dialogOptions?.onTimeoutStart,
										onTimeoutReset: dialogOptions?.onTimeoutReset,
										...(sessionLabel ? { session: { label: sessionLabel } } : {}),
										...(grants.length > 0 ? { grants } : {}),
										draft: {
											hasDraft,
											handleInput: key => {
												if (this.ctx.keybindings.matches(key, "app.clear")) composer.clearDraft();
												else if (this.ctx.keybindings.matches(key, "app.clipboard.pasteImage"))
													void this.ctx.handleImagePaste();
												else if (!composer.handleDraftKey(key))
													widgetFor(field)?.key?.(field, key, fieldContext());
											},
											handlePaste: paste => {
												if (!bubblePaste(path, paste))
													widgetFor(field)?.paste?.(field, paste, fieldContext());
											},
										},
									},
								}),
							)),
					);
					if (node) this.ctx.shell.focus(node);
					// Its submissions steer this (main) session, even from a focused agent's view.
					this.ctx.approvalOwnsComposer = true;
					const releaseComposerOwner = node ? this.#claimComposerOwner(node, () => true) : () => {};
					return () => {
						this.ctx.approvalOwnsComposer = false;
						releaseComposerOwner();
						slot.clear();
						this.#focusComposer();
					};
				}),
			);
			return approvalAnswerForChoice(prompt, choice);
		} finally {
			unsubscribe();
		}
	}

	async showAskDialog(
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		// Normalize the public extension input once for both race participants:
		// malformed entries (missing/non-string fields) coerce to empty
		// strings/arrays here instead of throwing inside `sanitizeCarriageReturns`
		// on the guest path or taking down the local render.
		const normalized = normalizeDialogQuestions(questions);
		return this.#raceGuestDialog(
			dialogOptions,
			options => this.#showLocalAskDialog(normalized, options),
			(host, signal) => this.#runGuestAskDialog(host, normalized, signal),
		);
	}

	/**
	 * An agent-written HTML form in the composer's place ({@link HtmlFormDialog}). A collab
	 * guest answers it field by field — a select per choice group, an editor per text field —
	 * and the first side to finish wins, as {@link showAskDialog}.
	 */
	async showFormDialog(
		html: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionFormDialogResult | undefined> {
		const form = parseHtmlForm(html);
		return this.#raceGuestDialog(
			dialogOptions,
			options => this.#showLocalFormDialog(form, options),
			(host, signal) => this.#runGuestForm(host, form, signal),
		);
	}

	/**
	 * Race a local multi-step dialog against its guest mirror. First answer (or
	 * cancel) wins and aborts the other side; a guest `unavailable` leaves the
	 * local dialog running and returns its eventual result.
	 */
	async #raceGuestDialog<T>(
		dialogOptions: ExtensionUIDialogOptions | undefined,
		local: (dialogOptions: ExtensionUIDialogOptions | undefined) => Promise<T | undefined>,
		remote: (host: CollabHost, signal: AbortSignal) => Promise<T | "unavailable" | undefined>,
	): Promise<T | undefined> {
		const host = this.ctx.collabHost;
		if (!host) return local(dialogOptions);
		const localAbort = new AbortController();
		const remoteAbort = new AbortController();
		const parentSignal = dialogOptions?.signal;
		const localSignal = parentSignal ? AbortSignal.any([parentSignal, localAbort.signal]) : localAbort.signal;
		const remoteSignal = parentSignal ? AbortSignal.any([parentSignal, remoteAbort.signal]) : remoteAbort.signal;
		const localWinner = local({ ...dialogOptions, signal: localSignal }).then((value): CollabWinner<T> => ({
			source: "local",
			value,
		}));
		const remoteWinner: Promise<CollabWinner<T>> = remote(host, remoteSignal).then(result =>
			result === "unavailable" ? localWinner : { source: "remote", value: result },
		);
		const winner = await Promise.race([localWinner, remoteWinner]);
		if (winner.source === "remote") localAbort.abort();
		else remoteAbort.abort();
		return winner.value;
	}

	/**
	 * What the composer shows about the ask waiting above it: `pending` while one waits, `skip` while
	 * sending its draft would skip it; undefined with no ask or with the composer talking to a `/btw` note.
	 */
	composerAsk(): "pending" | "skip" | undefined {
		if (!this.#ask() || this.ctx.isBtwFocused) return undefined;
		return this.#draftSkipsAsk() ? "skip" : "pending";
	}

	/** Whether an ask waits above the composer while the keys are away from the composer (it draws faint). */
	askHoldsKeys(): boolean {
		return this.#ask() !== undefined && !this.#composerFocused();
	}

	/** In rows, the keys of the ask holding them, which the faint composer under it shows. */
	askKeyHints(): string | undefined {
		return this.askHoldsKeys() ? this.#ask()?.keyHints?.() : undefined;
	}

	/** Gives the keys to the ask waiting above the composer; false when none waits. */
	focusAsk(): boolean {
		const ask = this.#ask.peek();
		if (!ask) return false;
		this.ctx.shell.focus(ask.node);
		ask.setFocused?.(true);
		return true;
	}

	/** Gives the keys to the composer (Tab past an ask's last stop, the ask closing). */
	#focusComposer(): void {
		this.#ask.peek()?.setFocused?.(false);
		this.ctx.shell.focus(this.ctx.composer.field);
	}

	#composerFocused(): boolean {
		return this.ctx.shell.focused() === this.ctx.composer.field;
	}

	/**
	 * Whether sending the composer's draft now skips the ask shown: a plain message, which reaches the
	 * agent as the user's and closes the ask, not a command, a shell run or a `/btw` follow-up.
	 */
	#draftSkipsAsk(): boolean {
		if (!this.#ask() || this.ctx.isBtwFocused || this.ctx.isBashMode || this.ctx.isPythonMode || this.ctx.isBtwMode)
			return false;
		const draft = this.ctx.composer.text().trim();
		return draft.length > 0 && !draft.startsWith("/");
	}

	/** The ask's warning while sending the composer's draft would skip it, with the key back to it. */
	#skipNotice(): string | undefined {
		if (!this.#draftSkipsAsk()) return undefined;
		const back = this.ctx.keybindings.keysFor("app.thinking.cycle")[0];
		return this.#composerFocused() && back
			? `${ASK_SKIP_NOTICE} · ${formatKeyHint(back)} answers them`
			: ASK_SKIP_NOTICE;
	}

	/**
	 * Shows a local ask above the composer, which stays: natively (Tern) at the transcript's end, in rows
	 * just over it. The ask takes the keys unless the composer holds a draft, whose sending skips it;
	 * Shift+Tab, Tab past the ask's last stop and clicks move the keys between them.
	 */
	#mountAsk(view: () => JSXNode, setFocused?: (focused: boolean) => void, keyHints?: () => string): AskSlot {
		this.ctx.closeLinkBrowser();
		const slot = this.ctx.shell.dock.slot("ask");
		let node: UiNode | undefined;
		slot.set(() => (node = singleNode(view())));
		const ask: MountedAsk = { node: node!, setFocused, keyHints };
		this.#ask.set(ask);
		this.ctx.statusLine.setAwaitingAnswer(true);
		if (this.ctx.composer.text().trim()) setFocused?.(false);
		else this.focusAsk();
		return {
			restore: () => {
				this.focusAsk();
			},
			unmount: () => {
				if (this.#ask.peek() === ask) this.#ask.set(undefined);
				slot.clear();
				this.ctx.statusLine.setAwaitingAnswer(this.#ask.peek() !== undefined);
				this.#focusComposer();
			},
		};
	}

	/** Image pastes stop going to the prompt at `node` (it closed). */
	#releasePromptPasteTarget(node: UiNode): void {
		if (this.ctx.promptPasteTarget?.node === node) this.ctx.promptPasteTarget = undefined;
	}

	/** Registers `node` as the composer's owner; the returned release clears it only if it is still registered. */
	#claimComposerOwner(node: UiNode, owns: () => boolean): () => void {
		const owner: ComposerOwner = { node, owns };
		this.ctx.composerOwner = owner;
		return () => {
			if (this.ctx.composerOwner === owner) this.ctx.composerOwner = undefined;
		};
	}

	#showLocalFormDialog(
		form: HtmlForm,
		dialogOptions: ExtensionUIDialogOptions | undefined,
	): Promise<ExtensionFormDialogResult | undefined> {
		const first = form.fields.find(field => field.name);
		const prompt = { kind: "question", msg: first && fieldQuestions(form).get(first) } as const;
		const onDismiss = dialogOptions?.onDismiss;
		return this.#presentDialog<ExtensionFormDialogResult>(prompt, dialogOptions?.signal, settle => {
			const withNotes = (data: HtmlFormData, notes: OptionNote[]) => ({ data, ...(notes.length ? { notes } : {}) });
			// Tell a caller that tells declining from cancelling how the form ended; the dialog closes whatever it does.
			const dismiss = (action: "decline" | "cancel" | undefined): void => {
				try {
					if (action) onDismiss?.(action);
				} catch (error) {
					logger.warn("Form dialog onDismiss threw", { action, error: String(error) });
				}
				settle(undefined);
			};
			const model = new HtmlFormModel(
				form,
				{
					onSubmit: (data, notes) => settle(withNotes(data, notes)),
					onCancel: () => dismiss("cancel"),
					onAction: id => dismiss(id === "decline" ? "decline" : undefined),
					onTimeout: (data, notes) => {
						dialogOptions?.onTimeout?.();
						settle({ ...withNotes(data, notes), timedOut: true });
					},
					claimKeys: () => this.focusAsk(),
					releaseKeys: () => this.#focusComposer(),
					// Clipboard text lands in the focused box through the dialog's paste; images are refused there.
					onPasteClipboard: () => this.ctx.handleImagePaste(),
					...(dialogOptions?.acceptImages
						? {
								onPasteImage: () => void this.ctx.handleImagePaste(),
								onPasteImagePath: (path: string) => void this.ctx.handleImagePathPaste(path),
							}
						: {}),
				},
				{
					focused: false,
					vim: this.ctx.dialogVim(),
					native: () => this.ctx.shell.native(),
					// A caller that tells declining from cancelling (an MCP elicitation) also gets Decline beside Cancel.
					actions: onDismiss ? DECLINE_ACTIONS : undefined,
				},
			);
			const media = formMedia(form, this.ctx.sessionManager.getCwd());
			const timeout = dialogOptions?.timeout;
			const slot = this.#mountAsk(
				() => {
					// The form's countdown reads the clock reactively: tick it while one runs.
					const now = signal(Date.now());
					if (timeout !== undefined) {
						const ticker = setInterval(() => now.set(Date.now()), Math.min(250, Math.max(1, timeout)));
						onCleanup(() => clearInterval(ticker));
					}
					return HtmlFormDialog({
						model,
						media,
						now,
						timeout,
						terminalRows: () => this.ctx.shell.size().rows,
						skipNotice: () => this.#skipNotice(),
					});
				},
				focused => model.focused.set(focused),
				() => htmlFormKeyHints(model),
			);
			// Option notes take pasted images while one is being written.
			const askNode = this.#ask.peek()?.node;
			const stopNotePaste =
				dialogOptions?.acceptImages && askNode
					? createRoot(dispose => {
							effect(() => {
								if (model.note())
									this.ctx.promptPasteTarget = {
										node: askNode,
										attachImage: (image, dims) => void model.attachNoteImage(image, dims),
										setText: text => void model.setNoteText(text),
									};
								else this.#releasePromptPasteTarget(askNode);
							});
							return () => {
								dispose();
								this.#releasePromptPasteTarget(askNode);
							};
						})
					: undefined;
			return () => {
				stopNotePaste?.();
				// Closed by its signal (a message sent instead, the turn aborted): what was answered goes along.
				if (dialogOptions?.signal?.aborted) {
					const given = givenFormAnswers(form, model.data(), model.notes());
					if (given) dialogOptions.onAbandon?.(given);
				}
				slot.unmount();
			};
		});
	}

	/**
	 * A guest's run through the form: every named field in order, each choice
	 * group as a select (defaults preselected), each text field as an editor
	 * prefilled with its value. An answer breaking the form's rules is asked
	 * again with the reason; sending the same text again keeps it.
	 */
	async #runGuestForm(
		host: CollabHost,
		form: HtmlForm,
		signal: AbortSignal,
	): Promise<ExtensionFormDialogResult | "unavailable" | undefined> {
		const questions = fieldQuestions(form);
		const data: HtmlFormData = Object.fromEntries(form.hidden);
		for (const field of form.fields) {
			if (!field.name) continue;
			const question = sanitizeCarriageReturns(questions.get(field) ?? field.name);
			const result =
				field.kind === "choice"
					? await this.#runGuestFormChoice(host, field, question, signal)
					: await this.#runGuestFormText(host, field, question, signal);
			if (result.kind === "unavailable") return "unavailable";
			if (result.kind === "cancelled") return undefined;
			if (result.value !== undefined) data[field.name] = result.value;
		}
		return { data };
	}

	async #runGuestFormChoice(
		host: CollabHost,
		field: ChoiceField,
		question: string,
		signal: AbortSignal,
	): Promise<GuestFieldResult> {
		const enabled = field.options.flatMap((option, index) => (option.disabled ? [] : [index]));
		// Nothing a guest could pick: the group contributes nothing, as in the local form.
		if (enabled.length === 0 && !field.other) return { kind: "answered", value: undefined };
		const checked = new Set(enabled.filter(index => field.options[index]!.checked));
		const labels = disambiguateDisplayLabels(
			enabled.map(index => {
				const option = field.options[index]!;
				return sanitizeCarriageReturns(spansText(option.label).trim() || option.value);
			}),
			[ASK_OTHER_OPTION, ASK_NEXT_OPTION],
		);
		// Radio and checkbox groups end with a free-text Other row.
		const rows = field.other ? [...labels, ASK_OTHER_OPTION] : labels;
		if (!field.multi) {
			// Several checked radios: the last wins, as in the local form.
			const preselected = enabled.findLastIndex(index => checked.has(index));
			while (true) {
				const choice = await this.#requestGuestUiString(
					host,
					{
						kind: "select",
						title: question,
						options: rows,
						initialIndex: Math.max(0, preselected),
						selectionMarker: "radio",
						helpText: guestAskHelpText("select"),
					},
					signal,
				);
				if (choice.kind !== "answered") return choice;
				if (field.other && choice.value === ASK_OTHER_OPTION) {
					const typed = await this.#requestGuestOtherText(host, question, signal);
					if (typed.kind === "unavailable") return typed;
					// A cancelled or blank Other answer re-shows the options.
					if (typed.kind === "cancelled" || !typed.value.trim()) continue;
					return { kind: "answered", value: choiceValue(field, new Set(), typed.value) };
				}
				const picked = enabled[labels.indexOf(choice.value)];
				return { kind: "answered", value: choiceValue(field, new Set(picked === undefined ? [] : [picked])) };
			}
		}
		let other: string | undefined;
		while (true) {
			const checkedIndices = enabled.flatMap((index, row) => (checked.has(index) ? [row] : []));
			if (other !== undefined) checkedIndices.push(labels.length);
			const choice = await this.#requestGuestUiString(
				host,
				{
					kind: "select",
					title: question,
					options: [...rows, ASK_NEXT_OPTION],
					selectionMarker: "checkbox",
					checkedIndices,
					markableCount: rows.length,
					helpText: guestAskHelpText("toggle", `${ASK_NEXT_OPTION} continue  `),
				},
				signal,
			);
			if (choice.kind !== "answered") return choice;
			if (choice.value === ASK_NEXT_OPTION) return { kind: "answered", value: choiceValue(field, checked, other) };
			if (field.other && choice.value === ASK_OTHER_OPTION) {
				if (other !== undefined) {
					other = undefined;
					continue;
				}
				const typed = await this.#requestGuestOtherText(host, question, signal);
				if (typed.kind === "unavailable") return typed;
				// A cancelled or blank Other answer leaves Other unchecked.
				if (typed.kind === "answered" && typed.value.trim()) other = typed.value;
				continue;
			}
			const toggled = enabled[labels.indexOf(choice.value)];
			if (toggled === undefined) continue;
			if (!checked.delete(toggled)) checked.add(toggled);
		}
	}

	/** A guest's free-text "Other" answer to a choice group, on one line. */
	async #requestGuestOtherText(host: CollabHost, question: string, signal: AbortSignal): Promise<GuestUiResult> {
		const input = await this.#requestGuestUiString(host, { kind: "editor", title: question }, signal);
		return input.kind === "answered" ? { kind: "answered", value: input.value.replace(/[\r\n]+/g, " ") } : input;
	}

	async #runGuestFormText(
		host: CollabHost,
		field: TextField,
		question: string,
		signal: AbortSignal,
	): Promise<GuestFieldResult> {
		let text = field.value;
		let error: string | undefined;
		while (true) {
			const input = await this.#requestGuestUiString(
				host,
				{ kind: "editor", title: error ? `${question} (${error})` : question, prefill: text },
				signal,
			);
			if (input.kind !== "answered") return input;
			// A single-line input cannot hold line breaks.
			const next = field.multiline ? input.value : input.value.replace(/[\r\n]+/g, " ");
			const value = textValue(field, next);
			// The reason is shown once; the same text sent back over it stands.
			if (error !== undefined && next === text) return { kind: "answered", value };
			text = next;
			error = fieldError(field, value);
			if (!error) return { kind: "answered", value };
		}
	}

	#showLocalAskDialog(
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		const prompt = { kind: "question", msg: questions[0]?.question } as const;
		return this.#presentDialog<ExtensionAskDialogResult>(prompt, dialogOptions?.signal, settle => {
			let promptEditor: OverlayHandle | undefined;
			let promptResolve: ((value: AskDialogPromptValue | AskDialogPromptDraft | undefined) => void) | undefined;
			let closed = false;
			// After a nested prompt took the composer's place: the composer back, the keys to the ask.
			const restoreAskDialog = (): void => {
				if (!closed) slot.restore();
			};

			const finishPrompt = (value: AskDialogPromptValue | AskDialogPromptDraft | undefined): void => {
				const resolvePrompt = promptResolve;
				promptResolve = undefined;
				if (promptEditor) this.#releasePromptPasteTarget(promptEditor.node);
				promptEditor?.close();
				promptEditor = undefined;
				resolvePrompt?.(value);
				// Let the ask apply the answer and clear its prompt guard before making it
				// interactive again. This single-hop deferral relies on the model clearing its
				// prompt guard in the synchronous resume after its lone `await` of the prompt (no
				// await before the `finally`); adding one there reopens the drop-Enter race, so
				// revisit this deferral then.
				queueMicrotask(restoreAskDialog);
			};

			const openPrompt = (
				prompt: AskDialogPrompt,
				prefill: string | undefined,
				options: HookEditorOptions,
			): void => {
				this.ctx.closeLinkBrowser();
				let editor: HookEditorHandle | undefined;
				promptEditor = this.ctx.showEditorAreaDialog(
					() =>
						HookEditor({
							ref: handle => {
								editor = handle;
							},
							title: prompt.title,
							prefill,
							options: {
								promptStyle: true,
								externalEditor: editDialogExternally,
								question: prompt.question,
								maxHeight: this.#dialogEditorRows(),
								...options,
							},
							vim: this.ctx.dialogVim(),
							onSubmit: (text, images) => finishPrompt({ text, images: images && [...images] }),
							onCancel: (text, images) => finishPrompt({ draft: { text, images: images && [...images] } }),
						}),
					focusKind("editor"),
				);
				// Image pastes (the paste-image key, an image-only clipboard, dropped paths) attach to the answer.
				if (options.acceptImages)
					this.ctx.promptPasteTarget = {
						node: promptEditor.node,
						attachImage: (image, dims) => {
							const marker = editor?.attachImage(image, dims);
							if (marker) editor?.paste(marker);
						},
						setText: text => editor?.setText(text),
					};
			};

			const promptForText = (
				prompt: AskDialogPrompt,
				prefill?: string,
			): Promise<string | AskDialogPromptDraft | undefined> => {
				if (closed) return Promise.resolve(undefined);
				const { promise, resolve } = Promise.withResolvers<string | AskDialogPromptDraft | undefined>();
				promptResolve = value => resolve(value === undefined || "draft" in value ? value : value.text);
				openPrompt(prompt, prefill, {});
				return promise;
			};

			const promptWithImages = (
				prompt: AskDialogPrompt,
				prefill: AskDialogPromptValue | undefined,
			): Promise<AskDialogPromptValue | AskDialogPromptDraft | undefined> => {
				if (closed) return Promise.resolve(undefined);
				const { promise, resolve } = Promise.withResolvers<
					AskDialogPromptValue | AskDialogPromptDraft | undefined
				>();
				promptResolve = resolve;
				openPrompt(prompt, prefill?.text, {
					acceptImages: true,
					images: prefill?.images,
					onPasteImage: () => this.ctx.handleImagePaste(),
					onPasteImagePath: path => this.ctx.handleImagePathPaste(path),
				});
				return promise;
			};

			const model = new AskDialogModel(
				questions,
				{
					onSubmit: result => settle(result),
					onCancel: () => settle(undefined),
					onPrompt: promptForText,
					onImagePrompt: dialogOptions?.acceptImages ? promptWithImages : undefined,
				},
				{
					timeout: dialogOptions?.timeout,
					onTimeout: dialogOptions?.onTimeout,
					skipNotice: () => this.#skipNotice(),
					claimKeys: () => this.focusAsk(),
					releaseKeys: () => this.#focusComposer(),
					terminalRows: () => this.ctx.shell.size().rows,
				},
			);
			const slot = this.#mountAsk(() => AskDialog({ model }));

			return () => {
				closed = true;
				if (promptEditor) this.#releasePromptPasteTarget(promptEditor.node);
				promptEditor?.close();
				promptResolve?.(undefined);
				promptResolve = undefined;
				promptEditor = undefined;
				slot.unmount();
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
			{ retainOnReconnect: true },
		);
		if (!remote) return local(signal);
		const localWinner = local(signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal).then(
			(value): CollabWinner<string> => ({ source: "local", value }),
		);
		const remoteWinner: Promise<CollabWinner<string>> = remote.then(result =>
			result.kind === "answered" ? { source: "remote", value: result.value } : localWinner,
		);
		const winner = await Promise.race([localWinner, remoteWinner]);
		if (winner.source === "remote") localAbort.abort();
		else remoteAbort.abort();
		return winner.value;
	}

	async #runGuestAskDialog(
		host: CollabHost,
		questions: ExtensionAskDialogQuestion[],
		signal: AbortSignal,
	): Promise<ExtensionAskDialogResult | "unavailable" | undefined> {
		const results: ExtensionAskDialogResultItem[] = [];
		for (const question of questions) {
			const result = await this.#runGuestAskQuestion(host, question, signal);
			if (result === "unavailable" || result === undefined) return result;
			if (result === "chat") return { kind: "chat" };
			results.push(result);
		}
		return { kind: "submit", results };
	}

	async #runGuestAskQuestion(
		host: CollabHost,
		question: ExtensionAskDialogQuestion,
		signal: AbortSignal,
	): Promise<ExtensionAskDialogResultItem | "chat" | "unavailable" | undefined> {
		const selected = new Set<string>();
		let customInput: string | undefined;
		// Sanitize display copies for the guest wire (same degeneration as
		// the local dialog). `selected` and results keep the ORIGINAL labels
		// so both race winners echo identical correlation values. Display
		// labels are unique and sentinel-safe; the suffix maps back below.
		const displayLabels = disambiguateDisplayLabels(
			question.options.map(option => option.label),
			[ASK_OTHER_OPTION, ASK_CHAT_OPTION, ASK_NEXT_OPTION],
		);
		const originalByDisplay = new Map<string, string>();
		question.options.forEach((option, index) => {
			originalByDisplay.set(displayLabels[index]!, option.label);
		});
		// Map a guest answer (a display label, suffix included) back to the
		// original correlation value; unknown values pass through and are
		// ignored at result build, as before.
		const resolveGuestLabel = (value: string): string => originalByDisplay.get(value) ?? value;
		const displayQuestion = sanitizeCarriageReturns(question.question);
		const baseOptions: CollabUiSelectItem[] = question.options.map((option, index) =>
			option.description?.trim()
				? { label: displayLabels[index]!, description: sanitizeCarriageReturns(option.description.trim()) }
				: displayLabels[index]!,
		);
		if (question.multi) {
			while (true) {
				const checkedIndices = question.options
					.map((option, index) => (selected.has(option.label) ? index : -1))
					.filter(index => index >= 0);
				// Next is always offered: an empty answer is the guest's to give, as in the local dialog.
				const options = [...baseOptions, ASK_OTHER_OPTION, ASK_NEXT_OPTION, ASK_CHAT_OPTION];
				const choice = await this.#requestGuestUiString(
					host,
					{
						kind: "select",
						title: displayQuestion,
						options,
						selectionMarker: "checkbox",
						checkedIndices,
						markableCount: question.options.length,
						helpText: guestAskHelpText("toggle", `${ASK_NEXT_OPTION} continue  `),
					},
					signal,
				);
				if (choice.kind === "unavailable") return "unavailable";
				if (choice.kind === "cancelled") return undefined;
				if (choice.value === ASK_CHAT_OPTION) return "chat";
				if (choice.value === ASK_NEXT_OPTION) break;
				if (choice.value === ASK_OTHER_OPTION) {
					const input = await this.#requestGuestUiString(
						host,
						{ kind: "editor", title: boundPromptTitle("Custom answer: ", displayQuestion) },
						signal,
					);
					if (input.kind === "unavailable") return "unavailable";
					// Guest cancelled the Other editor: keep the ask open and
					// return to the option list instead of cancelling the whole ask.
					if (input.kind === "cancelled") continue;
					customInput = input.value;
					break;
				}
				const picked = resolveGuestLabel(choice.value);
				if (selected.has(picked)) selected.delete(picked);
				else selected.add(picked);
			}
		} else {
			const recommended =
				typeof question.recommended === "number" && Number.isInteger(question.recommended)
					? question.recommended
					: 0;
			const initialIndex = Math.max(0, Math.min(recommended, Math.max(0, question.options.length - 1)));
			while (true) {
				const choice = await this.#requestGuestUiString(
					host,
					{
						kind: "select",
						title: displayQuestion,
						options: [...baseOptions, ASK_OTHER_OPTION, ASK_CHAT_OPTION],
						initialIndex,
						selectionMarker: "radio",
						markableCount: question.options.length,
						helpText: guestAskHelpText("select"),
					},
					signal,
				);
				if (choice.kind === "unavailable") return "unavailable";
				if (choice.kind === "cancelled") return undefined;
				if (choice.value === ASK_CHAT_OPTION) return "chat";
				if (choice.value === ASK_OTHER_OPTION) {
					const input = await this.#requestGuestUiString(
						host,
						{ kind: "editor", title: boundPromptTitle("Custom answer: ", displayQuestion) },
						signal,
					);
					if (input.kind === "unavailable") return "unavailable";
					// Guest cancelled the Other editor: re-show the select list
					// instead of cancelling the whole ask.
					if (input.kind === "cancelled") continue;
					customInput = input.value;
				} else {
					selected.add(resolveGuestLabel(choice.value));
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

	async #requestGuestUiString(
		host: CollabHost,
		request: CollabUiRequestDraft,
		signal: AbortSignal,
	): Promise<GuestUiResult> {
		const remote = host.requestGuestUi(request, signal, { retainOnReconnect: true });
		if (!remote) return { kind: "unavailable" };
		const result = await remote;
		if (result.kind === "unavailable") return { kind: "unavailable" };
		return typeof result.value === "string" ? { kind: "answered", value: result.value } : { kind: "cancelled" };
	}

	/**
	 * Show a selector for hooks; it reports a `question` unless `extra.kind` says otherwise.
	 */
	showHookSelector(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
		extra?: { slider?: HookSelectorSlider; kind?: BlockedKind },
	): Promise<string | undefined> {
		return this.#presentDialog({ kind: extra?.kind ?? "question", msg: title }, dialogOptions?.signal, settle => {
			const maxVisible = Math.max(4, Math.min(15, this.ctx.shell.size().rows - 12));
			this.ctx.closeLinkBrowser();
			this.ctx.hookSelector = this.ctx.showEditorAreaDialog(
				() =>
					HookSelector({
						title,
						options,
						onSelect: option => settle(option),
						onCancel: () => settle(undefined),
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
						outline: dialogOptions?.outline,
						disabledIndices: dialogOptions?.disabledIndices,
						selectionMarker: dialogOptions?.selectionMarker,
						checkedIndices: dialogOptions?.checkedIndices,
						markableCount: dialogOptions?.markableCount,
						maxVisible,
						inline: dialogOptions?.inline,
						slider: extra?.slider,
					}),
				focusKind("picker", "list"),
			);
			return () => this.hideHookSelector();
		});
	}
	/**
	 * Hide the hook selector.
	 */
	hideHookSelector(): void {
		this.ctx.hookSelector?.close();
		this.ctx.hookSelector = undefined;
	}

	/**
	 * Show a confirmation dialog for hooks.
	 */
	async showHookConfirm(
		title: string,
		message: string,
		dialogOptions?: InteractiveSelectorDialogOptions,
	): Promise<boolean> {
		const result = await this.showHookSelector(`${title}\n${message}`, ["Yes", "No"], dialogOptions, {
			kind: "permission",
		});
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
		return this.#presentDialog({ kind: "question", msg: title }, dialogOptions?.signal, settle => {
			this.ctx.closeLinkBrowser();
			this.ctx.hookInput = this.ctx.showEditorAreaDialog(
				() =>
					HookInput({
						title,
						placeholder,
						options: {
							timeout: dialogOptions?.timeout,
							onTimeout: dialogOptions?.onTimeout,
							secret: dialogOptions?.secret,
						},
						onSubmit: value => settle(value),
						onCancel: () => settle(undefined),
					}),
				focusKind("input"),
			);
			return () => this.hideHookInput();
		});
	}

	/**
	 * Hide the hook input.
	 */
	hideHookInput(): void {
		this.ctx.hookInput?.close();
		this.ctx.hookInput = undefined;
	}

	/** Rows a dialog's editor may fill before it scrolls: the terminal's, less the room its chrome and the status rows take. */
	#dialogEditorRows(): number {
		return Math.max(3, this.ctx.shell.size().rows - 12);
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
		return this.#presentDialog({ kind: "question", msg: title }, dialogOptions?.signal, settle => {
			this.ctx.closeLinkBrowser();
			this.ctx.hookEditor = this.ctx.showEditorAreaDialog(
				() =>
					HookEditor({
						title,
						prefill,
						options: {
							...editorOptions,
							externalEditor: editDialogExternally,
							maxHeight: this.#dialogEditorRows(),
						},
						vim: this.ctx.dialogVim(),
						onSubmit: value => settle(value),
						onCancel: () => settle(undefined),
					}),
				focusKind("editor"),
			);
			return () => this.hideHookEditor();
		});
	}

	/**
	 * Hide the hook editor.
	 */
	hideHookEditor(): void {
		this.ctx.hookEditor?.close();
		this.ctx.hookEditor = undefined;
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
			// `notify` is shared by every extension: an info notice gets its own line so it neither
			// overwrites nor is overwritten by another extension's notice or omp's own status.
			this.ctx.showStatus(message, { collapse: false });
		}
	}

	/**
	 * `ctx.ui.custom`: the factory's view (pi-tui nodes, or a rows object drawn as a canvas that
	 * receives keys and pastes) with keyboard focus, in the composer's place or, with
	 * `options.overlay`, as an overlay (the whole screen with `fullscreen`). `done` closes it and
	 * resolves; an abort of `options.signal` closes it and rejects.
	 */
	async showHookCustom<T>(factory: ExtensionCustomFactory<T>, options?: ExtensionCustomOptions): Promise<T> {
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const revision = signal(0);
		let handle: OverlayHandle | undefined;
		let closed = false;

		const finish = (settle: () => void) => {
			if (closed) return;
			closed = true;
			options?.signal?.removeEventListener("abort", onAbort);
			try {
				handle?.close();
			} finally {
				settle();
			}
		};
		const fail = (error: unknown) => finish(() => reject(error));
		const onAbort = () => fail(options?.signal?.reason ?? new DOMException("Dialog aborted", "AbortError"));
		const done = (result: T) => finish(() => resolve(result));

		if (options?.signal?.aborted) {
			fail(options.signal.reason ?? new DOMException("Dialog aborted", "AbortError"));
			return promise;
		}
		options?.signal?.addEventListener("abort", onAbort, { once: true });

		Promise.try(() => factory(this.#uiHost(revision), extensionTheme(currentTheme()), this.ctx.keybindings, done))
			.then(output => {
				if (closed) {
					// Settled while the factory ran: the view never mounts, but its rows still get disposed.
					if (output && typeof output === "object" && "dispose" in output) output.dispose?.();
					return;
				}
				// The view (and a rows object's `dispose`) lives in the mounted root.
				const view = (): UiNode =>
					singleNode(
						extensionOutput(output, {
							revision,
							input: true,
							onError: error => this.#reportRenderError("custom view", error),
						}) ?? [],
					);
				if (options?.overlay) {
					let node: UiNode | undefined;
					handle = this.ctx.shell.overlays.show(
						() => extensionOverlay((node = view()), options.fullscreen === true, this.ctx.shell.native()),
						// A view that is its own sheet takes the keys on the screen inside it.
						{ focus: root => (node && node !== root ? node : (root.children()[0] ?? root)) },
					);
					options.onHandle?.({
						get closed() {
							return handle?.closed ?? true;
						},
						close: () => handle?.close(),
					});
					return;
				}
				this.ctx.closeLinkBrowser();
				handle = this.ctx.showEditorAreaDialog(view);
			})
			.catch(fail);
		return promise;
	}

	/**
	 * Raw terminal input for an extension: each key's bytes and each paste (bracketed) before the
	 * focused view sees them; a `consume` answer swallows the input, a `data` answer replaces it
	 * (decoded again, it continues to the older listeners and the focused view; empty drops it).
	 */
	addExtensionTerminalInputListener(handler: TerminalInputHandler): () => void {
		const unsubscribe = this.ctx.interceptInput(event => {
			const data =
				event.type === "key"
					? event.key.raw
					: event.type === "paste"
						? `\x1b[200~${event.paste.text}\x1b[201~`
						: undefined;
			if (data === undefined) return false;
			const result = handler(data);
			if (result?.consume) return true;
			if (result?.data === undefined || result.data === data) return false;
			return decodeInput(result.data, { kitty: this.ctx.shell.host?.driver.capabilities.kittyKeyboard });
		});
		this.#extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.#extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	clearHookWidgets(): void {
		this.ctx.hud.widgets.clear();
	}

	clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.#extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.#extensionTerminalInputUnsubscribers.clear();
	}

	showExtensionError(extensionPath: string, error: string): void {
		const text = currentTheme().fg("error", `Extension "${extensionPath}" error: ${error}`);
		this.ctx.present(() => AnsiText({ text, padX: 1 }));
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

	/**
	 * Collab guest: the replica session only mirrors the host, and mirrored host
	 * lifecycle events (`agent_end`, `turn_end`, …) reach guest extensions. An
	 * extension reacting to them must not start or queue a turn on the replica —
	 * it would run on the guest's local model and diverge from the host. Refuse
	 * like typed prompts are refused (input-controller); true when dropped.
	 */
	#rejectGuestExtensionTurn(): boolean {
		if (!this.ctx.collabGuest) return false;
		this.ctx.showStatus("Extension-initiated turns are host-only during a collab session");
		return true;
	}

	#sendExtensionMessage: SendMessageHandler = (message, options) => {
		const normalized = normalizeCustomMessagePayload(message);
		// A row kept out of context never starts a turn, whatever its options ask (see `sendCustomMessage`).
		const startsTurn =
			normalized.excludeFromContext !== true &&
			(options?.triggerTurn === true ||
				options?.deliverAs === "steer" ||
				options?.deliverAs === "followUp" ||
				options?.deliverAs === "aside");
		if (startsTurn && this.#rejectGuestExtensionTurn()) return;
		const wasStreaming = this.ctx.session.isStreaming;
		const messageCountBefore = this.ctx.session.messages.length;
		this.ctx.session
			.sendCustomMessage(normalized, options)
			.then(() => {
				// `deliverAs: "nextTurn"` without a trigger is the one idle arm that appends
				// to the session silently (no message_start/message_end), so nothing else
				// paints it and nothing else in the transcript changed.
				const silentAppend = options?.deliverAs === "nextTurn" && !startsTurn;
				this.#applyCustomMessageDisplay(wasStreaming, normalized, silentAppend ? messageCountBefore : undefined);
			})
			.catch((err: unknown) => {
				this.ctx.showError(`Extension sendMessage failed: ${err instanceof Error ? err.message : String(err)}`);
			});
	};

	/** Every `sendUserMessage` form prompts or queues a user turn (see `AgentSession.sendUserMessage`). */
	#sendExtensionUserMessage: SendUserMessageHandler = (content, options) => {
		if (this.#rejectGuestExtensionTurn()) {
			const denied = Promise.reject(new Error("Extension-initiated turns are host-only during a collab session"));
			denied.catch(() => {});
			return denied;
		}
		const task = this.ctx.session.sendUserMessage(content, options);
		task.catch((err: unknown) => {
			this.ctx.showError(`Extension sendUserMessage failed: ${err instanceof Error ? err.message : String(err)}`);
		});
		return task;
	};

	/**
	 * @param silentAppendBaseline message count before a silent idle `nextTurn` append,
	 *   or `undefined` when the send was not such an append.
	 */
	#applyCustomMessageDisplay(
		wasStreaming: boolean,
		message: { customType: string; display?: boolean },
		silentAppendBaseline: number | undefined,
	): void {
		// For non-streaming cases with display=true, update UI
		// (streaming cases update via message_end event).
		// Gate on initialChatRendered (#1955): an extension's session_start
		// sendMessage({display:true}) runs before renderInitialMessages, which would
		// re-render from session entries AND re-append via preserveExistingChat,
		// duplicating the message. After the initial render the chat must be updated.
		if (wasStreaming || !message.display || !this.ctx.initialChatRendered) return;
		if (silentAppendBaseline !== undefined && !this.ctx.session.isStreaming) {
			// Append only the new message instead of replaying the whole transcript (#12183).
			// The count and type checks fail when the send did not land as a plain append
			// (e.g. it was queued behind a turn that began meanwhile), which falls through
			// to the rebuild below.
			const messages = this.ctx.session.messages;
			const appended = messages.at(-1);
			if (
				messages.length === silentAppendBaseline + 1 &&
				appended?.role === "custom" &&
				appended.customType === message.customType
			) {
				this.ctx.addMessageToChat(appended);
				return;
			}
		}
		this.ctx.rebuildChatFromMessages();
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
	 *
	 * While presented, the dialog reports the run as `blocked` on `prompt` (OSC 7501 and the title): nothing it
	 * gates goes on until the user answers. Whether that needs an alert is the terminal's call.
	 */
	#presentDialog<T = string>(
		prompt: Omit<BlockedStatus, "state">,
		signal: AbortSignal | undefined,
		present: (settle: (value: T | undefined) => void) => () => void,
	): Promise<T | undefined> {
		const { promise, resolve, reject } = Promise.withResolvers<T | undefined>();
		let settled = false;
		let started = false;
		let hide: (() => void) | undefined;
		let release: (() => void) | undefined;

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
				// Present the next dialog before releasing this one, so no `working`/`done` report slips out between.
				this.#advanceDialogQueue();
				release?.();
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
			// Held before `present` so a synchronous settle still releases it.
			release = holdBlockedStatus({ state: "blocked", ...prompt });
			try {
				hide = present(settle);
			} catch (error) {
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				this.#dialogActive = false;
				this.#advanceDialogQueue();
				release();
				reject(error);
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

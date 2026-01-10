/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, OAuthProvider } from "@oh-my-pi/pi-ai";
import type { SlashCommand } from "@oh-my-pi/pi-tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Input,
	Loader,
	Markdown,
	ProcessTerminal,
	Spacer,
	Text,
	TruncatedText,
	TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { nanoid } from "nanoid";
import { getAuthPath, getDebugLogPath } from "../../config";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session";
import type { ExtensionUIContext } from "../../core/extensions/index";
import { KeybindingsManager } from "../../core/keybindings";
import { type CustomMessage, createCompactionSummaryMessage } from "../../core/messages";
import { getRecentSessions, type SessionContext, SessionManager } from "../../core/session-manager";
import { loadSlashCommands } from "../../core/slash-commands";
import { detectNotificationProtocol, isNotificationSuppressed, sendNotification } from "../../core/terminal-notify";
import { generateSessionTitle, setTerminalTitle } from "../../core/title-generator";
import { setPreferredImageProvider, setPreferredWebSearchProvider } from "../../core/tools/index";
import type { TruncationResult } from "../../core/tools/truncate";
import { VoiceSupervisor } from "../../core/voice-supervisor";
import { disableProvider, enableProvider } from "../../discovery";
import { getChangelogPath, parseChangelog } from "../../utils/changelog";
import { copyToClipboard, readImageFromClipboard } from "../../utils/clipboard";
import { resizeImage } from "../../utils/image-resize";
import { registerAsyncCleanup } from "../cleanup";
import { ArminComponent } from "./components/armin";
import { AssistantMessageComponent } from "./components/assistant-message";
import { BashExecutionComponent } from "./components/bash-execution";
import { BorderedLoader } from "./components/bordered-loader";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message";
import { CustomEditor } from "./components/custom-editor";
import { CustomMessageComponent } from "./components/custom-message";
import { DynamicBorder } from "./components/dynamic-border";
import { ExtensionDashboard } from "./components/extensions";
import { HookEditorComponent } from "./components/hook-editor";
import { HookInputComponent } from "./components/hook-input";
import { HookSelectorComponent } from "./components/hook-selector";
import { ModelSelectorComponent } from "./components/model-selector";
import { OAuthSelectorComponent } from "./components/oauth-selector";
import { SessionSelectorComponent } from "./components/session-selector";
import { SettingsSelectorComponent } from "./components/settings-selector";
import { StatusLineComponent } from "./components/status-line";
import { ToolExecutionComponent } from "./components/tool-execution";
import { TreeSelectorComponent } from "./components/tree-selector";
import { TtsrNotificationComponent } from "./components/ttsr-notification";
import { UserMessageComponent } from "./components/user-message";
import { UserMessageSelectorComponent } from "./components/user-message-selector";
import { WelcomeComponent } from "./components/welcome";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getSymbolTheme,
	getThemeByName,
	onThemeChange,
	setSymbolPreset,
	setTheme,
	type Theme,
	theme,
} from "./theme/theme";

/** Options for creating an InteractiveMode instance (for future API use) */
export interface InteractiveModeOptions {
	/** Providers that were migrated during startup */
	migratedProviders?: string[];
	/** Warning message if model fallback occurred */
	modelFallbackMessage?: string;
	/** Initial message to send */
	initialMessage?: string;
	/** Initial images to include with the message */
	initialImages?: ImageContent[];
	/** Additional initial messages to queue */
	initialMessages?: string[];
}

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
};

const VOICE_PROGRESS_DELAY_MS = 15000;
const VOICE_PROGRESS_MIN_CHARS = 160;
const VOICE_PROGRESS_DELTA_CHARS = 120;

export class InteractiveMode {
	private session: AgentSession;
	private ui: TUI;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private editor: CustomEditor;
	private editorContainer: Container;
	private statusLine: StatusLineComponent;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (input: { text: string; images?: ImageContent[] }) => void;
	private loadingAnimation: Loader | undefined = undefined;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;

	// Background mode flag (no UI, no interactive prompts)
	private isBackgrounded = false;

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;

	// Signal cleanup unsubscribe function (for SIGINT/SIGTERM flush)
	private cleanupUnsubscribe?: () => void;

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Track pending images from clipboard paste (attached to next message)
	private pendingImages: ImageContent[] = [];

	// Slash commands loaded from files (for compaction queue handling)
	private fileSlashCommands = new Set<string>();

	// Voice mode state
	private voiceSupervisor: VoiceSupervisor;
	private voiceAutoModeEnabled = false;
	private voiceProgressTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	private voiceProgressSpoken = false;
	private voiceProgressLastLength = 0;
	private lastVoiceInterruptAt = 0;

	// Auto-compaction state
	private autoCompactionLoader: Loader | undefined = undefined;
	private autoCompactionEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Auto-retry state
	private retryLoader: Loader | undefined = undefined;
	private retryEscapeHandler?: () => void;

	// Hook UI state
	private hookSelector: HookSelectorComponent | undefined = undefined;
	private hookInput: HookInputComponent | undefined = undefined;
	private hookEditor: HookEditorComponent | undefined = undefined;

	// Convenience accessors
	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	constructor(
		session: AgentSession,
		version: string,
		changelogMarkdown: string | undefined = undefined,
		private setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void = () => {},
		private lspServers:
			| Array<{ name: string; status: "ready" | "error"; fileTypes: string[] }>
			| undefined = undefined,
	) {
		this.session = session;
		this.version = version;
		this.changelogMarkdown = changelogMarkdown;
		this.ui = new TUI(new ProcessTerminal());
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.editor = new CustomEditor(getEditorTheme());
		this.editor.setUseTerminalCursor(true);
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor);
		this.statusLine = new StatusLineComponent(session);
		this.statusLine.setAutoCompactEnabled(session.autoCompactionEnabled);
		this.voiceSupervisor = new VoiceSupervisor(this.session.modelRegistry, {
			onSendToAgent: async (text) => {
				await this.submitVoiceText(text);
			},
			onInterruptAgent: async (reason) => {
				await this.handleVoiceInterrupt(reason);
			},
			onStatus: (status) => {
				this.setVoiceStatus(status);
			},
			onError: (error) => {
				this.showError(error.message);
				this.voiceAutoModeEnabled = false;
				void this.voiceSupervisor.stop();
				this.setVoiceStatus(undefined);
			},
			onWarning: (message) => {
				this.showWarning(message);
			},
		});

		// Define slash commands for autocomplete
		const slashCommands: SlashCommand[] = [
			{ name: "settings", description: "Open settings menu" },
			{ name: "model", description: "Select model (opens selector UI)" },
			{ name: "export", description: "Export session to HTML file or clipboard (--copy)" },
			{ name: "share", description: "Share session as a secret GitHub gist" },
			{ name: "copy", description: "Copy last agent message to clipboard" },
			{ name: "session", description: "Show session info and stats" },
			{ name: "extensions", description: "Open Extension Control Center dashboard" },
			{ name: "status", description: "Alias for /extensions" },
			{ name: "changelog", description: "Show changelog entries" },
			{ name: "hotkeys", description: "Show all keyboard shortcuts" },
			{ name: "branch", description: "Create a new branch from a previous message" },
			{ name: "tree", description: "Navigate session tree (switch branches)" },
			{ name: "login", description: "Login with OAuth provider" },
			{ name: "logout", description: "Logout from OAuth provider" },
			{ name: "new", description: "Start a new session" },
			{ name: "compact", description: "Manually compact the session context" },
			{ name: "background", description: "Detach UI and continue running in background" },
			{ name: "bg", description: "Alias for /background" },
			{ name: "resume", description: "Resume a different session" },
			{ name: "exit", description: "Exit the application" },
		];

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		// Load and convert file commands to SlashCommand format
		const fileCommands = loadSlashCommands({ cwd: process.cwd() });
		this.fileSlashCommands = new Set(fileCommands.map((cmd) => cmd.name));
		const fileSlashCommands: SlashCommand[] = fileCommands.map((cmd) => ({
			name: cmd.name,
			description: cmd.description,
		}));

		// Convert hook commands to SlashCommand format
		const hookCommands: SlashCommand[] = (this.session.extensionRunner?.getRegisteredCommands() ?? []).map((cmd) => ({
			name: cmd.name,
			description: cmd.description ?? "(hook command)",
		}));

		// Convert custom commands (TypeScript) to SlashCommand format
		const customCommands: SlashCommand[] = this.session.customCommands.map((loaded) => ({
			name: loaded.command.name,
			description: `${loaded.command.description} (${loaded.source})`,
		}));

		// Setup autocomplete
		const autocompleteProvider = new CombinedAutocompleteProvider(
			[...slashCommands, ...fileSlashCommands, ...hookCommands, ...customCommands],
			process.cwd(),
		);
		this.editor.setAutocompleteProvider(autocompleteProvider);
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		// Register session manager flush for signal handlers (SIGINT, SIGTERM, SIGHUP)
		this.cleanupUnsubscribe = registerAsyncCleanup(() => this.sessionManager.flush());

		// Get current model info for welcome screen
		const modelName = this.session.model?.name ?? "Unknown";
		const providerName = this.session.model?.provider ?? "Unknown";

		// Get recent sessions
		const recentSessions = getRecentSessions(this.sessionManager.getSessionDir()).map((s) => ({
			name: s.name,
			timeAgo: s.timeAgo,
		}));

		// Convert LSP servers to welcome format
		const lspServerInfo =
			this.lspServers?.map((s) => ({
				name: s.name,
				status: s.status as "ready" | "error" | "connecting",
				fileTypes: s.fileTypes,
			})) ?? [];

		// Add welcome header
		const welcome = new WelcomeComponent(this.version, modelName, providerName, recentSessions, lspServerInfo);

		// Set terminal title if session already has one (resumed session)
		const existingTitle = this.sessionManager.getSessionTitle();
		if (existingTitle) {
			setTerminalTitle(`pi: ${existingTitle}`);
		}

		// Setup UI layout
		this.ui.addChild(new Spacer(1));
		this.ui.addChild(welcome);
		this.ui.addChild(new Spacer(1));

		// Add changelog if provided
		if (this.changelogMarkdown) {
			this.ui.addChild(new DynamicBorder());
			if (this.settingsManager.getCollapseChangelog()) {
				const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
				const latestVersion = versionMatch ? versionMatch[1] : this.version;
				const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
				this.ui.addChild(new Text(condensedText, 1, 0));
			} else {
				this.ui.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
				this.ui.addChild(new Spacer(1));
				this.ui.addChild(new Markdown(this.changelogMarkdown.trim(), 1, 0, getMarkdownTheme()));
				this.ui.addChild(new Spacer(1));
			}
			this.ui.addChild(new DynamicBorder());
		}

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(new Spacer(1));
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.statusLine); // Only renders hook statuses (main status in editor border)
		this.ui.setFocus(this.editor);

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();

		// Start the UI
		this.ui.start();
		this.isInitialized = true;

		// Set terminal title
		const cwdBasename = path.basename(process.cwd());
		this.ui.terminal.setTitle(`pi - ${cwdBasename}`);

		// Initialize hooks with TUI-based UI context
		await this.initHooksAndCustomTools();

		// Subscribe to agent events
		this.subscribeToAgent();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher
		this.statusLine.watchBranch(() => {
			this.updateEditorTopBorder();
			this.ui.requestRender();
		});

		// Initial top border update
		this.updateEditorTopBorder();
	}

	// =========================================================================
	// Hook System
	// =========================================================================

	/**
	 * Initialize the hook system with TUI-based UI context.
	 */
	private async initHooksAndCustomTools(): Promise<void> {
		// Create and set hook & tool UI context
		const uiContext: ExtensionUIContext = {
			select: (title, options, _dialogOptions) => this.showHookSelector(title, options),
			confirm: (title, message, _dialogOptions) => this.showHookConfirm(title, message),
			input: (title, placeholder, _dialogOptions) => this.showHookInput(title, placeholder),
			notify: (message, type) => this.showHookNotify(message, type),
			setStatus: (key, text) => this.setHookStatus(key, text),
			setWidget: (key, content) => this.setHookWidget(key, content),
			setTitle: (title) => setTerminalTitle(title),
			custom: (factory, _options) => this.showHookCustom(factory),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getText(),
			editor: (title, prefill) => this.showHookEditor(title, prefill),
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths().map((t) => ({ name: t.name, path: t.path })),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeArg) => {
				if (typeof themeArg === "string") {
					return setTheme(themeArg, true);
				}
				// Theme object passed directly - not supported in current implementation
				return { success: false, error: "Direct theme object not supported" };
			},
			setFooter: () => {},
			setHeader: () => {},
			setEditorComponent: () => {},
		};
		this.setToolUIContext(uiContext, true);

		const extensionRunner = this.session.extensionRunner;
		if (!extensionRunner) {
			return; // No hooks loaded
		}

		extensionRunner.initialize(
			// ExtensionActions - for pi.* API
			{
				sendMessage: (message, options) => {
					const wasStreaming = this.session.isStreaming;
					this.session
						.sendCustomMessage(message, options)
						.then(() => {
							// For non-streaming cases with display=true, update UI
							// (streaming cases update via message_end event)
							if (!this.isBackgrounded && !wasStreaming && message.display) {
								this.rebuildChatFromMessages();
							}
						})
						.catch((err) => {
							this.showError(
								`Extension sendMessage failed: ${err instanceof Error ? err.message : String(err)}`,
							);
						});
				},
				sendUserMessage: (content, options) => {
					this.session.sendUserMessage(content, options).catch((err) => {
						this.showError(
							`Extension sendUserMessage failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					});
				},
				appendEntry: (customType, data) => {
					this.sessionManager.appendCustomEntry(customType, data);
				},
				getActiveTools: () => this.session.getActiveToolNames(),
				getAllTools: () => this.session.getAllToolNames(),
				setActiveTools: (toolNames) => this.session.setActiveToolsByName(toolNames),
				setModel: async (model) => {
					const key = await this.session.modelRegistry.getApiKey(model);
					if (!key) return false;
					await this.session.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.session.thinkingLevel,
				setThinkingLevel: (level) => this.session.setThinkingLevel(level),
			},
			// ExtensionContextActions - for ctx.* in event handlers
			{
				getModel: () => this.session.model,
				isIdle: () => !this.session.isStreaming,
				abort: () => this.session.abort(),
				hasPendingMessages: () => this.session.queuedMessageCount > 0,
				shutdown: () => {
					// Signal shutdown request (will be handled by main loop)
				},
			},
			// ExtensionCommandContextActions - for ctx.* in command handlers
			{
				waitForIdle: () => this.session.agent.waitForIdle(),
				newSession: async (options) => {
					// Stop any loading animation
					if (this.loadingAnimation) {
						this.loadingAnimation.stop();
						this.loadingAnimation = undefined;
					}
					this.statusContainer.clear();

					// Create new session
					const success = await this.session.newSession({ parentSession: options?.parentSession });
					if (!success) {
						return { cancelled: true };
					}

					// Call setup callback if provided
					if (options?.setup) {
						await options.setup(this.sessionManager);
					}

					// Clear UI state
					this.chatContainer.clear();
					this.pendingMessagesContainer.clear();
					this.compactionQueuedMessages = [];
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.pendingTools.clear();

					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(
						new Text(`${theme.fg("accent", `${theme.status.success} New session started`)}`, 1, 1),
					);
					this.ui.requestRender();

					return { cancelled: false };
				},
				branch: async (entryId) => {
					const result = await this.session.branch(entryId);
					if (result.cancelled) {
						return { cancelled: true };
					}

					// Update UI
					this.chatContainer.clear();
					this.renderInitialMessages();
					this.editor.setText(result.selectedText);
					this.showStatus("Branched to new session");

					return { cancelled: false };
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, { summarize: options?.summarize });
					if (result.cancelled) {
						return { cancelled: true };
					}

					// Update UI
					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");

					return { cancelled: false };
				},
			},
			// ExtensionUIContext
			uiContext,
		);

		// Subscribe to extension errors
		extensionRunner.onError((error) => {
			this.showExtensionError(error.extensionPath, error.error);
		});

		// Emit session_start event
		await extensionRunner.emit({
			type: "session_start",
		});
	}

	/**
	 * Set extension widget content.
	 */
	private setHookWidget(key: string, content: unknown): void {
		this.statusLine.setHookStatus(key, String(content));
		this.ui.requestRender();
	}

	private initializeHookRunner(uiContext: ExtensionUIContext, _hasUI: boolean): void {
		const extensionRunner = this.session.extensionRunner;
		if (!extensionRunner) {
			return;
		}

		extensionRunner.initialize(
			// ExtensionActions - for pi.* API
			{
				sendMessage: (message, options) => {
					const wasStreaming = this.session.isStreaming;
					this.session
						.sendCustomMessage(message, options)
						.then(() => {
							// For non-streaming cases with display=true, update UI
							// (streaming cases update via message_end event)
							if (!this.isBackgrounded && !wasStreaming && message.display) {
								this.rebuildChatFromMessages();
							}
						})
						.catch((err: Error) => {
							const errorText = `Extension sendMessage failed: ${err instanceof Error ? err.message : String(err)}`;
							if (this.isBackgrounded) {
								console.error(errorText);
								return;
							}
							this.showError(errorText);
						});
				},
				sendUserMessage: (content, options) => {
					this.session.sendUserMessage(content, options).catch((err) => {
						this.showError(
							`Extension sendUserMessage failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					});
				},
				appendEntry: (customType, data) => {
					this.sessionManager.appendCustomEntry(customType, data);
				},
				getActiveTools: () => this.session.getActiveToolNames(),
				getAllTools: () => this.session.getAllToolNames(),
				setActiveTools: (toolNames: string[]) => this.session.setActiveToolsByName(toolNames),
				setModel: async (model) => {
					const key = await this.session.modelRegistry.getApiKey(model);
					if (!key) return false;
					await this.session.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.session.thinkingLevel,
				setThinkingLevel: (level) => this.session.setThinkingLevel(level),
			},
			// ExtensionContextActions - for ctx.* in event handlers
			{
				getModel: () => this.session.model,
				isIdle: () => !this.session.isStreaming,
				abort: () => this.session.abort(),
				hasPendingMessages: () => this.session.queuedMessageCount > 0,
				shutdown: () => {
					// Signal shutdown request (will be handled by main loop)
				},
			},
			// ExtensionCommandContextActions - for ctx.* in command handlers
			{
				waitForIdle: () => this.session.agent.waitForIdle(),
				newSession: async (options) => {
					if (this.isBackgrounded) {
						return { cancelled: true };
					}
					// Stop any loading animation
					if (this.loadingAnimation) {
						this.loadingAnimation.stop();
						this.loadingAnimation = undefined;
					}
					this.statusContainer.clear();

					// Create new session
					const success = await this.session.newSession({ parentSession: options?.parentSession });
					if (!success) {
						return { cancelled: true };
					}

					// Call setup callback if provided
					if (options?.setup) {
						await options.setup(this.sessionManager);
					}

					// Clear UI state
					this.chatContainer.clear();
					this.pendingMessagesContainer.clear();
					this.compactionQueuedMessages = [];
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.pendingTools.clear();

					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(
						new Text(`${theme.fg("accent", `${theme.status.success} New session started`)}`, 1, 1),
					);
					this.ui.requestRender();

					return { cancelled: false };
				},
				branch: async (entryId) => {
					if (this.isBackgrounded) {
						return { cancelled: true };
					}
					const result = await this.session.branch(entryId);
					if (result.cancelled) {
						return { cancelled: true };
					}

					// Update UI
					this.chatContainer.clear();
					this.renderInitialMessages();
					this.editor.setText(result.selectedText);
					this.showStatus("Branched to new session");

					return { cancelled: false };
				},
				navigateTree: async (targetId, options) => {
					if (this.isBackgrounded) {
						return { cancelled: true };
					}
					const result = await this.session.navigateTree(targetId, { summarize: options?.summarize });
					if (result.cancelled) {
						return { cancelled: true };
					}

					// Update UI
					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");

					return { cancelled: false };
				},
			},
			uiContext,
		);
	}

	private createBackgroundUiContext(): ExtensionUIContext {
		return {
			select: async (_title: string, _options: string[], _dialogOptions) => undefined,
			confirm: async (_title: string, _message: string, _dialogOptions) => false,
			input: async (_title: string, _placeholder?: string, _dialogOptions?: unknown) => undefined,
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			get theme() {
				return theme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Background mode" }),
			setFooter: () => {},
			setHeader: () => {},
			setEditorComponent: () => {},
		};
	}

	/**
	 * Emit session event to all extension tools.
	 */
	private async emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void> {
		const event = { reason, previousSessionFile };
		const uiContext = this.session.extensionRunner?.getUIContext();
		if (!uiContext) {
			return;
		}
		for (const registeredTool of this.session.extensionRunner?.getAllRegisteredTools() ?? []) {
			if (registeredTool.definition.onSession) {
				try {
					await registeredTool.definition.onSession(event, {
						ui: uiContext,
						hasUI: !this.isBackgrounded,
						cwd: this.sessionManager.getCwd(),
						sessionManager: this.session.sessionManager,
						modelRegistry: this.session.modelRegistry,
						model: this.session.model,
						isIdle: () => !this.session.isStreaming,
						hasPendingMessages: () => this.session.queuedMessageCount > 0,
						hasQueuedMessages: () => this.session.queuedMessageCount > 0,
						abort: () => {
							this.session.abort();
						},
						shutdown: () => {
							// Signal shutdown request
						},
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
	private showToolError(toolName: string, error: string): void {
		if (this.isBackgrounded) {
			console.error(`Tool "${toolName}" error: ${error}`);
			return;
		}
		const errorText = new Text(theme.fg("error", `Tool "${toolName}" error: ${error}`), 1, 0);
		this.chatContainer.addChild(errorText);
		this.ui.requestRender();
	}

	/**
	 * Set hook status text in the footer.
	 */
	private setHookStatus(key: string, text: string | undefined): void {
		if (this.isBackgrounded) {
			return;
		}
		this.statusLine.setHookStatus(key, text);
		this.ui.requestRender();
	}

	/**
	 * Show a selector for hooks.
	 */
	private showHookSelector(title: string, options: string[]): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.hookSelector = new HookSelectorComponent(
				title,
				options,
				(option) => {
					this.hideHookSelector();
					resolve(option);
				},
				() => {
					this.hideHookSelector();
					resolve(undefined);
				},
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.hookSelector);
			this.ui.setFocus(this.hookSelector);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the hook selector.
	 */
	private hideHookSelector(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.hookSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for hooks.
	 */
	private async showHookConfirm(title: string, message: string): Promise<boolean> {
		const result = await this.showHookSelector(`${title}\n${message}`, ["Yes", "No"]);
		return result === "Yes";
	}

	/**
	 * Show a text input for hooks.
	 */
	private showHookInput(title: string, placeholder?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.hookInput = new HookInputComponent(
				title,
				placeholder,
				(value) => {
					this.hideHookInput();
					resolve(value);
				},
				() => {
					this.hideHookInput();
					resolve(undefined);
				},
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.hookInput);
			this.ui.setFocus(this.hookInput);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the hook input.
	 */
	private hideHookInput(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.hookInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for hooks (with Ctrl+G support).
	 */
	private showHookEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.hookEditor = new HookEditorComponent(
				this.ui,
				title,
				prefill,
				(value) => {
					this.hideHookEditor();
					resolve(value);
				},
				() => {
					this.hideHookEditor();
					resolve(undefined);
				},
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.hookEditor);
			this.ui.setFocus(this.hookEditor);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the hook editor.
	 */
	private hideHookEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.hookEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for hooks.
	 */
	private showHookNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/**
	 * Show a custom component with keyboard focus.
	 */
	private async showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
	): Promise<T> {
		const savedText = this.editor.getText();
		const keybindings = KeybindingsManager.inMemory();

		return new Promise((resolve) => {
			let component: Component & { dispose?(): void };

			const close = (result: T) => {
				component.dispose?.();
				this.editorContainer.clear();
				this.editorContainer.addChild(this.editor);
				this.editor.setText(savedText);
				this.ui.setFocus(this.editor);
				this.ui.requestRender();
				resolve(result);
			};

			Promise.resolve(factory(this.ui, theme, keybindings, close)).then((c) => {
				component = c;
				this.editorContainer.clear();
				this.editorContainer.addChild(component);
				this.ui.setFocus(component);
				this.ui.requestRender();
			});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string): void {
		const errorText = new Text(theme.fg("error", `Extension "${extensionPath}" error: ${error}`), 1, 0);
		this.chatContainer.addChild(errorText);
		this.ui.requestRender();
	}

	/**
	 * Handle pi.send() from hooks.
	 * If streaming, queue the message. Otherwise, start a new agent loop.
	 */
	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		this.editor.onEscape = () => {
			if (this.loadingAnimation) {
				// Abort and restore queued messages to editor
				const queuedMessages = this.session.clearQueue();
				const queuedText = [...queuedMessages.steering, ...queuedMessages.followUp].join("\n\n");
				const currentText = this.editor.getText();
				const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
				this.editor.setText(combinedText);
				this.updatePendingMessagesDisplay();
				this.agent.abort();
			} else if (this.session.isBashRunning) {
				this.session.abortBash();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree or /branch based on setting
				const now = Date.now();
				if (now - this.lastEscapeTime < 500) {
					if (this.settingsManager.getDoubleEscapeAction() === "tree") {
						this.showTreeSelector();
					} else {
						this.showUserMessageSelector();
					}
					this.lastEscapeTime = 0;
				} else {
					this.lastEscapeTime = now;
				}
			}
		};

		this.editor.onCtrlC = () => this.handleCtrlC();
		this.editor.onCtrlD = () => this.handleCtrlD();
		this.editor.onCtrlZ = () => this.handleCtrlZ();
		this.editor.onShiftTab = () => this.cycleThinkingLevel();
		this.editor.onCtrlP = () => this.cycleRoleModel();
		this.editor.onShiftCtrlP = () => this.cycleRoleModel({ temporary: true });
		this.editor.onCtrlY = () => this.showModelSelector({ temporaryOnly: true });

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => this.handleDebugCommand();
		this.editor.onCtrlL = () => this.showModelSelector();
		this.editor.onCtrlO = () => this.toggleToolOutputExpansion();
		this.editor.onCtrlT = () => this.toggleThinkingBlockVisibility();
		this.editor.onCtrlG = () => this.openExternalEditor();
		this.editor.onQuestionMark = () => this.handleHotkeysCommand();
		this.editor.onCtrlV = () => this.handleImagePaste();
		this.editor.onAltUp = () => this.handleDequeue();

		// Wire up extension shortcuts
		this.registerExtensionShortcuts();

		this.editor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};

		this.editor.onAltEnter = async (text: string) => {
			text = text.trim();
			if (!text) return;

			// Queue follow-up messages while compaction is running
			if (this.session.isCompacting) {
				this.queueCompactionMessage(text, "followUp");
				return;
			}

			// Alt+Enter queues a follow-up message (waits until agent finishes)
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.session.isStreaming) {
				this.editor.addToHistory(text);
				this.editor.setText("");
				await this.session.prompt(text, { streamingBehavior: "followUp" });
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
			}
			// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
			else if (this.editor.onSubmit) {
				this.editor.onSubmit(text);
			}
		};
	}

	private setupEditorSubmitHandler(): void {
		this.editor.onSubmit = async (text: string) => {
			text = text.trim();

			// Empty submit while streaming with queued messages: flush queues immediately
			if (!text && this.session.isStreaming && this.session.queuedMessageCount > 0) {
				// Abort current stream and let queued messages be processed
				await this.session.abort();
				return;
			}

			if (!text) return;

			// Handle slash commands
			if (text === "/settings") {
				this.showSettingsSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/model") {
				this.showModelSelector();
				this.editor.setText("");
				return;
			}
			if (text.startsWith("/export")) {
				await this.handleExportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/share") {
				await this.handleShareCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/copy") {
				await this.handleCopyCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/changelog") {
				this.handleChangelogCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/hotkeys") {
				this.handleHotkeysCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/extensions" || text === "/status") {
				this.showExtensionsDashboard();
				this.editor.setText("");
				return;
			}
			if (text === "/branch") {
				if (this.settingsManager.getDoubleEscapeAction() === "tree") {
					this.showTreeSelector();
				} else {
					this.showUserMessageSelector();
				}
				this.editor.setText("");
				return;
			}
			if (text === "/tree") {
				this.showTreeSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/login") {
				this.showOAuthSelector("login");
				this.editor.setText("");
				return;
			}
			if (text === "/logout") {
				this.showOAuthSelector("logout");
				this.editor.setText("");
				return;
			}
			if (text === "/new") {
				this.editor.setText("");
				await this.handleClearCommand();
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/background" || text === "/bg") {
				this.editor.setText("");
				this.handleBackgroundCommand();
				return;
			}
			if (text === "/debug") {
				this.handleDebugCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/arminsayshi") {
				this.handleArminSaysHi();
				this.editor.setText("");
				return;
			}
			if (text === "/resume") {
				this.showSessionSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/exit") {
				this.editor.setText("");
				void this.shutdown();
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.session.isBashRunning) {
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.editor.setText(text);
						return;
					}
					this.editor.addToHistory(text);
					await this.handleBashCommand(command, isExcluded);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// Queue input during compaction
			if (this.session.isCompacting) {
				if (this.pendingImages.length > 0) {
					this.showStatus("Compaction in progress. Retry after it completes to send images.");
					return;
				}
				this.queueCompactionMessage(text, "steer");
				return;
			}

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.session.isStreaming) {
				this.editor.addToHistory(text);
				this.editor.setText("");
				const images = this.pendingImages.length > 0 ? [...this.pendingImages] : undefined;
				this.pendingImages = [];
				await this.session.prompt(text, { streamingBehavior: "steer", images });
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.flushPendingBashComponents();

			// Generate session title on first message
			const hasUserMessages = this.agent.state.messages.some((m) => m.role === "user");
			if (!hasUserMessages && !this.sessionManager.getSessionTitle()) {
				const registry = this.session.modelRegistry;
				const smolModel = this.settingsManager.getModelRole("smol");
				generateSessionTitle(text, registry, smolModel, this.session.sessionId)
					.then(async (title) => {
						if (title) {
							await this.sessionManager.setSessionTitle(title);
							setTerminalTitle(`omp: ${title}`);
						}
					})
					.catch(() => {});
			}

			if (this.onInputCallback) {
				// Include any pending images from clipboard paste
				const images = this.pendingImages.length > 0 ? [...this.pendingImages] : undefined;
				this.pendingImages = [];
				this.onInputCallback({ text, images });
			}
			this.editor.addToHistory(text);
		};
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		this.statusLine.invalidate();
		this.updateEditorTopBorder();

		switch (event.type) {
			case "agent_start":
				// Restore escape handler if retry UI is still active
				if (this.retryEscapeHandler) {
					this.editor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
					this.statusContainer.clear();
				}
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
				}
				this.statusContainer.clear();
				this.loadingAnimation = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					`Working${theme.format.ellipsis} (esc to interrupt)`,
					getSymbolTheme().spinnerFrames,
				);
				this.statusContainer.addChild(this.loadingAnimation);
				this.startVoiceProgressTimer();
				this.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "hookMessage" || event.message.role === "custom") {
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.editor.setText("");
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "fileMention") {
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.streamingComponent = new AssistantMessageComponent(undefined, this.hideThinkingBlock);
					this.streamingMessage = event.message;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.streamingMessage);

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							if (!this.pendingTools.has(content.id)) {
								this.chatContainer.addChild(new Text("", 0, 0));
								const tool = this.session.getToolByName(content.name);
								const component = new ToolExecutionComponent(
									content.name,
									content.arguments,
									{
										showImages: this.settingsManager.getShowImages(),
									},
									tool,
									this.ui,
									this.sessionManager.getCwd(),
								);
								component.setExpanded(this.toolOutputExpanded);
								this.chatContainer.addChild(component);
								this.pendingTools.set(content.id, component);
							} else {
								const component = this.pendingTools.get(content.id);
								if (component) {
									component.updateArgs(content.arguments);
								}
							}
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					// Don't show "Aborted" text for TTSR aborts - we'll show a nicer message
					if (this.session.isTtsrAbortPending && this.streamingMessage.stopReason === "aborted") {
						// TTSR abort - suppress the "Aborted" rendering in the component
						const msgWithoutAbort = { ...this.streamingMessage, stopReason: "stop" as const };
						this.streamingComponent.updateContent(msgWithoutAbort);
					} else {
						this.streamingComponent.updateContent(this.streamingMessage);
					}

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						// Skip error handling for TTSR aborts
						if (!this.session.isTtsrAbortPending) {
							let errorMessage: string;
							if (this.streamingMessage.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = this.streamingMessage.errorMessage || "Error";
							}
							for (const [, component] of this.pendingTools.entries()) {
								component.updateResult({
									content: [{ type: "text", text: errorMessage }],
									isError: true,
								});
							}
						}
						this.pendingTools.clear();
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.statusLine.invalidate();
					this.updateEditorTopBorder();
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				if (!this.pendingTools.has(event.toolCallId)) {
					const tool = this.session.getToolByName(event.toolName);
					const component = new ToolExecutionComponent(
						event.toolName,
						event.args,
						{
							showImages: this.settingsManager.getShowImages(),
						},
						tool,
						this.ui,
						this.sessionManager.getCwd(),
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				this.stopVoiceProgressTimer();
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = undefined;
					this.statusContainer.clear();
				}
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();
				if (this.settingsManager.getVoiceEnabled() && this.voiceAutoModeEnabled) {
					const lastAssistant = this.findLastAssistantMessage();
					if (lastAssistant && lastAssistant.stopReason !== "aborted" && lastAssistant.stopReason !== "error") {
						const text = this.extractAssistantText(lastAssistant);
						if (text) {
							this.voiceSupervisor.notifyResult(text);
						}
					}
				}
				this.ui.requestRender();
				this.sendCompletionNotification();
				break;

			case "auto_compaction_start": {
				// Allow input during compaction; submissions are queued
				// Set up escape to abort auto-compaction
				this.autoCompactionEscapeHandler = this.editor.onEscape;
				this.editor.onEscape = () => {
					this.session.abortCompaction();
				};
				// Show compacting indicator with reason
				this.statusContainer.clear();
				const reasonText = event.reason === "overflow" ? "Context overflow detected, " : "";
				this.autoCompactionLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					`${reasonText}Auto-compacting${theme.format.ellipsis} (esc to cancel)`,
					getSymbolTheme().spinnerFrames,
				);
				this.statusContainer.addChild(this.autoCompactionLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_compaction_end": {
				// Restore escape handler
				if (this.autoCompactionEscapeHandler) {
					this.editor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				// Stop loader
				if (this.autoCompactionLoader) {
					this.autoCompactionLoader.stop();
					this.autoCompactionLoader = undefined;
					this.statusContainer.clear();
				}
				// Handle result
				if (event.aborted) {
					this.showStatus("Auto-compaction cancelled");
				} else if (event.result) {
					// Rebuild chat to show compacted state
					this.chatContainer.clear();
					this.rebuildChatFromMessages();
					// Add compaction component at bottom so user sees it without scrolling
					this.addMessageToChat({
						role: "compactionSummary",
						tokensBefore: event.result.tokensBefore,
						summary: event.result.summary,
						timestamp: Date.now(),
					});
					this.statusLine.invalidate();
					this.updateEditorTopBorder();
				}
				await this.flushCompactionQueue({ willRetry: event.willRetry });
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				// Set up escape to abort retry
				this.retryEscapeHandler = this.editor.onEscape;
				this.editor.onEscape = () => {
					this.session.abortRetry();
				};
				// Show retry indicator
				this.statusContainer.clear();
				const delaySeconds = Math.round(event.delayMs / 1000);
				this.retryLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("warning", spinner),
					(text) => theme.fg("muted", text),
					`Retrying (${event.attempt}/${event.maxAttempts}) in ${delaySeconds}s${theme.format.ellipsis} (esc to cancel)`,
					getSymbolTheme().spinnerFrames,
				);
				this.statusContainer.addChild(this.retryLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				// Restore escape handler
				if (this.retryEscapeHandler) {
					this.editor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				// Stop loader
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
					this.statusContainer.clear();
				}
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				this.ui.requestRender();
				break;
			}

			case "ttsr_triggered": {
				// Show a fancy notification when TTSR rules are triggered
				const component = new TtsrNotificationComponent(event.rules);
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				this.ui.requestRender();
				break;
			}
		}
	}

	private sendCompletionNotification(): void {
		if (this.isBackgrounded === false) return;
		if (isNotificationSuppressed()) return;
		const method = this.settingsManager.getNotificationOnComplete();
		if (method === "off") return;
		const protocol = method === "auto" ? detectNotificationProtocol() : method;
		const title = this.sessionManager.getSessionTitle();
		const message = title ? `${title}: Complete` : "Complete";
		sendNotification(protocol, message);
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string, options?: { dim?: boolean }): void {
		if (this.isBackgrounded) {
			return;
		}
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;
		const useDim = options?.dim ?? true;
		const rendered = useDim ? theme.fg("dim", message) : message;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(rendered);
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(rendered, 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "hookMessage":
			case "custom": {
				if (message.display) {
					const renderer = this.session.extensionRunner?.getMessageRenderer(message.customType);
					// Both HookMessage and CustomMessage have the same structure, cast for compatibility
					this.chatContainer.addChild(new CustomMessageComponent(message as CustomMessage<unknown>, renderer));
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message);
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message);
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "fileMention": {
				// Render compact file mention display
				for (const file of message.files) {
					const text = `${theme.fg("dim", `${theme.tree.last} `)}${theme.fg("muted", "Read")} ${theme.fg(
						"accent",
						file.path,
					)} ${theme.fg("dim", `(${file.lineCount} lines)`)}`;
					this.chatContainer.addChild(new Text(text, 0, 0));
				}
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					const userComponent = new UserMessageComponent(textContent);
					this.chatContainer.addChild(userComponent);
					if (options?.populateHistory) {
						this.editor.addToHistory(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(message, this.hideThinkingBlock);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.pendingTools.clear();

		if (options.updateFooter) {
			this.statusLine.invalidate();
			this.updateEditorBorderColor();
		}

		for (const message of sessionContext.messages) {
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const tool = this.session.getToolByName(content.name);
						const component = new ToolExecutionComponent(
							content.name,
							content.arguments,
							{ showImages: this.settingsManager.getShowImages() },
							tool,
							this.ui,
							this.sessionManager.getCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							this.pendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = this.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					this.pendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		this.pendingTools.clear();
		this.ui.requestRender();
	}

	renderInitialMessages(): void {
		// Get aligned messages and entries from session context
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: true,
		});

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	async getUserInput(): Promise<{ text: string; images?: ImageContent[] }> {
		return new Promise((resolve) => {
			this.onInputCallback = (input) => {
				this.onInputCallback = undefined;
				resolve(input);
			};
		});
	}

	private rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context);
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Emits shutdown event to hooks and tools, then exits.
	 */
	private async shutdown(): Promise<void> {
		this.voiceAutoModeEnabled = false;
		await this.voiceSupervisor.stop();

		// Flush pending session writes before shutdown
		await this.sessionManager.flush();

		// Emit shutdown event to hooks
		await this.session.emitCustomToolSessionEvent("shutdown");

		this.stop();
		process.exit(0);
	}

	private handleCtrlZ(): void {
		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			this.ui.start();
			this.ui.requestRender(true);
		});

		// Stop the TUI (restore terminal to normal mode)
		this.ui.stop();

		// Send SIGTSTP to process group (pid=0 means all processes in group)
		process.kill(0, "SIGTSTP");
	}

	/**
	 * Handle Alt+Up: pop the last queued message and restore it to the editor.
	 */
	private handleDequeue(): void {
		const message = this.session.popLastQueuedMessage();
		if (!message) return;

		// Prepend to existing editor text (if any)
		const currentText = this.editor.getText();
		const newText = currentText ? `${message}\n\n${currentText}` : message;
		this.editor.setText(newText);
		this.updatePendingMessagesDisplay();
		this.ui.requestRender();
	}

	private handleBackgroundCommand(): void {
		if (this.isBackgrounded) {
			this.showStatus("Background mode already enabled");
			return;
		}
		if (!this.session.isStreaming && this.session.queuedMessageCount === 0) {
			this.showWarning("Agent is idle; nothing to background");
			return;
		}

		this.isBackgrounded = true;
		const backgroundUiContext = this.createBackgroundUiContext();

		// Background mode disables interactive UI so tools like ask fail fast.
		this.setToolUIContext(backgroundUiContext, false);
		this.initializeHookRunner(backgroundUiContext, false);

		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		if (this.autoCompactionLoader) {
			this.autoCompactionLoader.stop();
			this.autoCompactionLoader = undefined;
		}
		if (this.retryLoader) {
			this.retryLoader.stop();
			this.retryLoader = undefined;
		}
		this.statusContainer.clear();
		this.statusLine.dispose();

		if (this.unsubscribe) {
			this.unsubscribe();
		}
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleBackgroundEvent(event);
		});

		// Backgrounding keeps the current process to preserve in-flight agent state.
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}

		process.stdout.write("Background mode enabled. Run `bg` to continue in background.\n");

		if (process.platform === "win32" || !process.stdout.isTTY) {
			process.stdout.write("Backgrounding requires POSIX job control; continuing in foreground.\n");
			return;
		}

		process.kill(0, "SIGTSTP");
	}

	private async handleBackgroundEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type !== "agent_end") {
			return;
		}
		if (this.session.queuedMessageCount > 0 || this.session.isStreaming) {
			return;
		}
		this.sendCompletionNotification();
		await this.shutdown();
	}

	/**
	 * Handle Ctrl+V for image paste from clipboard.
	 * Returns true if an image was found and added, false otherwise.
	 */
	private async handleImagePaste(): Promise<boolean> {
		try {
			const image = await readImageFromClipboard();
			if (image) {
				let imageData = image;
				if (this.settingsManager.getImageAutoResize()) {
					try {
						const resized = await resizeImage({
							type: "image",
							data: image.data,
							mimeType: image.mimeType,
						});
						imageData = { data: resized.data, mimeType: resized.mimeType };
					} catch {
						imageData = image;
					}
				}

				this.pendingImages.push({
					type: "image",
					data: imageData.data,
					mimeType: imageData.mimeType,
				});
				// Insert styled placeholder at cursor like Claude does
				const imageNum = this.pendingImages.length;
				const placeholder = theme.bold(theme.underline(`[Image #${imageNum}]`));
				this.editor.insertText(`${placeholder} `);
				this.ui.requestRender();
				return true;
			}
			// No image in clipboard - show hint
			this.showStatus("No image in clipboard (use terminal paste for text)");
			return false;
		} catch {
			this.showStatus("Failed to read clipboard");
			return false;
		}
	}

	private setVoiceStatus(text: string | undefined): void {
		this.statusLine.setHookStatus("voice", text);
		this.ui.requestRender();
	}

	private async handleVoiceInterrupt(reason?: string): Promise<void> {
		const now = Date.now();
		if (now - this.lastVoiceInterruptAt < 200) return;
		this.lastVoiceInterruptAt = now;
		if (this.session.isBashRunning) {
			this.session.abortBash();
		}
		if (this.session.isStreaming) {
			await this.session.abort();
		}
		if (reason) {
			this.showStatus(reason);
		}
	}

	private stopVoiceProgressTimer(): void {
		if (this.voiceProgressTimer) {
			clearTimeout(this.voiceProgressTimer);
			this.voiceProgressTimer = undefined;
		}
	}

	private startVoiceProgressTimer(): void {
		this.stopVoiceProgressTimer();
		if (!this.settingsManager.getVoiceEnabled() || !this.voiceAutoModeEnabled) return;
		this.voiceProgressSpoken = false;
		this.voiceProgressLastLength = 0;
		this.voiceProgressTimer = setTimeout(() => {
			void this.maybeSpeakProgress();
		}, VOICE_PROGRESS_DELAY_MS);
	}

	private async maybeSpeakProgress(): Promise<void> {
		if (!this.session.isStreaming || this.voiceProgressSpoken || !this.voiceAutoModeEnabled) return;
		const streaming = this.streamingMessage;
		if (!streaming) return;
		const text = this.extractAssistantText(streaming);
		if (!text || text.length < VOICE_PROGRESS_MIN_CHARS) {
			if (this.session.isStreaming) {
				this.voiceProgressTimer = setTimeout(() => {
					void this.maybeSpeakProgress();
				}, VOICE_PROGRESS_DELAY_MS);
			}
			return;
		}

		const delta = text.length - this.voiceProgressLastLength;
		if (delta < VOICE_PROGRESS_DELTA_CHARS) {
			if (this.session.isStreaming) {
				this.voiceProgressTimer = setTimeout(() => {
					void this.maybeSpeakProgress();
				}, VOICE_PROGRESS_DELAY_MS);
			}
			return;
		}

		this.voiceProgressLastLength = text.length;
		this.voiceProgressSpoken = true;
		this.voiceSupervisor.notifyProgress(text);
	}

	private async submitVoiceText(text: string): Promise<void> {
		const cleaned = text.trim();
		if (!cleaned) {
			this.showWarning("No speech detected. Try again.");
			return;
		}
		const toSend = cleaned;
		this.editor.addToHistory(toSend);

		if (this.session.isStreaming) {
			await this.session.abort();
			await this.session.steer(toSend);
			this.updatePendingMessagesDisplay();
			return;
		}

		if (this.onInputCallback) {
			this.onInputCallback({ text: toSend });
		}
	}

	private findLastAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.session.messages.length - 1; i >= 0; i--) {
			const message = this.session.messages[i];
			if (message?.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	private extractAssistantText(message: AssistantMessage): string {
		let text = "";
		for (const content of message.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}
		return text.trim();
	}

	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		// Update footer content in editor's top border
		this.updateEditorTopBorder();
		this.ui.requestRender();
	}

	private updateEditorTopBorder(): void {
		const width = this.ui.getWidth();
		const topBorder = this.statusLine.getTopBorder(width);
		this.editor.setTopBorder(topBorder);
	}

	private cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.statusLine.invalidate();
			this.updateEditorBorderColor();
		}
	}

	private async cycleRoleModel(options?: { temporary?: boolean }): Promise<void> {
		try {
			const roleOrder = ["slow", "default", "smol"];
			const result = await this.session.cycleRoleModels(roleOrder, options);
			if (!result) {
				this.showStatus("Only one role model available");
				return;
			}

			this.statusLine.invalidate();
			this.updateEditorBorderColor();
			const roleLabel = result.role === "default" ? "default" : result.role;
			const roleLabelStyled = theme.bold(theme.fg("accent", roleLabel));
			const thinkingStr =
				result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
			const tempLabel = options?.temporary ? " (temporary)" : "";
			const cycleSeparator = theme.fg("dim", " > ");
			const cycleLabel = roleOrder
				.map((role) => {
					if (role === result.role) {
						return theme.bold(theme.fg("accent", role));
					}
					return theme.fg("muted", role);
				})
				.join(cycleSeparator);
			const orderLabel = ` (cycle: ${cycleLabel})`;
			this.showStatus(
				`Switched to ${roleLabelStyled}: ${result.model.name || result.model.id}${thinkingStr}${tempLabel}${orderLabel}`,
				{ dim: false },
			);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private toggleToolOutputExpansion(): void {
		this.toolOutputExpanded = !this.toolOutputExpanded;
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(this.toolOutputExpanded);
			}
		}
		this.ui.requestRender();
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		// Rebuild chat from session messages
		this.chatContainer.clear();
		this.rebuildChatFromMessages();

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.streamingComponent && this.streamingMessage) {
			this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
			this.streamingComponent.updateContent(this.streamingMessage);
			this.chatContainer.addChild(this.streamingComponent);
		}

		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private openExternalEditor(): void {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `omp-editor-${nanoid()}.omp.md`);

		try {
			// Write current content to temp file
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			// Stop TUI to release terminal
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			// Spawn editor synchronously with inherited stdio for interactive editing
			const result = Bun.spawnSync([editor, ...editorArgs, tmpFile], {
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});

			// On successful exit (exitCode 0), replace editor content
			if (result.exitCode === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			// Clean up temp file
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			// Restart TUI
			this.ui.start();
			this.ui.requestRender();
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		if (this.isBackgrounded) {
			return;
		}
		this.editor.setText("");
		this.pendingImages = [];
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		if (this.isBackgrounded) {
			console.error(`Error: ${errorMessage}`);
			return;
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		if (this.isBackgrounded) {
			console.error(`Warning: ${warningMessage}`);
			return;
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showNewVersionNotification(newVersion: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				theme.bold(theme.fg("warning", "Update Available")) +
					"\n" +
					theme.fg("muted", `New version ${newVersion} is available. Run: `) +
					theme.fg("accent", "omp update"),
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const queuedMessages = this.session.getQueuedMessages();
		const steeringMessages = [
			...queuedMessages.steering.map((message) => ({ message, label: "Steer" })),
			...this.compactionQueuedMessages
				.filter((entry) => entry.mode === "steer")
				.map((entry) => ({ message: entry.text, label: "Steer" })),
		];
		const followUpMessages = [
			...queuedMessages.followUp.map((message) => ({ message, label: "Follow-up" })),
			...this.compactionQueuedMessages
				.filter((entry) => entry.mode === "followUp")
				.map((entry) => ({ message: entry.text, label: "Follow-up" })),
		];
		const allMessages = [...steeringMessages, ...followUpMessages];
		if (allMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const entry of allMessages) {
				const queuedText = theme.fg("dim", `${entry.label}: ${entry.message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(queuedText, 1, 0));
			}
		}
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.editor.addToHistory(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isKnownSlashCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		if (!commandName) return false;

		if (this.session.extensionRunner?.getCommand(commandName)) {
			return true;
		}

		if (this.session.customCommands.some((cmd) => cmd.command.name === commandName)) {
			return true;
		}

		return this.fileSlashCommands.has(commandName);
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				for (const message of queuedMessages) {
					if (this.isKnownSlashCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "followUp") {
						await this.session.followUp(message.text);
					} else {
						await this.session.steer(message.text);
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isKnownSlashCommand(message.text));
			if (firstPromptIndex === -1) {
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			const promptPromise = this.session.prompt(firstPrompt.text).catch((error) => {
				restoreQueue(error);
			});

			for (const message of rest) {
				if (this.isKnownSlashCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await this.session.followUp(message.text);
				} else {
					await this.session.steer(message.text);
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const { component, focus } = create(done);
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	private showSettingsSelector(): void {
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				this.settingsManager,
				{
					availableThinkingLevels: this.session.getAvailableThinkingLevels(),
					thinkingLevel: this.session.thinkingLevel,
					availableThemes: getAvailableThemes(),
					cwd: process.cwd(),
				},
				{
					onChange: (id, value) => this.handleSettingChange(id, value),
					onThemePreview: (themeName) => {
						const result = setTheme(themeName, true);
						if (result.success) {
							this.ui.invalidate();
							this.ui.requestRender();
						}
					},
					onStatusLinePreview: (settings) => {
						// Update status line with preview settings
						const currentSettings = this.settingsManager.getStatusLineSettings();
						this.statusLine.updateSettings({ ...currentSettings, ...settings });
						this.updateEditorTopBorder();
						this.ui.requestRender();
					},
					getStatusLinePreview: () => {
						// Return the rendered status line for inline preview
						const width = this.ui.getWidth();
						return this.statusLine.getTopBorder(width).content;
					},
					onPluginsChanged: () => {
						this.ui.requestRender();
					},
					onCancel: () => {
						done();
						// Restore status line to saved settings
						this.statusLine.updateSettings(this.settingsManager.getStatusLineSettings());
						this.updateEditorTopBorder();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	/**
	 * Show the Extension Control Center dashboard.
	 * Replaces /status with a unified view of all providers and extensions.
	 */
	private showExtensionsDashboard(): void {
		this.showSelector((done) => {
			const dashboard = new ExtensionDashboard(process.cwd(), this.settingsManager, this.ui.terminal.rows);
			dashboard.onClose = () => {
				done();
				this.ui.requestRender();
			};
			return { component: dashboard, focus: dashboard };
		});
	}

	/**
	 * Handle setting changes from the settings selector.
	 * Most settings are saved directly via SettingsManager in the definitions.
	 * This handles side effects and session-specific settings.
	 */
	private handleSettingChange(id: string, value: string | boolean): void {
		// Discovery provider toggles
		if (id.startsWith("discovery.")) {
			const providerId = id.replace("discovery.", "");
			if (value) {
				enableProvider(providerId);
			} else {
				disableProvider(providerId);
			}
			return;
		}

		switch (id) {
			// Session-managed settings (not in SettingsManager)
			case "autoCompact":
				this.session.setAutoCompactionEnabled(value as boolean);
				this.statusLine.setAutoCompactEnabled(value as boolean);
				break;
			case "steeringMode":
				this.session.setSteeringMode(value as "all" | "one-at-a-time");
				break;
			case "followUpMode":
				this.session.setFollowUpMode(value as "all" | "one-at-a-time");
				break;
			case "interruptMode":
				this.session.setInterruptMode(value as "immediate" | "wait");
				break;
			case "thinkingLevel":
				this.session.setThinkingLevel(value as ThinkingLevel);
				this.statusLine.invalidate();
				this.updateEditorBorderColor();
				break;

			// Settings with UI side effects
			case "showImages":
				for (const child of this.chatContainer.children) {
					if (child instanceof ToolExecutionComponent) {
						child.setShowImages(value as boolean);
					}
				}
				break;
			case "hideThinking":
				this.hideThinkingBlock = value as boolean;
				for (const child of this.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setHideThinkingBlock(value as boolean);
					}
				}
				this.chatContainer.clear();
				this.rebuildChatFromMessages();
				break;
			case "theme": {
				const result = setTheme(value as string, true);
				this.statusLine.invalidate();
				this.updateEditorTopBorder();
				this.ui.invalidate();
				if (!result.success) {
					this.showError(`Failed to load theme "${value}": ${result.error}\nFell back to dark theme.`);
				}
				break;
			}
			case "symbolPreset": {
				setSymbolPreset(value as "unicode" | "nerd" | "ascii");
				this.statusLine.invalidate();
				this.updateEditorTopBorder();
				this.ui.invalidate();
				break;
			}
			case "voiceEnabled": {
				if (!value) {
					this.voiceAutoModeEnabled = false;
					this.stopVoiceProgressTimer();
					void this.voiceSupervisor.stop();
					this.setVoiceStatus(undefined);
				}
				break;
			}
			case "statusLinePreset":
			case "statusLineSeparator":
			case "statusLineShowHooks":
			case "statusLineSegments":
			case "statusLineModelThinking":
			case "statusLinePathAbbreviate":
			case "statusLinePathMaxLength":
			case "statusLinePathStripWorkPrefix":
			case "statusLineGitShowBranch":
			case "statusLineGitShowStaged":
			case "statusLineGitShowUnstaged":
			case "statusLineGitShowUntracked":
			case "statusLineTimeFormat":
			case "statusLineTimeShowSeconds": {
				this.statusLine.updateSettings(this.settingsManager.getStatusLineSettings());
				this.updateEditorTopBorder();
				this.ui.requestRender();
				break;
			}

			// Provider settings - update runtime preferences
			case "webSearchProvider":
				setPreferredWebSearchProvider(value as "auto" | "exa" | "perplexity" | "anthropic");
				break;
			case "imageProvider":
				setPreferredImageProvider(value as "auto" | "gemini" | "openrouter");
				break;

			// All other settings are handled by the definitions (get/set on SettingsManager)
			// No additional side effects needed
		}
	}

	private showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.settingsManager,
				this.session.modelRegistry,
				this.session.scopedModels,
				async (model, role) => {
					try {
						if (role === "temporary") {
							// Temporary: update agent state but don't persist to settings
							await this.session.setModelTemporary(model);
							this.statusLine.invalidate();
							this.updateEditorBorderColor();
							this.showStatus(`Temporary model: ${model.id}`);
							done();
							this.ui.requestRender();
						} else if (role === "default") {
							// Default: update agent state and persist
							await this.session.setModel(model, role);
							this.statusLine.invalidate();
							this.updateEditorBorderColor();
							this.showStatus(`Default model: ${model.id}`);
							// Don't call done() - selector stays open for role assignment
						} else {
							// Other roles (smol, slow): just update settings, not current model
							const roleLabel = role === "smol" ? "Smol" : role;
							this.showStatus(`${roleLabel} model: ${model.id}`);
							// Don't call done() - selector stays open
						}
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				options,
			);
			return { component: selector, focus: selector };
		});
	}

	private showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForBranching();

		if (userMessages.length === 0) {
			this.showStatus("No messages to branch from");
			return;
		}

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					const result = await this.session.branch(entryId);
					if (result.cancelled) {
						// Hook cancelled the branch
						done();
						this.ui.requestRender();
						return;
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					this.editor.setText(result.selectedText);
					done();
					this.showStatus("Branched to new session");
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private showTreeSelector(): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();

		// Find the visible leaf for display (skip metadata entries like labels)
		let visibleLeafId = realLeafId;
		while (visibleLeafId) {
			const entry = this.sessionManager.getEntry(visibleLeafId);
			if (!entry) break;
			if (entry.type !== "label" && entry.type !== "custom") break;
			visibleLeafId = entry.parentId ?? null;
		}

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				visibleLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the visible leaf is a no-op (already there)
					if (entryId === visibleLeafId) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization (or skip if disabled in settings)
					done(); // Close selector first

					const branchSummariesEnabled = this.settingsManager.getBranchSummaryEnabled();
					const wantsSummary = branchSummariesEnabled
						? await this.showHookConfirm("Summarize branch?", "Create a summary of the branch you're leaving?")
						: false;

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.editor.onEscape;

					if (wantsSummary) {
						this.editor.onEscape = () => {
							this.session.abortBranchSummary();
						};
						this.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ui,
							(spinner) => theme.fg("accent", spinner),
							(text) => theme.fg("muted", text),
							"Summarizing branch... (esc to cancel)",
							getSymbolTheme().spinnerFrames,
						);
						this.statusContainer.addChild(summaryLoader);
						this.ui.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, { summarize: wantsSummary });

						if (result.aborted) {
							// Summarization aborted - re-show tree selector
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector();
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.statusContainer.clear();
						}
						this.editor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const sessions = SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir());
			const selector = new SessionSelectorComponent(
				sessions,
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
			);
			return { component: selector, focus: selector.getSessionList() };
		});
	}

	private async handleResumeSession(sessionPath: string): Promise<void> {
		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		// Clear UI state
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();

		// Switch session via AgentSession (emits hook and tool session events)
		await this.session.switchSession(sessionPath);

		// Clear and re-render the chat
		this.chatContainer.clear();
		this.renderInitialMessages();
		this.showStatus("Resumed session");
	}

	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		if (mode === "logout") {
			const providers = this.session.modelRegistry.authStorage.list();
			const loggedInProviders = providers.filter((p) => this.session.modelRegistry.authStorage.hasOAuth(p));
			if (loggedInProviders.length === 0) {
				this.showStatus("No OAuth providers logged in. Use /login first.");
				return;
			}
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				this.session.modelRegistry.authStorage,
				async (providerId: string) => {
					done();

					if (mode === "login") {
						this.showStatus(`Logging in to ${providerId}...`);

						try {
							await this.session.modelRegistry.authStorage.login(providerId as OAuthProvider, {
								onAuth: (info: { url: string; instructions?: string }) => {
									this.chatContainer.addChild(new Spacer(1));
									this.chatContainer.addChild(new Text(theme.fg("dim", info.url), 1, 0));
									// Use OSC 8 hyperlink escape sequence for clickable link
									const hyperlink = `\x1b]8;;${info.url}\x07Click here to login\x1b]8;;\x07`;
									this.chatContainer.addChild(new Text(theme.fg("accent", hyperlink), 1, 0));
									if (info.instructions) {
										this.chatContainer.addChild(new Spacer(1));
										this.chatContainer.addChild(new Text(theme.fg("warning", info.instructions), 1, 0));
									}
									this.ui.requestRender();

									this.openInBrowser(info.url);
								},
								onPrompt: async (prompt: { message: string; placeholder?: string }) => {
									this.chatContainer.addChild(new Spacer(1));
									this.chatContainer.addChild(new Text(theme.fg("warning", prompt.message), 1, 0));
									if (prompt.placeholder) {
										this.chatContainer.addChild(new Text(theme.fg("dim", prompt.placeholder), 1, 0));
									}
									this.ui.requestRender();

									return new Promise<string>((resolve) => {
										const codeInput = new Input();
										codeInput.onSubmit = () => {
											const code = codeInput.getValue();
											this.editorContainer.clear();
											this.editorContainer.addChild(this.editor);
											this.ui.setFocus(this.editor);
											resolve(code);
										};
										this.editorContainer.clear();
										this.editorContainer.addChild(codeInput);
										this.ui.setFocus(codeInput);
										this.ui.requestRender();
									});
								},
								onProgress: (message: string) => {
									this.chatContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
									this.ui.requestRender();
								},
							});
							// Refresh models to pick up new baseUrl (e.g., github-copilot)
							await this.session.modelRegistry.refresh();
							this.chatContainer.addChild(new Spacer(1));
							this.chatContainer.addChild(
								new Text(
									theme.fg("success", `${theme.status.success} Successfully logged in to ${providerId}`),
									1,
									0,
								),
							);
							this.chatContainer.addChild(
								new Text(theme.fg("dim", `Credentials saved to ${getAuthPath()}`), 1, 0),
							);
							this.ui.requestRender();
						} catch (error: unknown) {
							this.showError(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					} else {
						try {
							await this.session.modelRegistry.authStorage.logout(providerId);
							// Refresh models to reset baseUrl
							await this.session.modelRegistry.refresh();
							this.chatContainer.addChild(new Spacer(1));
							this.chatContainer.addChild(
								new Text(
									theme.fg("success", `${theme.status.success} Successfully logged out of ${providerId}`),
									1,
									0,
								),
							);
							this.chatContainer.addChild(
								new Text(theme.fg("dim", `Credentials removed from ${getAuthPath()}`), 1, 0),
							);
							this.ui.requestRender();
						} catch (error: unknown) {
							this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private openInBrowser(urlOrPath: string): void {
		try {
			const args =
				process.platform === "darwin"
					? ["open", urlOrPath]
					: process.platform === "win32"
						? ["cmd", "/c", "start", "", urlOrPath]
						: ["xdg-open", urlOrPath];
			Bun.spawn(args, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		} catch {
			// Best-effort: browser opening is non-critical
		}
	}

	private async handleExportCommand(text: string): Promise<void> {
		const parts = text.split(/\s+/);
		const arg = parts.length > 1 ? parts[1] : undefined;

		// Check for clipboard export
		if (arg === "--copy" || arg === "clipboard" || arg === "copy") {
			try {
				const formatted = this.session.formatSessionAsText();
				if (!formatted) {
					this.showError("No messages to export yet.");
					return;
				}
				await copyToClipboard(formatted);
				this.showStatus("Session copied to clipboard");
			} catch (error: unknown) {
				this.showError(`Failed to copy session: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
			return;
		}

		// HTML file export
		try {
			const filePath = await this.session.exportToHtml(arg);
			this.showStatus(`Session exported to: ${filePath}`);
			this.openInBrowser(filePath);
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private async handleShareCommand(): Promise<void> {
		// Check if gh is available and logged in
		try {
			const authResult = Bun.spawnSync(["gh", "auth", "status"]);
			if (authResult.exitCode !== 0) {
				this.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			this.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		// Export to a temp file
		const tmpFile = path.join(os.tmpdir(), "session.html");
		try {
			await this.session.exportToHtml(tmpFile);
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}

		// Show cancellable loader, replacing the editor
		const loader = new BorderedLoader(this.ui, theme, "Creating gist...");
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		const restoreEditor = () => {
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}
		};

		// Create a secret gist asynchronously
		let proc: ReturnType<typeof Bun.spawn> | null = null;

		loader.onAbort = () => {
			proc?.kill();
			restoreEditor();
			this.showStatus("Share cancelled");
		};

		try {
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
				proc = Bun.spawn(["gh", "gist", "create", "--public=false", tmpFile], {
					stdout: "pipe",
					stderr: "pipe",
				});
				let stdout = "";
				let stderr = "";

				const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
				const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
				const decoder = new TextDecoder();

				(async () => {
					try {
						while (true) {
							const { done, value } = await stdoutReader.read();
							if (done) break;
							stdout += decoder.decode(value);
						}
					} catch {}
				})();

				(async () => {
					try {
						while (true) {
							const { done, value } = await stderrReader.read();
							if (done) break;
							stderr += decoder.decode(value);
						}
					} catch {}
				})();

				proc.exited.then((code) => resolve({ stdout, stderr, code }));
			});

			if (loader.signal.aborted) return;

			restoreEditor();

			if (result.code !== 0) {
				const errorMsg = result.stderr?.trim() || "Unknown error";
				this.showError(`Failed to create gist: ${errorMsg}`);
				return;
			}

			// Extract gist ID from the URL returned by gh
			// gh returns something like: https://gist.github.com/username/GIST_ID
			const gistUrl = result.stdout?.trim();
			const gistId = gistUrl?.split("/").pop();
			if (!gistId) {
				this.showError("Failed to parse gist ID from gh output");
				return;
			}

			// Create the preview URL
			const previewUrl = `https://gistpreview.github.io/?${gistId}`;
			this.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
			this.openInBrowser(previewUrl);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}
	}

	private async handleCopyCommand(): Promise<void> {
		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			this.showStatus("Copied last agent message to clipboard");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleSessionCommand(): void {
		const stats = this.session.getSessionStats();

		let info = `${theme.bold("Session Info")}\n\n`;
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}`;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
						.reverse()
						.map((e) => e.content)
						.join("\n\n")
				: "No changelog entries found.";

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, getMarkdownTheme()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	/**
	 * Register extension-defined keyboard shortcuts with the editor.
	 */
	private registerExtensionShortcuts(): void {
		const runner = this.session.extensionRunner;
		if (!runner) return;

		const shortcuts = runner.getShortcuts();
		for (const [keyId, shortcut] of shortcuts) {
			this.editor.setCustomKeyHandler(keyId, () => {
				const ctx = runner.createCommandContext();
				try {
					shortcut.handler(ctx);
				} catch (err) {
					runner.emitError({
						extensionPath: shortcut.extensionPath,
						event: "shortcut",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			});
		}
	}

	private handleHotkeysCommand(): void {
		const hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`Arrow keys\` | Move cursor / browse history (Up when empty) |
| \`Option+Left/Right\` | Move by word |
| \`Ctrl+A\` / \`Home\` / \`Cmd+Left\` | Start of line |
| \`Ctrl+E\` / \`End\` / \`Cmd+Right\` | End of line |

**Editing**
| Key | Action |
|-----|--------|
| \`Enter\` | Send message |
| \`Shift+Enter\` / \`Alt+Enter\` | New line |
| \`Ctrl+W\` / \`Option+Backspace\` | Delete word backwards |
| \`Ctrl+U\` | Delete to start of line |
| \`Ctrl+K\` | Delete to end of line |

**Other**
| Key | Action |
|-----|--------|
| \`Tab\` | Path completion / accept autocomplete |
| \`Escape\` | Cancel autocomplete / abort streaming |
| \`Ctrl+C\` | Clear editor (first) / exit (second) |
| \`Ctrl+D\` | Exit (when editor is empty) |
| \`Ctrl+Z\` | Suspend to background |
| \`Shift+Tab\` | Cycle thinking level |
| \`Ctrl+P\` | Cycle role models (slow/default/smol) |
| \`Shift+Ctrl+P\` | Cycle role models (temporary) |
| \`Ctrl+Y\` | Select model (temporary) |
| \`Ctrl+L\` | Select model (set roles) |
| \`Ctrl+O\` | Toggle tool output expansion |
| \`Ctrl+T\` | Toggle thinking block visibility |
| \`Ctrl+G\` | Edit message in external editor |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, getMarkdownTheme()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private async handleClearCommand(): Promise<void> {
		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		// New session via session (emits hook and tool session events)
		await this.session.newSession();

		// Update status line (token counts, cost reset)
		this.statusLine.invalidate();
		this.updateEditorTopBorder();

		// Clear UI state
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(`${theme.fg("accent", `${theme.status.success} New session started`)}`, 1, 1),
		);
		this.ui.requestRender();
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const allLines = this.ui.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal width: ${width}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(
				`${theme.fg("accent", `${theme.status.success} Debug log written`)}\n${theme.fg("muted", debugLogPath)}`,
				1,
				1,
			),
		);
		this.ui.requestRender();
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		const entries = this.sessionManager.getEntries();
		const messageCount = entries.filter((e) => e.type === "message").length;

		if (messageCount < 2) {
			this.showWarning("Nothing to compact (no messages yet)");
			return;
		}

		await this.executeCompaction(customInstructions, false);
	}

	private async executeCompaction(customInstructions?: string, isAuto = false): Promise<void> {
		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		// Set up escape handler during compaction
		const originalOnEscape = this.editor.onEscape;
		this.editor.onEscape = () => {
			this.session.abortCompaction();
		};

		// Show compacting status
		this.chatContainer.addChild(new Spacer(1));
		const label = isAuto ? "Auto-compacting context... (esc to cancel)" : "Compacting context... (esc to cancel)";
		const compactingLoader = new Loader(
			this.ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
			getSymbolTheme().spinnerFrames,
		);
		this.statusContainer.addChild(compactingLoader);
		this.ui.requestRender();

		try {
			const result = await this.session.compact(customInstructions);

			// Rebuild UI
			this.rebuildChatFromMessages();

			// Add compaction component at bottom so user sees it without scrolling
			const msg = createCompactionSummaryMessage(result.summary, result.tokensBefore, new Date().toISOString());
			this.addMessageToChat(msg);

			this.statusLine.invalidate();
			this.updateEditorTopBorder();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError")) {
				this.showError("Compaction cancelled");
			} else {
				this.showError(`Compaction failed: ${message}`);
			}
		} finally {
			compactingLoader.stop();
			this.statusContainer.clear();
			this.editor.onEscape = originalOnEscape;
		}
		await this.flushCompactionQueue({ willRetry: false });
	}

	stop(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusLine.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.cleanupUnsubscribe) {
			this.cleanupUnsubscribe();
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
}

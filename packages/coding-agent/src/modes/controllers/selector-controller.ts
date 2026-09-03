import { type AgentMessage, type AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import { PASTE_CODE_LOGIN_PROVIDERS, type UsageReport } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { Component, OverlayHandle, ResizeScrollbackMode } from "@oh-my-pi/pi-tui";
import { Loader, Spacer, setTuiTight, Text } from "@oh-my-pi/pi-tui";
import { getAgentDbPath, getAgentDir, getProjectDir, normalizePathForComparison } from "@oh-my-pi/pi-utils";
import {
	type AdvisorConfigScope,
	discoverAdvisorConfigs,
	loadWatchdogConfigFile,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
} from "../../advisor";
import { reset as resetCapabilities } from "../../capability";
import { showGitOverlay } from "../../cli/git-tui";
import {
	formatModelSelectorValue,
	resolveAdvisorRoleSelection,
	resolveModelRoleValue,
} from "../../config/model-resolver";
import { getRoleInfo } from "../../config/model-roles";
import { settings } from "../../config/settings";
import { disableProvider, enableProvider } from "../../discovery";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../extensibility/plugins/marketplace";
import {
	getAvailableThemes,
	getSymbolTheme,
	previewTheme,
	setColorBlindMode,
	setMarkdownMermaidRendering,
	setSymbolPreset,
	setTheme,
	theme,
} from "../../modes/theme/theme";
import type { AgentHubOpenOptions, InteractiveModeContext } from "../../modes/types";
import type { SessionOAuthAccountList } from "../../session/agent-session-types";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome } from "../../session/auth-storage";
import {
	createForeignSessionStore,
	foreignSessionInfoToSessionInfo,
	foreignSessionSourceName,
	persistForeignSession,
} from "../../session/foreign-session-import";
import type { ForeignSessionInfo, ForeignSessionSource } from "../../session/foreign-session-store";
import type { SessionEntry, SessionMessageEntry, SessionTreeNode } from "../../session/session-entries";
import type { SessionInfo } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { loadPinnedSessionIds } from "../../session/session-pins";
import { FileSessionStorage } from "../../session/session-storage";
import { type LogoutAccount, toLogoutAccounts } from "../../slash-commands/helpers/logout";
import {
	describeRedeemOutcome,
	type ResetUsageAccount,
	toResetUsageAccounts,
} from "../../slash-commands/helpers/reset-usage";
import { toSessionPinAccounts } from "../../slash-commands/helpers/session-pin";
import { loadDailyActivity } from "../../stats/activity-client";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	parseConfiguredThinkingLevel,
} from "../../thinking";
import {
	isSearchProviderId,
	setExcludedSearchProviders,
	setImageProviderOrder,
	setSearchProviderOrder,
	type ToolSession,
} from "../../tools";
import { AskTool, type AskToolDetails, type AskToolInput } from "../../tools/ask";
import { shortenPath } from "../../tools/render-utils";
import { ToolAbortError } from "../../tools/tool-errors";
import { applyHyperlinkSetting } from "../../tui/hyperlink";
import { copyToClipboard } from "../../utils/clipboard";
import { setSessionTerminalTitle } from "../../utils/title-generator";
import { type AdvisorConfigDeps, AdvisorConfigOverlayComponent } from "../components/advisor-config";
import { AgentHubOverlayComponent } from "../components/agent-hub";
import { AgentsHubComponent } from "../components/agents-hub";
import { AssistantMessageComponent } from "../components/assistant-message";
import { CopySelectorComponent } from "../components/copy-selector";
import { ExtensionDashboard } from "../components/extensions";
import { listLiveToolRecords, liveToolRecordFromSession } from "../components/extensions/live-tool-session";
import { HistorySearchComponent } from "../components/history-search";
import { LoginDialogComponent } from "../components/login-dialog";
import { LogoutAccountSelectorComponent } from "../components/logout-account-selector";
import { ModelHubComponent, type ModelRoleSelectionScope } from "../components/model-hub";
import { ModelPickerComponent } from "../components/model-picker";
import { OAuthSelectorComponent } from "../components/oauth-selector";
import { PluginSelectorComponent } from "../components/plugin-selector";
import { ReadToolGroupComponent } from "../components/read-tool-group";
import { ResetUsageSelectorComponent } from "../components/reset-usage-selector";
import { type BranchVariantPath, RewindSelectorComponent } from "../components/rewind-selector";
import { renderSegmentTrack } from "../components/segment-track";
import { SessionAccountSelectorComponent } from "../components/session-account-selector";
import { SessionSelectorComponent, type SessionSelectorOptions } from "../components/session-selector";
import { SettingsSelectorComponent } from "../components/settings-selector";
import { ToolExecutionComponent } from "../components/tool-execution";
import { TranscriptBlock } from "../components/transcript-container";
import { TreeSelectorComponent } from "../components/tree-selector";
import { UsageDashboardComponent } from "../components/usage-dashboard";
import { renderUsageReports } from "./command-controller";
import type { SessionObserverRegistry } from "../session-observer-registry";

const MANUAL_LOGIN_PROMPT = "Paste the authorization code (or full redirect URL), then press Enter:";

export class SelectorController {
	constructor(private ctx: InteractiveModeContext) {}
	/**
	 * Mount a primary fullscreen menu through the one polished modal path shared
	 * by Settings, Model Hub, and Agent Hub.
	 */
	#showFullscreenMenu(component: Component): OverlayHandle {
		const handle = this.ctx.ui.showOverlay(component, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(component);
		this.ctx.ui.requestRender();
		return handle;
	}

	#defaultRoleMutationTail = Promise.resolve();

	async #acquireDefaultRoleMutation(): Promise<() => void> {
		const previous = this.#defaultRoleMutationTail;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#defaultRoleMutationTail = previous.then(() => promise);
		await previous;
		return resolve;
	}

	async #refreshOAuthProviderAuthState(): Promise<void> {
		const oauthProviders = getOAuthProviders();
		await Promise.all(
			oauthProviders.map(provider =>
				this.ctx.session.modelRegistry
					.getApiKeyForProvider(provider.id, this.ctx.session.sessionId)
					.catch(() => undefined),
			),
		);
	}

	/**
	 * Restore keyboard focus to whatever currently owns the editor slot. The
	 * slot can hold the editor itself or a hook selector/input/editor pushed
	 * in by `ExtensionUiController` — e.g. an approval prompt that fired while
	 * a fullscreen overlay was up. `overlayHandle.hide()` restores focus to
	 * the component focused when the overlay opened, which is stale in that
	 * case (the editor was swapped out): keys land on a hidden editor and the
	 * visible prompt receives nothing (issue #3349). Call this after the
	 * overlay hides to re-target focus at the visible slot owner.
	 */
	focusActiveEditorArea(): void {
		const visible = this.ctx.editorContainer.children[0] ?? this.ctx.editor;
		this.ctx.ui.setFocus(visible);
	}

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};
		const { component, focus } = create(done);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(component);
		this.ctx.ui.setFocus(focus);
		this.ctx.ui.requestRender();
	}

	showSettingsSelector(): void {
		getAvailableThemes().then(availableThemes => {
			// Fullscreen settings editor on the alternate screen: the overlay
			// enables mouse tracking (click/hover/wheel) for its lifetime and
			// the transcript stays untouched underneath.
			const done = () => {
				overlayHandle?.hide();
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			};
			const selector = new SettingsSelectorComponent(
				{
					availableThinkingLevels: [...this.ctx.session.getAvailableThinkingLevels()],
					thinkingLevel: this.ctx.session.thinkingLevel,
					availableThemes,
					providers: [...new Set(this.ctx.session.getAvailableModels().map(model => model.provider))].sort(
						(a, b) => a.localeCompare(b),
					),
					cwd: getProjectDir(),
					model: this.ctx.session.model,
					imageBudget: this.ctx.ui.imageBudget,
					requestRender: () => this.ctx.ui.requestRender(),
					composerPreviewStatus: this.ctx.statusLine,
				},
				{
					onChange: (id, value) => this.handleSettingChange(id, value),
					onThemePreview: async themeName => {
						const result = await previewTheme(themeName);
						if (result.success) {
							this.ctx.statusLine.invalidate();
							this.ctx.ui.invalidate();
							this.ctx.ui.requestRender();
						}
					},
					onStatusLinePreview: previewSettings => {
						// Update status line with preview settings
						this.ctx.statusLine.updateSettings({
							preset: settings.get("statusLine.preset"),
							leftSegments: settings.get("statusLine.leftSegments"),
							rightSegments: settings.get("statusLine.rightSegments"),
							separator: settings.get("statusLine.separator"),
							showHookStatus: settings.get("statusLine.showHookStatus"),
							sessionAccent: settings.get("statusLine.sessionAccent"),
							transparent: settings.get("statusLine.transparent"),
							compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
							contextLine: settings.get("statusLine.contextLine"),
							...previewSettings,
						});
						this.ctx.ui.requestRender();
					},
					getStatusLinePreview: () => {
						// The bar exactly as the active composer shape renders it (box top
						// border, claude rule + chip, or the plain standalone bottom bar).
						const availableWidth = this.ctx.editor.getTopBorderAvailableWidth(this.ctx.ui.terminal.columns);
						return this.ctx.statusLine.getPreviewLines(availableWidth).join("\n");
					},
					onPluginsChanged: async () => {
						const projectPath = await resolveActiveProjectRegistryPath(this.ctx.sessionManager.getCwd());
						clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
						await this.ctx.refreshSkillState();
						await this.ctx.refreshSlashCommandState();
						resetCapabilities();
						this.ctx.ui.requestRender();
					},
					onCancel: () => {
						done();
						// Restore status line to saved settings
						this.ctx.statusLine.updateSettings({
							preset: settings.get("statusLine.preset"),
							leftSegments: settings.get("statusLine.leftSegments"),
							rightSegments: settings.get("statusLine.rightSegments"),
							separator: settings.get("statusLine.separator"),
							showHookStatus: settings.get("statusLine.showHookStatus"),
							sessionAccent: settings.get("statusLine.sessionAccent"),
							transparent: settings.get("statusLine.transparent"),
							compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
							contextLine: settings.get("statusLine.contextLine"),
						});
						this.ctx.ui.requestRender();
					},
				},
			);
			const overlayHandle = this.#showFullscreenMenu(selector);
		});
	}

	/**
	 * Fullscreen `/usage` dashboard on the alternate screen (the /settings
	 * idiom): compact subscriptions grid + daily activity heatmap, with the
	 * classic full report one keypress away. Takes no transcript space.
	 */
	showUsageDashboard(reports: UsageReport[]): void {
		const currentProvider = this.ctx.session.model?.provider;
		const activeAccount = currentProvider
			? this.ctx.session.modelRegistry.authStorage.getOAuthAccountIdentity(
					currentProvider,
					this.ctx.session.sessionId,
				)
			: undefined;
		const usageModelSelectors = this.ctx.session.getUsageReportingModelSelectors(reports);
		const done = () => {
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const dashboard = new UsageDashboardComponent({
			reports,
			renderDetail: width =>
				renderUsageReports(
					reports,
					theme,
					Date.now(),
					width,
					provider => (provider === currentProvider ? activeAccount : undefined),
					usageModelSelectors,
				),
			loadActivity: loadDailyActivity,
			requestRender: () => this.ctx.ui.requestRender(),
			onClose: done,
		});
		const overlayHandle = this.#showFullscreenMenu(dashboard);
	}

	showAdvisorConfigure(): void {
		const cwd = this.ctx.sessionManager.getCwd();
		const agentDir = getAgentDir() ?? getProjectDir();
		const initialScope: AdvisorConfigScope = "project";
		void (async () => {
			// "Project" scope edits the repo-root WATCHDOG.yml (the project-level file
			// discovery walks), not the launch subdir — `getProjectDir()` is only cwd.
			let projectDir = cwd;
			try {
				projectDir = vcs.repo(cwd)?.root() ?? cwd;
			} catch {
				projectDir = cwd;
			}
			const dirs = { projectDir, agentDir };
			const initialDoc = await loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(initialScope, dirs));
			// Fullscreen editor on the alternate screen (the /settings idiom): the
			// overlay holds the alt buffer + mouse tracking; the transcript stays put.
			const done = () => {
				overlayHandle?.hide();
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			};
			// Label the seeded implicit-default row with the actual advisor-role model
			// (NOT the first live advisor, which may be a named advisor from another scope).
			const advisorRoleSel = resolveAdvisorRoleSelection(
				this.ctx.settings,
				this.ctx.session.modelRegistry.getAvailable(),
			);
			const defaultAdvisorModel = advisorRoleSel?.model;
			const deps: AdvisorConfigDeps = {
				modelRegistry: this.ctx.session.modelRegistry,
				settings: this.ctx.settings,
				scopedModels: this.ctx.session.scopedModels,
				availableToolNames: this.ctx.session.getAdvisorAvailableToolNames(),
				defaultModelLabel: defaultAdvisorModel
					? `${defaultAdvisorModel.provider}/${defaultAdvisorModel.id}`
					: undefined,
			};
			const overlay = new AdvisorConfigOverlayComponent(this.ctx.ui, deps, initialScope, initialDoc, {
				loadDoc: async scope => loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs)),
				save: async (scope, doc) => {
					await saveWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs), doc);
					// Re-discover the merged roster (project + user) so the live advisors
					// reflect cross-level precedence, not just the edited file.
					const discovered = await discoverAdvisorConfigs(cwd, agentDir);
					const count = this.ctx.session.applyAdvisorConfigs(discovered.advisors, discovered.sharedInstructions);
					this.ctx.statusLine.invalidate();
					this.ctx.showStatus(
						count > 0
							? `Saved ${scope} WATCHDOG.yml — ${count} advisor${count === 1 ? "" : "s"} active.`
							: `Saved ${scope} WATCHDOG.yml. Run /advisor on to activate the configured advisors.`,
					);
					this.ctx.ui.requestRender();
				},
				close: done,
				requestRender: () => this.ctx.ui.requestRender(),
				notify: message => this.ctx.showStatus(message),
				getAdvisorStats: () => this.ctx.session.getAdvisorStats().advisors,
				getUsageReports: async () => this.ctx.session.fetchUsageReports?.() ?? null,
				resolveActiveAccount: (provider, sessionId) =>
					this.ctx.session.modelRegistry.authStorage.getOAuthAccountIdentity(
						provider,
						sessionId ?? this.ctx.session.sessionId,
					),
			});
			const overlayHandle = this.ctx.ui.showOverlay(overlay, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(overlay);
			this.ctx.ui.requestRender();
		})();
	}

	showHistorySearch(): void {
		const historyStorage = this.ctx.historyStorage;
		if (!historyStorage) return;

		this.showSelector(done => {
			const component = new HistorySearchComponent(
				historyStorage,
				prompt => {
					done();
					this.ctx.editor.setText(prompt);
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component, focus: component };
		});
	}

	/**
	 * Show the Extension Control Center dashboard.
	 * Replaces /status with a unified view of all providers and extensions.
	 */
	async showExtensionsDashboard(): Promise<void> {
		const dashboard = await ExtensionDashboard.create({
			cwd: getProjectDir(),
			settings: this.ctx.settings,
			terminalHeight: this.ctx.ui.terminal.rows,
			mcpManager: this.ctx.mcpManager,
			eventBus: this.ctx.eventBus,
			toolSource: {
				getLiveTool: name => liveToolRecordFromSession(this.ctx.session, name),
				listLiveTools: () => listLiveToolRecords(this.ctx.session),
			},
			onMcpToolsChanged: tools => this.ctx.session.refreshMCPTools(tools),
		});
		// Fullscreen dashboard on the alternate screen (the /settings idiom): the
		// overlay borrows the terminal's alt buffer and enables mouse tracking for
		// its lifetime, leaving the transcript untouched underneath.
		const overlay = this.ctx.ui.showOverlay(dashboard, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
			fullscreen: true,
		});
		dashboard.onClose = () => {
			dashboard.dispose();
			overlay.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		dashboard.onRequestRender = () => {
			this.ctx.ui.requestRender();
		};
	}

	/**
	 * Fullscreen git UI on the alternate screen (the /models idiom): split
	 * diff viewer, staging sidebar, and commit composer. Resolves focus back
	 * to the editor when the user closes it.
	 */
	async showGitTui(revision?: string): Promise<void> {
		try {
			await showGitOverlay(this.ctx.ui, { cwd: getProjectDir(), revision });
		} catch (error) {
			this.ctx.showStatus(error instanceof Error ? error.message : String(error));
		}
		this.focusActiveEditorArea();
		this.ctx.ui.requestRender();
	}

	/**
	 * Fullscreen agents hub on the alternate screen (the /models idiom): scope
	 * sidebar, agent rows, and chip strips that dive into the model browser.
	 */
	async showAgentsDashboard(): Promise<void> {
		const activeModel = this.ctx.session.model;
		const activeModelPattern = activeModel ? `${activeModel.provider}/${activeModel.id}` : undefined;
		const defaultModelPattern = this.ctx.settings.getModelRole("default");
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			hub?.dispose();
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const hub = await AgentsHubComponent.create(
			this.ctx.ui,
			getProjectDir(),
			this.ctx.settings,
			{
				modelRegistry: this.ctx.session.modelRegistry,
				activeModelPattern,
				defaultModelPattern,
				extensionRoots: () => this.ctx.session.effectiveExtensionRoots,
			},
			{ onCancel: () => done() },
		);
		const overlayHandle = this.#showFullscreenMenu(hub);
	}

	/**
	 * Handle setting changes from the settings selector.
	 * Most settings are saved directly via SettingsManager in the definitions.
	 * This handles side effects and session-specific settings.
	 */
	handleSettingChange(id: string, value: unknown): void {
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
				this.ctx.session.setAutoCompactionEnabled(value as boolean);
				this.ctx.statusLine.setAutoCompactEnabled(value as boolean);
				break;
			case "composer.shape":
				this.ctx.syncComposerShape();
				break;
			case "advisor.enabled":
				this.ctx.session.setAdvisorEnabled(value as boolean);
				this.ctx.statusLine.invalidate();
				this.ctx.ui.requestRender();
				break;
			case "steeringMode":
				this.ctx.session.setSteeringMode(value as "all" | "one-at-a-time");
				break;
			case "followUpMode":
				this.ctx.session.setFollowUpMode(value as "all" | "one-at-a-time");
				break;
			case "interruptMode":
				this.ctx.session.setInterruptMode(value as "immediate" | "wait");
				break;
			case "thinkingLevel":
			case "defaultThinkingLevel":
				this.ctx.session.setThinkingLevel(value as ConfiguredThinkingLevel, true);
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				break;
			case "personality":
				void this.ctx.session.refreshBaseSystemPrompt().catch(err => {
					this.ctx.showError(`Failed to apply personality: ${err}`);
				});
				break;
			case "tools.xdevDocs":
				void this.ctx.session.refreshBaseSystemPrompt().catch(err => {
					this.ctx.showError(`Failed to apply xd:// prompt docs setting: ${err}`);
				});
				break;
			case "memory.backend":
				void this.ctx.session.applyMemoryBackend().catch(err => {
					this.ctx.showError(`Failed to apply memory backend: ${err}`);
				});
				break;
			case "inspect_image.mode":
				void this.ctx.session.applyInspectImageModeChange().catch(err => {
					this.ctx.showError(`Failed to apply vision mode: ${err}`);
				});
				break;
			case "externalThinking":
				void this.ctx.session.setThinkToolEnabled(value as boolean).catch(err => {
					this.ctx.showError(`Failed to apply external thinking: ${err}`);
				});
				break;

			case "autocompleteMaxVisible":
				this.ctx.editor.setAutocompleteMaxVisible(typeof value === "number" ? value : Number(value));
				break;
			case "spelling.typoDetection":
			case "spelling.autocomplete":
			case "spelling.autocorrect":
				this.ctx.syncEditorSpelling();
				this.ctx.ui.requestRender();
				break;

			// Settings with UI side effects
			case "display.hideToolActivity": {
				const hidden = value as boolean;
				this.ctx.hideToolActivity = hidden;
				if (!hidden) this.ctx.toolOutputExpanded = false;
				for (const child of this.ctx.chatContainer.children) {
					if (!hidden && (child instanceof ToolExecutionComponent || child instanceof ReadToolGroupComponent)) {
						child.setExpanded(false);
					} else if (child instanceof AssistantMessageComponent) {
						child.setToolResultImagesVisible(!hidden);
					}
				}
				this.ctx.chatContainer.setToolActivityVisible(!hidden);
				if (hidden) this.ctx.ui.clearInlineImages();
				this.ctx.ui.requestRender(true);
				break;
			}
			case "terminal.showImages":
			case "showImages": {
				const visible = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof ToolExecutionComponent) {
						child.setShowImages(visible);
					} else if (child instanceof AssistantMessageComponent) {
						child.setImagesVisible(visible);
					}
				}
				if (!visible) this.ctx.ui.clearInlineImages();
				this.ctx.ui.requestRender(true);
				break;
			}
			case "hideThinkingBlock":
				this.ctx.hideThinkingBlock = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
					}
				}
				this.ctx.ui.requestRender(true);
				break;
			case "proseOnlyThinking":
				this.ctx.proseOnlyThinking = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setProseOnlyThinking(value as boolean);
					}
				}
				this.ctx.ui.requestRender(true);
				break;
			case "omitThinking":
				this.ctx.session.agent.hideThinkingSummary = value as boolean;
				break;
			case "display.cacheMissMarker":
				// Rebuild re-runs the usage-based detection under the new setting so
				// markers appear/disappear; full reset retires any already committed
				// to native scrollback (mirrors hideThinking).
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "display.collapseCompacted":
				// Rebuild swaps between the collapsed tail and the full inline
				// history; full reset retires blocks already committed to native
				// scrollback (mirrors cacheMissMarker).
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "display.showTokenUsage":
				// Rebuild reruns usage-row detection under the new setting; resetDisplay
				// retires rows already committed to native scrollback.
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "display.showTurnTime":
				// Same as showTokenUsage: the prompt→yield delta lives in the same
				// usage row, so toggling it must rebuild and retire committed rows.
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "tui.tight":
				setTuiTight(value as boolean);
				this.ctx.ui.invalidate();
				this.ctx.ui.requestRender();
				break;
			case "tui.hyperlinks":
				applyHyperlinkSetting();
				this.ctx.statusLine.invalidate();
				this.ctx.ui.invalidate();
				this.ctx.ui.requestRender();
				break;
			case "tui.resizeScrollback":
				this.ctx.ui.setResizeScrollback(value as ResizeScrollbackMode);
				break;

			case "tui.renderMermaid":
				setMarkdownMermaidRendering(value as boolean);
				this.ctx.session.refreshBaseSystemPrompt().catch(err => {
					this.ctx.showError(`Failed to apply Mermaid rendering setting: ${err}`);
				});
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;

			case "theme": {
				setTheme(value as string, true).then(result => {
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
					this.ctx.ui.invalidate();
					if (!result.success) {
						this.ctx.showError(`Failed to load theme "${value}": ${result.error}\nFell back to dark theme.`);
					}
				});
				break;
			}
			case "symbolPreset": {
				setSymbolPreset(value as "unicode" | "nerd" | "ascii").then(() => {
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
					this.ctx.ui.invalidate();
				});
				break;
			}
			case "colorBlindMode": {
				setColorBlindMode(value === "true" || value === true).then(() => {
					this.ctx.ui.invalidate();
				});
				break;
			}
			case "temperature": {
				const temp = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.temperature = temp >= 0 ? temp : undefined;
				break;
			}
			case "topP": {
				const topP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topP = topP >= 0 ? topP : undefined;
				break;
			}
			case "topK": {
				const topK = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topK = topK >= 0 ? topK : undefined;
				break;
			}
			case "minP": {
				const minP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.minP = minP >= 0 ? minP : undefined;
				break;
			}
			case "presencePenalty": {
				const presencePenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.presencePenalty = presencePenalty >= 0 ? presencePenalty : undefined;
				break;
			}
			case "repetitionPenalty": {
				const repetitionPenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.repetitionPenalty = repetitionPenalty >= 0 ? repetitionPenalty : undefined;
				break;
			}
			case "git.enabled":
			case "statusLinePreset":
			case "statusLine.preset":
			case "statusLineSeparator":
			case "statusLine.separator":
			case "statusLineShowHooks":
			case "statusLine.showHookStatus":
			case "statusLine.sessionAccent":
			case "statusLine.transparent":
			case "statusLine.compactThinkingLevel":
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
				const statusLineSettings = {
					preset: settings.get("statusLine.preset"),
					leftSegments: settings.get("statusLine.leftSegments"),
					rightSegments: settings.get("statusLine.rightSegments"),
					separator: settings.get("statusLine.separator"),
					showHookStatus: settings.get("statusLine.showHookStatus"),
					sessionAccent: settings.get("statusLine.sessionAccent"),
					transparent: settings.get("statusLine.transparent"),
					segmentOptions: settings.get("statusLine.segmentOptions"),
					compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
				};
				this.ctx.statusLine.updateSettings(statusLineSettings);
				this.ctx.ui.requestRender();
				break;
			}

			// Provider settings - update runtime preferences
			case "providers.webSearchOrder":
				if (Array.isArray(value)) {
					setSearchProviderOrder(value.filter(isSearchProviderId));
				}
				break;
			case "providers.webSearchExclude":
				if (Array.isArray(value)) {
					setExcludedSearchProviders(value.filter(isSearchProviderId));
				}
				break;
			case "providers.imageOrder":
				if (Array.isArray(value)) {
					setImageProviderOrder(value.filter((entry): entry is string => typeof entry === "string"));
				}
				break;

			// MCP update injection - live subscribe/unsubscribe
			case "mcp.notifications":
				this.ctx.mcpManager?.setNotificationsEnabled(value as boolean);
				break;

			// All other settings are handled by the definitions (get/set on SettingsManager)
			// No additional side effects needed
		}
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		if (options?.temporaryOnly) {
			this.#showModelPicker();
			return;
		}
		this.#showModelHub({});
	}

	/**
	 * Compact session-only model picker (alt+p / `/switch`): a floating
	 * bottom-anchored overlay over the transcript. The current model is
	 * highlighted and preselected; a leading `@` searches ctrl+p quick roles.
	 */
	#showModelPicker(): void {
		const currentContextTokens = this.ctx.session.getContextUsage()?.tokens ?? 0;
		const current = this.ctx.session.model;
		const quickRoleOrder = this.ctx.settings.get("cycleOrder");
		const quickRoleCycle = this.ctx.session.getRoleModelCycle(quickRoleOrder);
		const currentSelector = current ? `${current.provider}/${current.id}` : undefined;
		// Preselect the effective Task model in task mode: the configured override,
		// else the session model (the bundled task agent inherits it by default).
		const taskOverride = this.ctx.settings.get("task.agentModelOverrides").task;
		const taskSelector = (Array.isArray(taskOverride) ? taskOverride[0] : taskOverride) ?? currentSelector;
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const picker = new ModelPickerComponent(
			this.ctx.ui,
			this.ctx.settings,
			this.ctx.session.modelRegistry,
			this.ctx.session.scopedModels,
			{
				onPick: async (model, selector, { overContext }) => {
					// Session-only: update agent state but don't persist the model to settings.
					const applySessionModel = async () => {
						const roleThinkingLevel = this.ctx.session.resolveTemporaryModelThinkingLevel(model);
						await this.ctx.session.setModelTemporary(model, roleThinkingLevel);
						this.ctx.statusLine.invalidate();
						this.ctx.updateEditorBorderColor();
						const roleSelectorHint = this.ctx.keybindings.getKeys("app.model.select")[0] ?? "Alt+M";
						this.ctx.showStatus(`Session-only model: ${selector}. Use ${roleSelectorHint} or /model for roles.`);
					};
					try {
						if (overContext) {
							// Over-context pick: close the picker so the compaction loader is
							// visible, compact with the current model, then switch. The switch
							// runs in the before-flush hook so any prompt queued during
							// compaction executes on the target model, not the old one; the
							// early "nothing to compact" return skips the hook, so the
							// idempotent post-return call covers it. A cancelled or failed
							// compaction keeps the current model — the target still cannot
							// fit the transcript.
							done();
							let switched = false;
							const switchAfterCompaction = async (outcome: CompactionOutcome) => {
								if (switched || outcome !== "ok") return;
								switched = true;
								await applySessionModel();
							};
							const outcome = await this.ctx.handleCompactCommand(undefined, undefined, switchAfterCompaction);
							await switchAfterCompaction(outcome);
							return;
						}
						await applySessionModel();
						done();
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onPickRole: async entry => {
					try {
						await this.ctx.session.applyRoleModel(entry);
						this.ctx.statusLine.invalidate();
						this.ctx.updateEditorBorderColor();
						this.ctx.showModelCycleTrack(
							renderSegmentTrack(
								quickRoleOrder.map(role => ({ label: role })),
								quickRoleOrder.indexOf(entry.role),
							),
						);
						done();
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onPickTask: (_model, selector) => {
					// Session-only: layer the Task override onto the runtime settings
					// layer so it is never persisted, mirroring the session-model pick.
					this.ctx.settings.override("task.agentModelOverrides", {
						...this.ctx.settings.get("task.agentModelOverrides"),
						task: selector,
					});
					this.ctx.showStatus(`Task subagent model (session-only): ${selector}. Use /agents to persist.`);
					done();
				},
				onCancel: done,
			},
			{
				currentContextTokens,
				currentSelector,
				taskModeKeys: this.ctx.keybindings.getKeys("app.model.selectTemporary"),
				taskModeKeyLabel: this.ctx.keybindings.getDisplayString("app.model.selectTemporary") || "alt+p",
				taskSelector,
				quickRoles: quickRoleCycle?.models,
				quickRoleOrder,
				currentQuickRole: quickRoleCycle?.models[quickRoleCycle.currentIndex]?.role,
			},
		);
		const overlayHandle = this.ctx.ui.showOverlay(picker, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		this.ctx.ui.setFocus(picker);
		this.ctx.ui.requestRender();
	}

	/**
	 * Fullscreen model hub on the alternate screen (the /settings idiom): the
	 * overlay enables mouse tracking for its lifetime and the transcript stays
	 * untouched underneath. `initialProviderId` preselects a provider's sidebar
	 * entry — used when reopening the hub after a /login round-trip.
	 */
	#showModelHub(hubOptions: { initialProviderId?: string }): void {
		let closed = false;
		const done = () => {
			// Re-entrant guard: cancel paths (Esc, login forward) may race;
			// the overlay must hide exactly once.
			if (closed) return;
			closed = true;
			hub?.dispose();
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const hub = new ModelHubComponent(
			this.ctx.ui,
			this.ctx.settings,
			this.ctx.session.modelRegistry,
			this.ctx.session.scopedModels,
			{
				onAssign: async (model, role, thinkingLevel, selector, scope?: ModelRoleSelectionScope) => {
					const releaseDefaultMutation = role === "default" ? await this.#acquireDefaultRoleMutation() : undefined;
					const configuredStorage = this.ctx.settings.get("modelRoleStorage");
					const targetScope = configuredStorage === "project" ? (scope ?? "project") : "global";
					const selectorValue = selector ?? `${model.provider}/${model.id}`;
					const scopeLabel =
						configuredStorage === "project" ? `${targetScope === "project" ? "Project" : "Global"} ` : "";
					const defaultStatusLabel = configuredStorage === "project" ? `${scopeLabel}default` : "Default";
					try {
						if (role === "default") {
							// `auto` on the default role configures the active session. Other roles
							// persist an explicit `:auto` suffix and must not mutate the current model.
							const isAuto = thinkingLevel === AUTO_THINKING;
							const concreteThinking = isAuto || thinkingLevel === undefined ? undefined : thinkingLevel;
							const effectiveProvenance = this.ctx.settings.getModelRoleProvenance("default");
							const shadowedGlobal =
								configuredStorage === "project" &&
								targetScope === "global" &&
								(effectiveProvenance === "project" ||
									effectiveProvenance === "overlay" ||
									(effectiveProvenance === "runtime" &&
										this.ctx.settings.isProjectModelRoleRuntimeOverrideActive("default")));
							const shadowedProject =
								configuredStorage === "project" &&
								targetScope === "project" &&
								effectiveProvenance === "overlay";
							if (shadowedGlobal) {
								this.ctx.settings.setModelRole(
									"default",
									formatModelSelectorValue(selectorValue, concreteThinking),
								);
								if (isAuto) {
									this.ctx.settings.set("defaultThinkingLevel", AUTO_THINKING);
								}
							} else if (shadowedProject) {
								this.ctx.settings.setProjectModelRole(
									"default",
									formatModelSelectorValue(selectorValue, concreteThinking),
								);
								if (isAuto) {
									this.ctx.settings.set("defaultThinkingLevel", AUTO_THINKING);
								}
							} else {
								const { switched } = await this.ctx.session.setModel(model, role, {
									selector,
									thinkingLevel: isAuto ? ThinkingLevel.Inherit : concreteThinking,
									persist: targetScope === "global",
								});
								if (!switched) return;
								if (targetScope === "project") {
									this.ctx.settings.setProjectModelRole(
										"default",
										formatModelSelectorValue(selectorValue, concreteThinking),
									);
								}
								if (isAuto) {
									this.ctx.session.setThinkingLevel(AUTO_THINKING, true);
								} else if (concreteThinking && concreteThinking !== ThinkingLevel.Inherit) {
									this.ctx.session.setThinkingLevel(concreteThinking);
								}
								this.ctx.statusLine.invalidate();
								this.ctx.updateEditorBorderColor();
							}
							this.ctx.showStatus(`${defaultStatusLabel} model: ${selector ?? model.id}`);
						} else {
							// Other roles (smol, slow, custom): update settings, not the current model.
							const modelRoleValue = formatModelSelectorValue(selectorValue, thinkingLevel);
							if (targetScope === "project") {
								this.ctx.settings.setProjectModelRole(role, modelRoleValue);
							} else {
								this.ctx.settings.setModelRole(role, modelRoleValue);
							}
							const roleInfo = getRoleInfo(role, settings);
							this.ctx.showStatus(
								`${scopeLabel}${roleInfo?.tag ?? roleInfo?.name ?? role} model: ${selector ?? model.id}`,
							);
						}
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						releaseDefaultMutation?.();
						hub?.refreshAfterExternalMutation();
					}
				},
				onUnassign: async (role, scope?: ModelRoleSelectionScope) => {
					const releaseDefaultMutation = role === "default" ? await this.#acquireDefaultRoleMutation() : undefined;
					const configuredStorage = this.ctx.settings.get("modelRoleStorage");
					const targetScope = configuredStorage === "project" ? (scope ?? "project") : "global";
					const scopeLabel =
						configuredStorage === "project" ? `${targetScope === "project" ? "Project" : "Global"} ` : "";
					try {
						const previousEffectiveRoleValue =
							role === "default" ? this.ctx.settings.getModelRole("default") : undefined;
						if (targetScope === "project") {
							this.ctx.settings.clearProjectModelRole(role);
						} else {
							this.ctx.settings.setModelRole(role, undefined);
						}
						const roleInfo = getRoleInfo(role, settings);
						this.ctx.showStatus(
							`${scopeLabel}${roleInfo?.tag ?? roleInfo?.name ?? role} role cleared — auto-selection applies`,
						);
						// Clearing either persisted scope can also remove a captured
						// runtime override. When that changes the effective default,
						// resolve the newly exposed persisted layer and switch the live
						// session without writing it back to global settings. Overlay
						// and runtime provenance remain authoritative and session-neutral.
						if (role === "default") {
							const fallbackRoleValue = this.ctx.settings.getModelRole("default");
							const fallbackProvenance = this.ctx.settings.getModelRoleProvenance("default");
							const exposesPersistedFallback =
								fallbackProvenance === "project" || fallbackProvenance === "global";
							if (
								fallbackRoleValue &&
								fallbackRoleValue !== previousEffectiveRoleValue &&
								exposesPersistedFallback
							) {
								const scopedModels = this.ctx.session.scopedModels.map(sm => sm.model);
								const availableModels =
									scopedModels.length > 0 ? scopedModels : this.ctx.session.getAvailableModels();
								const resolved = resolveModelRoleValue(fallbackRoleValue, availableModels, {
									settings: this.ctx.settings,
								});
								if (resolved.model) {
									const fallbackModel = resolved.model;
									const isAuto = resolved.thinkingLevel === AUTO_THINKING;
									let concreteThinking = concreteThinkingLevel(resolved.thinkingLevel);
									let isAutoFromDefault = false;
									if (!resolved.explicitThinkingLevel && !concreteThinking) {
										const defaultLevel = parseConfiguredThinkingLevel(
											this.ctx.settings.get("defaultThinkingLevel"),
										);
										if (defaultLevel === AUTO_THINKING) {
											isAutoFromDefault = true;
										} else if (defaultLevel) {
											concreteThinking = defaultLevel;
										}
									}
									const effectiveIsAuto = isAuto || isAutoFromDefault;
									const { switched } = await this.ctx.session.setModel(fallbackModel, "default", {
										persist: false,
										thinkingLevel: effectiveIsAuto
											? ThinkingLevel.Inherit
											: (concreteThinking ?? ThinkingLevel.Inherit),
									});
									if (!switched) return;
									if (effectiveIsAuto) {
										this.ctx.session.setThinkingLevel(AUTO_THINKING, true);
									} else if (concreteThinking && concreteThinking !== ThinkingLevel.Inherit) {
										this.ctx.session.setThinkingLevel(concreteThinking);
									}
									this.ctx.statusLine.invalidate();
									this.ctx.updateEditorBorderColor();
								}
							}
						}
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						releaseDefaultMutation?.();
						hub?.refreshAfterExternalMutation();
					}
				},
				onFallbackChainChange: (role, chain) => {
					try {
						const chains = { ...this.ctx.settings.get("retry.fallbackChains") };
						if (chain.length === 0) {
							delete chains[role];
						} else {
							chains[role] = chain;
						}
						this.ctx.settings.set("retry.fallbackChains", chains);
						const roleInfo = getRoleInfo(role, settings);
						this.ctx.showStatus(
							chain.length > 0
								? `${roleInfo?.tag ?? roleInfo?.name ?? role} fallbacks: ${chain.join(" → ")}`
								: `${roleInfo?.tag ?? roleInfo?.name ?? role} fallbacks cleared`,
						);
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},

				onLoginRequest: providerId => {
					done();
					void this.#loginThenReopenModelHub(providerId);
				},
				onCycleOrderChange: order => {
					try {
						this.ctx.settings.set("cycleOrder", order);
						this.ctx.showStatus(
							order.length > 0 ? `Quick-switch cycle: ${order.join(" → ")}` : "Quick-switch cycle cleared",
						);
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onCancel: () => done(),
			},
			{
				initialProviderId: hubOptions.initialProviderId,
			},
		);
		const overlayHandle = this.#showFullscreenMenu(hub);
	}

	/** /login round-trip for a locked provider; reopen the hub on that provider only after a successful login. */
	async #loginThenReopenModelHub(providerId: string): Promise<void> {
		const succeeded = await this.#handleOAuthLogin(providerId);
		if (succeeded) {
			this.#showModelHub({ initialProviderId: providerId });
		}
	}

	async showPluginSelector(mode: "install" | "uninstall" = "install"): Promise<void> {
		const mgr = new MarketplaceManager({
			marketplacesRegistryPath: getMarketplacesRegistryPath(),
			installedRegistryPath: getInstalledPluginsRegistryPath(),
			projectInstalledRegistryPath: (await resolveActiveProjectRegistryPath(getProjectDir())) ?? undefined,
			marketplacesCacheDir: getMarketplacesCacheDir(),
			pluginsCacheDir: getPluginsCacheDir(),
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});

		const [marketplaces, installed] = await Promise.all([mgr.listMarketplaces(), mgr.listInstalledPlugins()]);
		const installedIds = new Set(installed.map(p => p.id));

		if (mode === "uninstall") {
			// Show only installed plugins for uninstall
			const items = installed.map(p => {
				const entry = p.entries[0];
				const atIdx = p.id.lastIndexOf("@");
				const pluginName = atIdx > 0 ? p.id.slice(0, atIdx) : p.id;
				const mkt = atIdx > 0 ? p.id.slice(atIdx + 1) : "unknown";
				return {
					plugin: { name: pluginName, version: entry?.version, description: undefined as string | undefined },
					marketplace: mkt,
					scope: p.scope,
				};
			});
			this.showSelector(done => {
				const selector = new PluginSelectorComponent(marketplaces.length, items, new Set(), {
					onSelect: async (name, marketplace, scope) => {
						done();
						const pluginId = `${name}@${marketplace}`;
						this.ctx.showStatus(`Uninstalling ${pluginId}...`);
						this.ctx.ui.requestRender();
						try {
							await mgr.uninstallPlugin(pluginId, scope);
							this.ctx.showStatus(`Uninstalled ${pluginId}`);
						} catch (err) {
							this.ctx.showStatus(`Uninstall failed: ${err}`);
						}
						this.ctx.ui.requestRender();
					},
					onCancel: () => {
						done();
						this.ctx.ui.requestRender();
					},
				});
				return { component: selector, focus: selector.getSelectList() };
			});
			return;
		}

		// Install mode: show all available plugins from all marketplaces
		const allPlugins: Array<{
			plugin: { name: string; version?: string; description?: string };
			marketplace: string;
		}> = [];
		for (const mkt of marketplaces) {
			const plugins = await mgr.listAvailablePlugins(mkt.name);
			for (const plugin of plugins) {
				allPlugins.push({ plugin, marketplace: mkt.name });
			}
		}

		this.showSelector(done => {
			const selector = new PluginSelectorComponent(marketplaces.length, allPlugins, installedIds, {
				onSelect: async (name, marketplace) => {
					done();
					this.ctx.showStatus(`Installing ${name} from ${marketplace}...`);
					this.ctx.ui.requestRender();
					try {
						const force = installedIds.has(`${name}@${marketplace}`);
						await mgr.installPlugin(name, marketplace, { force });
						this.ctx.showStatus(`Installed ${name} from ${marketplace}`);
					} catch (err) {
						this.ctx.showStatus(`Install failed: ${err}`);
					}
					this.ctx.ui.requestRender();
				},
				onCancel: () => {
					done();
					this.ctx.ui.requestRender();
				},
			});
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	showUserMessageSelector(): void {
		const entries = this.ctx.sessionManager
			.getBranch()
			.filter((entry): entry is SessionMessageEntry => entry.type === "message");
		if (entries.length === 0) {
			this.ctx.showStatus("No messages to branch from");
			return;
		}

		const done = () => {
			overlayHandle?.hide();
			selector?.dispose();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const selector = new RewindSelectorComponent(entries, {
			ui: this.ctx.ui,
			getTool: name => this.ctx.session.getToolByName(name),
			isBuiltInTool: name => this.ctx.session.hasBuiltInTool(name),
			getMessageRenderer: type => this.ctx.session.extensionRunner?.getMessageRenderer(type),
			cwd: this.ctx.sessionManager.getCwd(),
			hideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			proseOnlyThinking: () => this.ctx.proseOnlyThinking,
			requestRender: () => this.ctx.ui.requestRender(),
			siblingPaths: entryId => this.#siblingBranchPaths(entryId),
			onSelect: entryId => void this.#rewindFromTranscript(entryId, done),
			onCancel: done,
		});
		if (selector.targetCount === 0) {
			selector.dispose();
			this.ctx.showStatus("No messages to branch from");
			return;
		}
		// Fullscreen alternate-screen overlay: the transcript replica draws over
		// the live one, and the normal screen stays untouched until the rewind
		// itself rewrites it.
		const overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	/**
	 * Alternate branches of `entryId`'s turn for the rewind selector's strip:
	 * every other child of its parent, each unrolled along its most-recent
	 * descendants (children are timestamp-ordered, so the last child chain is
	 * the branch's latest continuation) and filtered to message entries.
	 */
	#siblingBranchPaths(entryId: string): BranchVariantPath[] {
		const entry = this.ctx.sessionManager.getEntry(entryId);
		if (!entry) return [];
		const forest = this.ctx.sessionManager.getTree();
		const byId = new Map<string, SessionTreeNode>();
		const stack = [...forest];
		while (stack.length > 0) {
			const node = stack.pop()!;
			byId.set(node.entry.id, node);
			stack.push(...node.children);
		}
		const siblings =
			entry.parentId === null
				? forest.filter(node => node.entry.id !== entryId)
				: (byId.get(entry.parentId)?.children ?? []).filter(node => node.entry.id !== entryId);
		const paths: BranchVariantPath[] = [];
		for (const sibling of siblings) {
			const entries: SessionMessageEntry[] = [];
			let node: SessionTreeNode | undefined = sibling;
			while (node) {
				if (node.entry.type === "message") entries.push(node.entry);
				node = node.children.at(-1);
			}
			if (entries.length > 0) paths.push({ rootId: sibling.entry.id, entries });
		}
		return paths;
	}

	/**
	 * Complete an esc-esc rewind in place via `navigateTree`: the session tree
	 * keeps the old path as a sibling branch instead of forking a child
	 * session. A user-message target rewinds PAST itself (leaf moves to its
	 * parent) and its text replaces the editor draft, so it is a real move
	 * even when it is the current leaf; every other target lands the leaf on
	 * the entry. `done` closes the fullscreen selector after the transcript is
	 * rebuilt so the alternate screen never flashes a stale transcript.
	 */
	async #rewindFromTranscript(entryId: string, done: () => void): Promise<void> {
		const entry = this.ctx.sessionManager.getEntry(entryId);
		if (entry?.type !== "message") {
			done();
			return;
		}

		const isUserTarget = entry.message.role === "user";
		const realLeafId = this.ctx.sessionManager.getLeafId();
		if (entryId === realLeafId && !isUserTarget) {
			done();
			this.ctx.showStatus("Already at this point");
			return;
		}
		const treeRewind = this.#treeRewindBoundary(entryId, realLeafId);
		try {
			const result = await this.ctx.session.navigateTree(entryId, { summarize: false });
			if (result.cancelled) {
				done();
				this.ctx.showStatus("Navigation cancelled");
				return;
			}
			const fastRewind =
				treeRewind !== undefined &&
				this.ctx.sessionManager.getLeafId() === treeRewind.expectedLeafId &&
				this.ctx.truncateTranscriptFromMessage(treeRewind.message);
			if (!fastRewind) {
				await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
			}
			await this.ctx.reloadTodos();
			if (result.editorText && (isUserTarget || !this.ctx.editor.getText().trim())) {
				this.ctx.editor.setDraft(result.editorText, result.editorImages);
			}
			done();
			this.ctx.showStatus("Rewound to selected point");
		} catch (error) {
			done();
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	showCopySelector(): void {
		const entries = this.ctx.sessionManager
			.getBranch()
			.filter((entry): entry is SessionMessageEntry => entry.type === "message");
		if (entries.length === 0) {
			this.ctx.showStatus("Nothing to copy yet.");
			return;
		}

		const done = () => {
			overlayHandle?.hide();
			selector?.dispose();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const selector = new CopySelectorComponent(entries, {
			ui: this.ctx.ui,
			getTool: name => this.ctx.session.getToolByName(name),
			isBuiltInTool: name => this.ctx.session.hasBuiltInTool(name),
			getMessageRenderer: type => this.ctx.session.extensionRunner?.getMessageRenderer(type),
			cwd: this.ctx.sessionManager.getCwd(),
			hideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			proseOnlyThinking: () => this.ctx.proseOnlyThinking,
			requestRender: () => this.ctx.ui.requestRender(),
			onPick: (content, label) => {
				done();
				if (!content.trim()) {
					this.ctx.showStatus("Nothing to copy in that item");
					return;
				}
				void copyToClipboard(content);
				this.ctx.showStatus(`Copied ${label} to clipboard`);
			},
			onCancel: done,
		});
		if (selector.targetCount === 0) {
			selector.dispose();
			this.ctx.showStatus("Nothing to copy yet.");
			return;
		}
		const overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	showTreeSelector(): void {
		const tree = this.ctx.sessionManager.getTree();
		const realLeafId = this.ctx.sessionManager.getLeafId();

		if (tree.length === 0) {
			this.ctx.showStatus("No entries in session");
			return;
		}

		this.showSelector(done => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ctx.ui.terminal.rows,
				async (entryId, options) => {
					// Selecting the current leaf is normally a no-op (already there) —
					// unless it's an `ask` toolResult, in which case the re-answer flow
					// must still be allowed to reopen the picker even though the leaf
					// doesn't move (chatgpt-codex review on #5895).
					if (entryId === realLeafId) {
						const currentEntry = this.ctx.sessionManager.getEntry(entryId);
						const currentIsAskResult =
							currentEntry?.type === "message" &&
							currentEntry.message.role === "toolResult" &&
							currentEntry.message.toolName === "ask";
						if (!currentIsAskResult) {
							done();
							this.ctx.showStatus("Already at this point");
							return;
						}
					}

					// Ask about summarization
					done(); // Close selector first

					// Pure-rewind probe (before navigation mutates the leaf): when the
					// target sits on the current leaf's path and no summary is added,
					// the post-navigation transcript is a strict prefix of the rendered
					// one and the tail can be dropped in place.
					const treeRewind = this.#treeRewindBoundary(entryId, realLeafId);

					// Loop until user makes a complete choice or cancels to tree.
					// Shift+Enter in the tree selector pre-answers "Summarize" and
					// skips the prompt entirely.
					let wantsSummary = options.summarize;
					let customInstructions: string | undefined;

					const branchSummariesEnabled = settings.get("branchSummary.enabled");

					while (!wantsSummary && branchSummariesEnabled) {
						const summaryChoice = await this.ctx.showHookSelector("Summarize branch?", [
							"No summary",
							"Summarize",
							"Summarize with custom prompt",
						]);

						if (summaryChoice === undefined) {
							// User pressed escape - re-show tree selector
							this.showTreeSelector();
							return;
						}

						wantsSummary = summaryChoice !== "No summary";

						if (summaryChoice === "Summarize with custom prompt") {
							customInstructions = await this.ctx.showHookEditor("Custom summarization instructions");
							if (customInstructions === undefined) {
								// User cancelled - loop back to summary selector
								continue;
							}
						}

						// User made a complete choice
						break;
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.ctx.editor.onEscape;

					if (wantsSummary) {
						this.ctx.editor.onEscape = () => {
							this.ctx.session.abortBranchSummary();
						};
						this.ctx.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ctx.ui,
							spinner => theme.fg("accent", spinner),
							text => theme.fg("muted", text),
							"Summarizing branch... (esc to cancel)",
							getSymbolTheme().spinnerFrames,
						);
						this.ctx.statusContainer.addChild(summaryLoader);
						this.ctx.ui.requestRender();
					}

					try {
						let result = await this.ctx.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
							allowAskReopen: true,
						});

						// Selecting an `ask` toolResult doesn't land the leaf directly —
						// re-open the picker with the original questions first, then
						// complete the navigation as a new sibling branch (issue #5642).
						if (result.reopenAsk) {
							const reanswer = await this.#reanswerAsk(result.reopenAsk.questions);
							if (!reanswer) {
								this.ctx.showStatus("Re-answer cancelled");
								return;
							}
							result = await this.ctx.session.navigateTree(entryId, {
								summarize: wantsSummary,
								customInstructions,
								allowAskReopen: true,
								reanswerAskResult: reanswer,
							});
						}

						if (result.aborted) {
							// Summarization aborted - re-show tree selector
							this.ctx.showStatus("Branch summarization cancelled");
							this.showTreeSelector();
							return;
						}
						if (result.cancelled) {
							this.ctx.showStatus("Navigation cancelled");
							return;
						}

						// Update UI — rebuild the display transcript for the new leaf (the
						// context from navigateTree is the LLM context, not the transcript).
						const fastRewind =
							treeRewind !== undefined &&
							!wantsSummary &&
							!result.summaryEntry &&
							!result.askReanswerCommitted &&
							this.ctx.sessionManager.getLeafId() === treeRewind.expectedLeafId &&
							this.ctx.truncateTranscriptFromMessage(treeRewind.message);
						if (!fastRewind) {
							await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
						}
						await this.ctx.reloadTodos();
						if (result.editorText && !this.ctx.editor.getText().trim()) {
							this.ctx.editor.setDraft(result.editorText, result.editorImages);
						}
						this.ctx.showStatus("Navigated to selected point");

						// Re-answering a past `ask` commits a new sibling answer but,
						// unlike a live `ask`, leaves the agent idle. Resume it now —
						// after the transcript rebuild above — so the model consumes the
						// new answer without the resumed turn rendering against the stale
						// pre-rebuild UI (issue #6483).
						if (result.askReanswerCommitted) {
							this.ctx.session.resumeAfterAskReanswer();
						}
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.ctx.statusContainer.disposeChildren();
						}
						this.ctx.editor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				(entryId, label) => {
					this.ctx.sessionManager.appendLabelChange(entryId, label);
					this.ctx.ui.requestRender();
				},
				settings.get("treeFilterMode"),
			);
			return { component: selector, focus: selector };
		});
	}

	/**
	 * First rendered message a pure tree rewind drops, plus the leaf id the
	 * navigation is expected to land on. `targetId` must sit on the current
	 * leaf's path; a user-message target rewinds PAST itself (navigateTree
	 * moves the leaf to its parent and hands the text back as an editor
	 * draft), every other target keeps the target as the new leaf. Returns
	 * undefined when the navigation is not a pure rewind or the boundary entry
	 * cannot anchor an in-place truncation (non-message boundary; custom
	 * messages render unkeyed components).
	 */
	#treeRewindBoundary(
		targetId: string,
		leafId: string | null,
	): { message: AgentMessage; expectedLeafId: string } | undefined {
		if (!leafId) return undefined;
		const target = this.ctx.sessionManager.getEntry(targetId);
		if (!target) return undefined;
		const rewindsPastTarget = target.type === "message" && target.message.role === "user";
		if (!rewindsPastTarget && target.type === "custom_message") return undefined;
		// Walk leaf → root: proves the target is on the current path and finds
		// the first entry the rewind drops.
		let firstDropped: SessionEntry | undefined;
		let cursor = this.ctx.sessionManager.getEntry(leafId);
		while (cursor && cursor.id !== targetId) {
			firstDropped = cursor;
			cursor = cursor.parentId ? this.ctx.sessionManager.getEntry(cursor.parentId) : undefined;
		}
		if (!cursor) return undefined;
		const boundary = rewindsPastTarget ? target : firstDropped;
		if (boundary?.type !== "message") return undefined;
		// A root rewind (expected leaf null) empties the transcript but may leave
		// components rendered before the first message stale — take the
		// destructive replay instead.
		const expectedLeafId = rewindsPastTarget ? target.parentId : targetId;
		if (expectedLeafId === null) return undefined;
		return {
			message: boundary.message,
			expectedLeafId,
		};
	}

	/**
	 * Re-open the `ask` picker with the original `questions` (issue #5642):
	 * runs a standalone `AskTool.execute()` outside a normal agent turn,
	 * reusing the same picker/dialog primitives a live `ask` tool call gets.
	 * Returns `undefined` when the user cancels — mirrors `navigateTree`'s
	 * cancellation contract instead of throwing.
	 */
	async #reanswerAsk(questions: AskToolInput["questions"]): Promise<AgentToolResult<AskToolDetails> | undefined> {
		const uiContext = this.ctx.getToolUIContext();
		if (!uiContext) {
			this.ctx.showError("Ask tool UI is not ready");
			return undefined;
		}
		const toolSession: ToolSession = {
			cwd: this.ctx.sessionManager.getCwd(),
			hasUI: true,
			settings: this.ctx.settings,
			getSessionFile: () => this.ctx.sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => null,
			getPlanModeState: () => this.ctx.session.getPlanModeState(),
		};
		const askTool = new AskTool(toolSession);
		const context = this.ctx.session.buildAskReanswerContext(uiContext);
		let result: AgentToolResult<AskToolDetails>;
		try {
			result = await askTool.execute("tree-reanswer", { questions }, undefined, undefined, context);
		} catch (error) {
			if (error instanceof ToolAbortError) return undefined;
			throw error;
		}
		// The rich ask dialog can race a collab guest choosing "Chat about this"
		// (`AskTool`'s `chatRedirect` result); that's meaningful inside a live
		// agent turn, where the model sees the redirect and starts a
		// conversation, but this standalone re-answer has no turn to hand it
		// to — completing the navigation with it would silently drop the
		// user's intent to chat (roboomp review on #5895).
		if (result.details?.chatRedirect) {
			this.ctx.showError(
				"Chat about this isn't available when re-answering from the tree — pick an option or type a custom answer instead.",
			);
			return undefined;
		}
		return result;
	}

	async showSessionSelector(source?: ForeignSessionSource): Promise<void> {
		let sessions: SessionInfo[];
		let onSelectSession: (session: SessionInfo) => Promise<boolean>;
		let selectorOptions: SessionSelectorOptions;

		if (source) {
			const sourceName = foreignSessionSourceName(source);
			const store = createForeignSessionStore(source);
			let foreignSessions: ForeignSessionInfo[];
			try {
				foreignSessions = await store.list();
			} catch (error) {
				this.ctx.showError(
					`Failed to list ${sourceName} sessions: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
			if (foreignSessions.length === 0) {
				this.ctx.showWarning(`No ${sourceName} sessions found`);
				return;
			}
			const foreignByPath = new Map(foreignSessions.map(session => [session.path, session]));
			sessions = foreignSessions.map(foreignSessionInfoToSessionInfo);
			onSelectSession = async session => {
				try {
					await this.ctx.settings.flush();
				} catch (error) {
					this.ctx.showError(
						`Failed to save pending settings: ${error instanceof Error ? error.message : String(error)}`,
					);
					return false;
				}
				const foreignSession = foreignByPath.get(session.path);
				if (!foreignSession) throw new Error(`Selected ${sourceName} session is no longer available`);
				const imported = await persistForeignSession(store, foreignSession, {
					fallbackCwd: this.ctx.sessionManager.getCwd(),
					suppressBreadcrumb: true,
				});
				const sessionFile = imported.getSessionFile();
				if (!sessionFile) throw new Error(`Failed to persist ${sourceName} session`);
				await imported.close();
				return await this.handleResumeSession(sessionFile, { settingsFlushed: true });
			};
			selectorOptions = {
				title: `Import ${sourceName} Session`,
				scopeLabel: false,
				showCwd: true,
			};
		} else {
			const [loadedSessions, pinnedIds] = await Promise.all([
				SessionManager.list(this.ctx.sessionManager.getCwd(), this.ctx.sessionManager.getSessionDir()),
				loadPinnedSessionIds(),
			]);
			sessions = loadedSessions;
			const historyStorage = this.ctx.historyStorage;
			const historyMatcher = historyStorage
				? (query: string) => historyStorage.matchingSessionIds(query)
				: undefined;
			onSelectSession = session => this.handleResumeSession(session.path);
			selectorOptions = {
				onDelete: async (session: SessionInfo) => {
					if (!(await this.#detachActiveSessionBeforeDeletion(session.path))) {
						return false;
					}
					const storage = new FileSessionStorage();
					try {
						await storage.deleteSessionWithArtifacts(session.path);
						return true;
					} catch (error) {
						throw new Error(
							`Failed to delete session: ${error instanceof Error ? error.message : String(error)}`,
							{ cause: error },
						);
					}
				},
				historyMatcher,
				loadAllSessions: () => SessionManager.listAll(),
				pinnedIds,
			};
		}

		// Keep the fullscreen picker on the alternate buffer while a selected
		// session is loaded and its transcript is rebuilt.
		const done = () => {
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const selector = new SessionSelectorComponent(
			sessions,
			async (session: SessionInfo) => {
				selector.lockInput();
				let keepOpen = false;
				try {
					const success = await onSelectSession(session);
					if (!success) {
						keepOpen = true;
						selector.unlockInput();
						this.ctx.ui.requestRender();
					}
				} catch (error) {
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				} finally {
					if (!keepOpen) done();
				}
			},
			done,
			() => {
				// Release the alt buffer before teardown: shutdown() awaits flush/save/
				// dispose/drain before stop() leaves the alt screen.
				done();
				void this.ctx.shutdown();
			},
			{
				...selectorOptions,
				getTerminalRows: () => this.ctx.ui.terminal.rows,
				fillHeight: true,
			},
		);
		selector.setOnRequestRender(() => this.ctx.ui.requestRender());
		const overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	#refreshSessionTerminalTitle(): void {
		const sessionManager = this.ctx.sessionManager as {
			getSessionName?: () => string | undefined;
			getCwd: () => string;
			titleSource?: "auto" | "user" | undefined;
		};
		setSessionTerminalTitle(sessionManager.getSessionName?.(), sessionManager.getCwd());
	}

	async #detachActiveSessionBeforeDeletion(sessionPath: string): Promise<boolean> {
		const currentSessionFile = this.ctx.sessionManager.getSessionFile();
		if (currentSessionFile !== sessionPath) {
			return true;
		}

		const detached = await this.ctx.session.newSession();
		if (!detached) {
			return false;
		}
		this.#refreshSessionTerminalTitle();

		this.ctx.clearTransientSessionUi();
		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.ui.requestRender();
		this.ctx.updateEditorBorderColor();
		await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
		return true;
	}

	async handleResumeSession(sessionPath: string, options?: { settingsFlushed?: boolean }): Promise<boolean> {
		const previousCwd = this.ctx.sessionManager.getCwd();
		// Flush pending settings writes before switching sessions so a save
		// failure leaves the session, process project dir, and Settings in the
		// source scope.
		if (!options?.settingsFlushed) {
			try {
				await this.ctx.settings.flush();
			} catch (err) {
				this.ctx.showError(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
				return false;
			}
		}
		// AgentSession owns the transaction. It restores the complete source state
		// if applying the target project's cwd fails, including in-memory sessions.
		if (
			(await this.ctx.session.switchSession(sessionPath, {
				onCwdChange: async (newCwd, sourceCwd) => {
					if (normalizePathForComparison(newCwd) === normalizePathForComparison(sourceCwd)) return true;
					return this.ctx.applyCwdChange(newCwd);
				},
			})) === false
		) {
			return false;
		}
		this.ctx.clearTransientSessionUi();
		const newCwd = this.ctx.sessionManager.getCwd();
		const movedProject = normalizePathForComparison(newCwd) !== normalizePathForComparison(previousCwd);
		this.#refreshSessionTerminalTitle();
		this.ctx.updateEditorBorderColor();

		// Clear and re-render the chat
		await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		this.ctx.showStatus(movedProject ? `Resumed session in ${shortenPath(newCwd)}` : "Resumed session");
		return true;
	}

	async handleSessionDeleteCommand(): Promise<void> {
		const sessionFile = this.ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			this.ctx.showError("No session file to delete (in-memory session)");
			return;
		}

		// Check if session file exists (may not exist for brand new sessions)
		const storage = new FileSessionStorage();
		const fileExists = await storage.exists(sessionFile);
		if (!fileExists) {
			this.ctx.showError("Session has not been saved yet");
			return;
		}

		const confirmed = await this.ctx.showHookConfirm(
			"Delete Session",
			"This will permanently delete the current session.\nYou will be returned to the session selector.",
		);

		if (!confirmed) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		if (!(await this.#detachActiveSessionBeforeDeletion(sessionFile))) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		// Delete the session file and artifacts directory
		await storage.deleteSessionWithArtifacts(sessionFile);

		// Show session selector
		this.ctx.showStatus("Session deleted");
		await this.showSessionSelector();
	}

	/**
	 * Run the OAuth login flow for `providerId` inside a cancellable
	 * {@link LoginDialogComponent} that replaces the editor slot. Esc aborts:
	 * the dialog's abort signal reaches the provider flow, any pending prompt
	 * rejects, and the editor is restored immediately. Returns true when
	 * credentials were stored.
	 */
	async #handleOAuthLogin(providerId: string): Promise<boolean> {
		this.ctx.showStatus(`Logging in to ${providerId}…`);
		const useManualInput = PASTE_CODE_LOGIN_PROVIDERS.has(providerId);
		let restored = false;
		const restoreEditor = () => {
			if (restored) return;
			restored = true;
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
		};
		const dialog = new LoginDialogComponent(this.ctx.ui, providerId, (_success, message) => {
			// Fires on Esc: unblock the editor immediately; the aborted flow's
			// rejection settles the awaited login below.
			restoreEditor();
			if (message) this.ctx.showStatus(message);
		});
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(dialog);
		this.ctx.ui.setFocus(dialog);
		this.ctx.ui.requestRender();
		try {
			const identity = await this.ctx.session.modelRegistry.authStorage.login(providerId as OAuthProvider, {
				signal: dialog.signal,
				onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
					// The dialog renders the full URL (SSH-safe copy target) and
					// opens the browser best-effort.
					dialog.showAuth(info.url, info.instructions, info.launchUrl);
				},
				onPrompt: (prompt: { message: string; placeholder?: string }) =>
					dialog.showPrompt(prompt.message, prompt.placeholder),
				onProgress: (message: string) => {
					dialog.showProgress(message);
				},
				// Paste-code providers (e.g. Codex) may need the user to paste the
				// fallback redirect URL when the loopback callback can't complete
				// (headless/remote/Windows). Mount a focused input in the dialog so
				// the paste lands somewhere the OAuth flow consumes — the hidden
				// editor's `/login <url>` path is unreachable while the dialog holds
				// focus (#5339).
				onManualCodeInput: useManualInput ? () => dialog.showManualInput(MANUAL_LOGIN_PROMPT) : undefined,
			});
			// Scope the post-login refresh to the just-authenticated provider with an
			// `online` strategy: the default all-provider `online-if-uncached` reuses
			// a fresh authoritative cache row (e.g. an empty result fetched before
			// login), so newly persisted credentials would never re-run discovery and
			// models would stay unavailable in-session (#5780). Unrelated providers
			// are left untouched. `refreshProvider` swallows discovery failures, so
			// awaiting cannot reject the login.
			await this.ctx.session.modelRegistry.refreshProvider(providerId, "online");
			const block = new TranscriptBlock();
			// Name the account (and Anthropic organization) that was stored so a
			// login that lands on an unintended account/subscription is visible
			// immediately instead of silently replacing an existing registration.
			const whoBase = identity?.type === "oauth" ? (identity.email ?? identity.accountId) : undefined;
			const whoOrg = identity?.type === "oauth" ? (identity.orgName ?? identity.orgId) : undefined;
			const who = whoBase ? ` as ${whoBase}${whoOrg ? ` (${whoOrg})` : ""}` : whoOrg ? ` as ${whoOrg}` : "";
			block.addChild(
				new Text(
					theme.fg("success", `${theme.status.success} Successfully logged in to ${providerId}${who}`),
					1,
					0,
				),
			);
			block.addChild(new Text(theme.fg("dim", `Credentials saved to ${getAgentDbPath()}`), 1, 0));
			this.ctx.present(block);
			return true;
		} catch (error: unknown) {
			if (dialog.signal.aborted) {
				// User-cancelled: the dialog already restored the editor and
				// surfaced "Login cancelled".
				return false;
			}
			this.ctx.showError(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		} finally {
			restoreEditor();
		}
	}

	async #handleCredentialLogout(providerId: string, account: LogoutAccount): Promise<void> {
		try {
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			const removed = await authStorage.removeCredential(providerId, account.credentialId);
			if (!removed) {
				this.ctx.showError(`Logout skipped: ${account.label} is no longer stored for ${providerId}.`);
				return;
			}

			// Provider-scoped online refresh so the removed credential's stale
			// endpoint/deployment models are invalidated deterministically; the
			// default all-provider `online-if-uncached` would reuse the fresh
			// authoritative cache row and keep showing models the credential
			// unlocked (#5780). Other providers are left untouched.
			await this.ctx.session.modelRegistry.refreshProvider(providerId, "online");
			const block = new TranscriptBlock();
			block.addChild(
				new Text(
					theme.fg(
						"success",
						`${theme.status.success} Successfully logged out ${account.label} from ${providerId}`,
					),
					1,
					0,
				),
			);
			block.addChild(new Text(theme.fg("dim", `Credential removed from ${getAgentDbPath()}`), 1, 0));
			const remainingSource = authStorage.describeCredentialSource(providerId, this.ctx.session.sessionId);
			if (remainingSource) {
				block.addChild(
					new Text(theme.fg("warning", `${providerId} is still authenticated via ${remainingSource}`), 1, 0),
				);
			}
			this.ctx.present(block);
		} catch (error: unknown) {
			this.ctx.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #showOAuthLogoutAccountSelector(providerId: string): Promise<void> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		try {
			await authStorage.reload();
		} catch (error: unknown) {
			this.ctx.showError(
				`Could not load stored credentials: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const provider = getOAuthProviders().find(candidate => candidate.id === providerId);
		const accounts = toLogoutAccounts(providerId, authStorage.listStoredCredentials(providerId), {
			activeIdentity: authStorage.getOAuthAccountIdentity(providerId, this.ctx.session.sessionId),
			activeApiKey: authStorage.getCredentialOrigin(providerId)?.kind === "api_key",
		});
		if (accounts.length === 0) {
			const source = authStorage.describeCredentialSource(providerId, this.ctx.session.sessionId);
			const suffix = source ? ` Current auth comes from ${source}; remove that source to log out.` : "";
			this.ctx.showError(`Logout skipped: no stored credentials for ${providerId}.${suffix}`);
			return;
		}

		this.showSelector(done => {
			const selector = new LogoutAccountSelectorComponent(
				provider?.name ?? providerId,
				accounts,
				account => {
					done();
					void this.#handleCredentialLogout(providerId, account);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		if (providerId) {
			if (mode === "login") {
				await this.#handleOAuthLogin(providerId);
			} else {
				await this.#showOAuthLogoutAccountSelector(providerId);
			}
			return;
		}

		if (mode === "logout") {
			await this.#refreshOAuthProviderAuthState();
			const oauthProviders = getOAuthProviders();
			const loggedInProviders = oauthProviders.filter(provider =>
				this.ctx.session.modelRegistry.authStorage.has(provider.id),
			);
			if (loggedInProviders.length === 0) {
				this.ctx.showStatus("No stored provider credentials to log out. Remove env or config auth at its source.");
				return;
			}
		}

		this.showSelector(done => {
			const selector = new OAuthSelectorComponent(
				mode,
				this.ctx.session.modelRegistry.authStorage,
				async (selectedProviderId: string) => {
					selector.stopValidation();
					done();
					if (mode === "login") {
						await this.#handleOAuthLogin(selectedProviderId);
					} else {
						await this.#showOAuthLogoutAccountSelector(selectedProviderId);
					}
				},
				() => {
					selector.stopValidation();
					done();
					this.ctx.ui.requestRender();
				},
				{
					validateAuth: async (selectedProviderId: string) => {
						const apiKey = await this.ctx.session.modelRegistry.getApiKeyForProvider(
							selectedProviderId,
							this.ctx.session.sessionId,
						);
						return !!apiKey;
					},
					requestRender: () => {
						this.ctx.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async showSessionPinSelector(): Promise<void> {
		const session = this.ctx.session;
		if (session.isStreaming) {
			this.ctx.showStatus("Cannot pin an account while the session is streaming.");
			return;
		}
		this.ctx.showStatus("Loading provider accounts…", { dim: true });
		let accountList: SessionOAuthAccountList | undefined;
		try {
			accountList = await session.listCurrentProviderOAuthAccounts();
		} catch (error) {
			this.ctx.showError(
				`Could not load provider accounts: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		if (!accountList) {
			this.ctx.showStatus("Select a model before pinning a provider account.");
			return;
		}
		const provider = getOAuthProviders().find(candidate => candidate.id === accountList.provider);
		const providerName = provider?.name ?? accountList.provider;
		const accounts = toSessionPinAccounts(accountList.accounts);
		if (accounts.length === 0) {
			const source = session.modelRegistry.authStorage.describeCredentialSource(
				accountList.provider,
				session.sessionId,
			);
			this.ctx.showStatus(
				source
					? `No stored OAuth accounts for ${providerName}. Current auth comes from ${source}.`
					: `No stored OAuth accounts for ${providerName}. Use /login to add one.`,
			);
			return;
		}

		this.showSelector(done => {
			const selector = new SessionAccountSelectorComponent(
				providerName,
				accounts,
				account => {
					done();
					if (!session.pinCurrentProviderOAuthAccount(account.credentialId)) {
						this.ctx.showWarning(`${account.label} is no longer available to pin.`);
						return;
					}
					this.ctx.showStatus(`Pinned ${account.label} to this session for ${providerName}.`);
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async showResetUsageSelector(): Promise<void> {
		const session = this.ctx.session;
		this.ctx.showStatus("Checking saved rate-limit resets…", { dim: true });
		let statuses: ResetCreditAccountStatus[];
		try {
			statuses = await session.listResetCredits();
		} catch (error) {
			this.ctx.showError(`Could not load saved resets: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const accounts = toResetUsageAccounts(statuses);
		if (accounts.length === 0) {
			this.ctx.showStatus("No Codex accounts found. Use /login to add one.");
			return;
		}
		if (!accounts.some(account => account.availableCount > 0)) {
			this.ctx.showStatus(
				accounts.some(account => account.error)
					? "No saved resets available — some accounts couldn't be reached (try /login)."
					: "No saved rate-limit resets available to spend right now.",
			);
			return;
		}
		this.showSelector(done => {
			const selector = new ResetUsageSelectorComponent(
				accounts,
				account => {
					done();
					void this.#redeemReset(account);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async #redeemReset(account: ResetUsageAccount): Promise<void> {
		this.ctx.showStatus(`Spending 1 saved reset for ${account.label}…`, { dim: true });
		let outcome: ResetCreditRedeemOutcome;
		try {
			outcome = await this.ctx.session.redeemResetCredit(account.target);
		} catch (error) {
			this.ctx.showError(
				`Reset failed for ${account.label}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const message = describeRedeemOutcome(outcome, account.label);
		if (outcome.ok) {
			this.ctx.showStatus(message);
			// Refresh the status-line usage so the freshly-reset window shows.
			this.ctx.statusLine.invalidate();
			this.ctx.ui.requestRender();
		} else {
			this.ctx.showWarning(message);
		}
	}

	async showDebugSelector(): Promise<void> {
		const { DebugSelectorComponent } = await import("../../debug");
		this.showSelector(done => {
			const selector = new DebugSelectorComponent(this.ctx, done);
			return { component: selector, focus: selector };
		});
	}

	showAgentHub(observers: SessionObserverRegistry, options?: AgentHubOpenOptions): void {
		const hubKeys = [
			...this.ctx.keybindings.getKeys("app.agents.hub"),
			...this.ctx.keybindings.getKeys("app.session.observe"),
		];
		let overlayHandle: OverlayHandle | undefined;
		let closed = false;

		const done = () => {
			if (closed) return;
			closed = true;
			hub.dispose();
			overlayHandle?.hide();
			// A gated empty Hub may never have been mounted. Restoring editor
			// focus in that case would steal focus from a menu opened meanwhile.
			if (overlayHandle) this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};

		const hub = new AgentHubOverlayComponent({
			observers,
			settings: this.ctx.settings,
			hubKeys,
			expandKeys: this.ctx.keybindings.getKeys("app.tools.expand"),
			initialSection: options?.initialSection,
			onDone: done,
			requestRender: () => this.ctx.ui.requestRender(),
			registry: this.ctx.collabGuest?.agentRegistry,
			remote: this.ctx.collabGuest?.hubRemote,
			ui: this.ctx.ui,
			getTool: name => this.ctx.session.getToolByName(name),
			isBuiltInTool: name => this.ctx.session.hasBuiltInTool(name),
			getMessageRenderer: type => this.ctx.session.extensionRunner?.getMessageRenderer(type),
			cwd: this.ctx.sessionManager.getCwd(),
			hideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			proseOnlyThinking: () => this.ctx.proseOnlyThinking,
			focusAgent: id => this.ctx.focusAgentSession(id),
			sessionFile: this.ctx.sessionManager.getSessionFile() ?? null,
		});

		const showReadyHub = () => {
			if (closed) return;
			// The double-← gesture stays inert when neither live nor persisted
			// subagents are available, so wait for discovery before making the gate.
			if (options?.requireContent && hub.isEmpty) {
				done();
				return;
			}

			// Prime the detector before the first frame when the editor's double-←
			// gesture opened the hub, so the next single ← dismisses it.
			if (options?.armCloseTap) hub.armCloseTap();
			overlayHandle = this.#showFullscreenMenu(hub);
		};

		if (options?.requireContent && hub.isEmpty) {
			void hub.persistedSubagentsReady.then(showReadyHub);
		} else {
			showReadyHub();
		}
	}
}

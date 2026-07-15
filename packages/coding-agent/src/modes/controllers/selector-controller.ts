import { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import { PASTE_CODE_LOGIN_PROVIDERS } from "@pk-nerdsaver-ai/pi-ai";
import { getOAuthProviders } from "@pk-nerdsaver-ai/pi-ai/oauth";
import type { OAuthProvider } from "@pk-nerdsaver-ai/pi-ai/oauth/types";
import type { Component, OverlayHandle } from "@pk-nerdsaver-ai/pi-tui";
import { Input, Loader, Spacer, setTuiTight, Text } from "@pk-nerdsaver-ai/pi-tui";
import { getAgentDbPath, getProjectDir, normalizePathForComparison } from "@pk-nerdsaver-ai/pi-utils";
import { formatModelSelectorValue } from "../../config/model-resolver";
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
	setSymbolPreset,
	setTheme,
	theme,
} from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome } from "../../session/auth-storage";
import type { SessionInfo } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import { type LogoutAccount, toLogoutAccounts } from "../../slash-commands/helpers/logout";
import {
	describeRedeemOutcome,
	type ResetUsageAccount,
	toResetUsageAccounts,
} from "../../slash-commands/helpers/reset-usage";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../../thinking";
import {
	isImageProviderPreference,
	isSearchProviderId,
	isSearchProviderPreference,
	setExcludedSearchProviders,
	setPreferredImageProvider,
	setPreferredSearchProvider,
} from "../../tools";
import { shortenPath } from "../../tools/render-utils";
import { copyToClipboard } from "../../utils/clipboard";
import { setSessionTerminalTitle } from "../../utils/title-generator";
import { AgentDashboard } from "../components/agent-dashboard";
import { AgentHubOverlayComponent } from "../components/agent-hub";
import { AssistantMessageComponent } from "../components/assistant-message";
import { CopySelectorComponent } from "../components/copy-selector";
import { ExtensionDashboard } from "../components/extensions";
import { HistorySearchComponent } from "../components/history-search";
import { LogoutAccountSelectorComponent } from "../components/logout-account-selector";
import { ModelSelectorComponent } from "../components/model-selector";
import { OAuthSelectorComponent } from "../components/oauth-selector";
import { PluginSelectorComponent } from "../components/plugin-selector";
import { ResetUsageSelectorComponent } from "../components/reset-usage-selector";
import { SessionSelectorComponent } from "../components/session-selector";
import { SettingsSelectorComponent } from "../components/settings-selector";
import { ToolExecutionComponent } from "../components/tool-execution";
import { TranscriptBlock } from "../components/transcript-container";
import { TreeSelectorComponent } from "../components/tree-selector";
import { UserMessageSelectorComponent } from "../components/user-message-selector";
import type { SessionObserverRegistry } from "../session-observer-registry";
import { buildCopyTargets } from "../utils/copy-targets";

const MANUAL_LOGIN_TIP = "Tip: You can complete pairing with /login <redirect URL>.";

export class SelectorController {
	constructor(private ctx: InteractiveModeContext) {}

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
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.ctx.remountEditorComposer();
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
			let overlayHandle: OverlayHandle | undefined;
			const done = () => {
				overlayHandle?.hide();
				this.ctx.ui.setFocus(this.ctx.editor);
				this.ctx.ui.requestRender();
			};
			const selector = new SettingsSelectorComponent(
				{
					availableThinkingLevels: [...this.ctx.session.getAvailableThinkingLevels()],
					thinkingLevel: this.ctx.session.thinkingLevel,
					availableThemes,
					cwd: getProjectDir(),
					model: this.ctx.session.model,
					imageBudget: this.ctx.ui.imageBudget,
					requestRender: () => this.ctx.ui.requestRender(),
				},
				{
					onChange: (id, value) => this.handleSettingChange(id, value),
					onThemePreview: async themeName => {
						const result = await previewTheme(themeName);
						if (result.success) {
							this.ctx.statusLine.invalidate();
							this.ctx.updateEditorTopBorder();
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
							...previewSettings,
						});
						this.ctx.updateEditorTopBorder();
						this.ctx.ui.requestRender();
					},
					getStatusLinePreview: () => {
						// Return the rendered status line for inline preview
						const availableWidth = this.ctx.editor.getTopBorderAvailableWidth(this.ctx.ui.terminal.columns);
						return this.ctx.statusLine.getTopBorder(availableWidth).content;
					},
					onPluginsChanged: async () => {
						const projectPath = await resolveActiveProjectRegistryPath(this.ctx.sessionManager.getCwd());
						clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
						await this.ctx.refreshSlashCommandState();
						await this.ctx.session.refreshSshTool({ activateIfAvailable: true });
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
						});
						this.ctx.updateEditorTopBorder();
						this.ctx.ui.requestRender();
					},
				},
			);
			overlayHandle = this.ctx.ui.showOverlay(selector, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(selector);
			this.ctx.ui.requestRender();
		});
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
		const dashboard = await ExtensionDashboard.create(getProjectDir(), this.ctx.settings, this.ctx.ui.terminal.rows);
		const overlay = this.ctx.ui.showOverlay(dashboard, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
		});
		dashboard.onClose = () => {
			overlay.hide();
			this.ctx.ui.requestRender();
		};
		dashboard.onRequestRender = () => {
			this.ctx.ui.requestRender();
		};
	}

	/**
	 * Show the Agent Control Center dashboard.
	 */
	async showAgentsDashboard(): Promise<void> {
		const activeModel = this.ctx.session.model;
		const activeModelPattern = activeModel ? `${activeModel.provider}/${activeModel.id}` : undefined;
		const defaultModelPattern = this.ctx.settings.getModelRole("default");
		const dashboard = await AgentDashboard.create(getProjectDir(), this.ctx.settings, this.ctx.ui.terminal.rows, {
			modelRegistry: this.ctx.session.modelRegistry,
			activeModelPattern,
			defaultModelPattern,
		});
		const overlay = this.ctx.ui.showOverlay(dashboard, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
		});
		dashboard.onClose = () => {
			overlay.hide();
			this.ctx.ui.requestRender();
		};
		dashboard.onRequestRender = () => {
			this.ctx.ui.requestRender();
		};
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

			case "autocompleteMaxVisible":
				this.ctx.editor.setAutocompleteMaxVisible(typeof value === "number" ? value : Number(value));
				break;

			case "composer.layout": {
				const effectiveLayout = this.ctx.settings.get("composer.layout");
				this.ctx.editor.placeholder = effectiveLayout === "intent" ? "Describe the outcome you want…" : undefined;
				if (effectiveLayout !== "intent" && this.ctx.getComposerWorkMode() === "ask") {
					void this.ctx.restoreComposerAskTools().catch(error => {
						this.ctx.showError(
							`Failed to exit Ask mode while changing composer layout: ${error instanceof Error ? error.message : String(error)}`,
						);
					});
				}
				this.ctx.updateEditorTopBorder();
				this.ctx.ui.requestRender();
				break;
			}
			case "plan.enabled":
				if (
					value === false &&
					(this.ctx.getComposerWorkMode() === "plan" || this.ctx.session.getPlanModeState?.())
				) {
					void this.ctx
						.disableComposerPlanMode()
						.catch(error => this.ctx.showError(error instanceof Error ? error.message : String(error)));
				}
				this.ctx.updateEditorTopBorder();
				this.ctx.ui.requestRender();
				break;
			// Settings with UI side effects
			case "showImages":
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof ToolExecutionComponent) {
						child.setShowImages(value as boolean);
					}
				}
				break;
			case "hideThinking":
				this.ctx.hideThinkingBlock = value as boolean;
				this.ctx.session.agent.hideThinkingSummary = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setHideThinkingBlock(value as boolean);
					}
				}
				// Full clear + replay so blocks frozen in committed scrollback on
				// ED3-risk terminals retire their stale snapshots too (see
				// InputController.toggleThinkingBlockVisibility).
				this.ctx.ui.resetDisplay();
				break;
			case "display.cacheMissMarker":
				// Rebuild re-runs the usage-based detection under the new setting so
				// markers appear/disappear; full reset retires any already committed
				// to native scrollback (mirrors hideThinking).
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "tui.tight":
				setTuiTight(value as boolean);
				this.ctx.ui.invalidate();
				this.ctx.updateEditorTopBorder();
				this.ctx.ui.requestRender();
				break;

			case "theme": {
				setTheme(value as string, true).then(result => {
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorTopBorder();
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
					this.ctx.updateEditorTopBorder();
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
				};
				this.ctx.statusLine.updateSettings(statusLineSettings);
				this.ctx.updateEditorTopBorder();
				this.ctx.ui.requestRender();
				break;
			}

			// Provider settings - update runtime preferences
			case "providers.webSearch":
				if (typeof value === "string" && isSearchProviderPreference(value)) {
					setPreferredSearchProvider(value);
				}
				break;
			case "providers.webSearchExclude":
				if (Array.isArray(value)) {
					setExcludedSearchProviders(value.filter(isSearchProviderId));
				}
				break;
			case "providers.image":
				if (isImageProviderPreference(value)) {
					setPreferredImageProvider(value);
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
		const currentContextTokens = this.ctx.session.getContextUsage()?.tokens ?? 0;
		this.showSelector(done => {
			const selector = new ModelSelectorComponent(
				this.ctx.ui,
				this.ctx.session.model,
				this.ctx.settings,
				this.ctx.session.modelRegistry,
				this.ctx.session.scopedModels,
				async (model, role, thinkingLevel, selector) => {
					// `auto` is session-global: never baked into a per-role model value
					// (it can't round-trip through `model:<level>`). Apply it to the session
					// separately and persist via `defaultThinkingLevel`.
					const isAuto = thinkingLevel === AUTO_THINKING;
					const concreteThinking = isAuto ? undefined : thinkingLevel;
					try {
						if (role === null) {
							// Temporary: update agent state but don't persist the model to settings
							await this.ctx.session.setModelTemporary(model);
							if (isAuto) {
								this.ctx.session.setThinkingLevel(AUTO_THINKING, true);
							}
							this.ctx.statusLine.invalidate();
							this.ctx.updateEditorBorderColor();
							this.ctx.showStatus(`Temporary model: ${selector ?? model.id}`);
							done();
							this.ctx.ui.requestRender();
						} else if (role === "default") {
							// Default: update agent state and persist
							await this.ctx.session.setModel(model, role, {
								selector,
								thinkingLevel: concreteThinking,
								persist: true,
							});
							if (isAuto) {
								this.ctx.session.setThinkingLevel(AUTO_THINKING, true);
							} else if (concreteThinking && concreteThinking !== ThinkingLevel.Inherit) {
								this.ctx.session.setThinkingLevel(concreteThinking);
							}
							this.ctx.statusLine.invalidate();
							this.ctx.updateEditorBorderColor();
							this.ctx.showStatus(`Default model: ${selector ?? model.id}`);
							// Don't call done() - selector stays open for role assignment
						} else {
							// Other roles (smol, slow): just update settings, not current model
							this.ctx.settings.setModelRole(
								role,
								formatModelSelectorValue(selector ?? `${model.provider}/${model.id}`, concreteThinking),
							);
							if (isAuto) {
								this.ctx.session.setThinkingLevel(AUTO_THINKING, true);
							}
							const roleInfo = getRoleInfo(role, settings);
							const roleLabel = roleInfo?.name ?? role;
							this.ctx.showStatus(`${roleLabel} model: ${selector ?? model.id}`);
							// Don't call done() - selector stays open
						}
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				{ ...options, currentContextTokens },
			);
			return { component: selector, focus: selector };
		});
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
		const userMessages = this.ctx.session.getUserMessagesForBranching();

		if (userMessages.length === 0) {
			this.ctx.showStatus("No messages to branch from");
			return;
		}

		this.showSelector(done => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map(m => ({ id: m.entryId, text: m.text })),
				async entryId => {
					const result = await this.ctx.session.branch(entryId);
					if (result.cancelled) {
						// Hook cancelled the branch
						done();
						this.ctx.ui.requestRender();
						return;
					}

					this.ctx.chatContainer.clear();
					this.ctx.renderInitialMessages({ clearTerminalHistory: true });
					this.ctx.editor.setText(result.selectedText);
					done();
					this.ctx.showStatus("Branched to new session");
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	showCopySelector(): void {
		const targets = buildCopyTargets(this.ctx.session);
		if (targets.length === 0) {
			this.ctx.showStatus("Nothing to copy yet.");
			return;
		}

		let overlayHandle: OverlayHandle | undefined;
		const done = () => {
			overlayHandle?.hide();
			this.ctx.ui.requestRender();
		};
		const selector = new CopySelectorComponent(targets, {
			onPick: target => {
				done();
				if (target.content === undefined) return;
				void copyToClipboard(target.content);
				this.ctx.showStatus(target.copyMessage ?? "Copied to clipboard");
			},
			onCancel: done,
		});

		overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
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
				async entryId => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.ctx.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					const branchSummariesEnabled = settings.get("branchSummary.enabled");

					while (branchSummariesEnabled) {
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
						const result = await this.ctx.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

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
						this.ctx.chatContainer.clear();
						this.ctx.renderInitialMessages({ clearTerminalHistory: true });
						await this.ctx.reloadTodos();
						if (result.editorText && !this.ctx.editor.getText().trim()) {
							this.ctx.editor.setText(result.editorText);
						}
						this.ctx.showStatus("Navigated to selected point");
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.ctx.statusContainer.clear();
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

	async showSessionSelector(): Promise<void> {
		const sessions = await SessionManager.list(
			this.ctx.sessionManager.getCwd(),
			this.ctx.sessionManager.getSessionDir(),
		);
		// Current folder has no sessions: preload the global list so the picker
		// can open straight into all-projects scope instead of dead-ending.
		let allSessions: SessionInfo[] | undefined;
		let startInAllScope = false;
		if (sessions.length === 0) {
			allSessions = await SessionManager.listAll();
			startInAllScope = allSessions.length > 0;
		}
		const historyStorage = this.ctx.historyStorage;
		const historyMatcher = historyStorage ? (query: string) => historyStorage.matchingSessionIds(query) : undefined;
		this.showSelector(done => {
			const selector = new SessionSelectorComponent(
				sessions,
				async (session: SessionInfo) => {
					done();
					await this.handleResumeSession(session.path);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				() => {
					void this.ctx.shutdown();
				},
				{
					onDelete: async (session: SessionInfo) => {
						if (!(await this.#detachActiveSessionBeforeDeletion(session.path))) {
							return false;
						}
						const storage = new FileSessionStorage();
						try {
							await storage.deleteSessionWithArtifacts(session.path);
							return true;
						} catch (err) {
							throw new Error(`Failed to delete session: ${err instanceof Error ? err.message : String(err)}`, {
								cause: err,
							});
						}
					},
					historyMatcher,
					loadAllSessions: () => SessionManager.listAll(),
					allSessions,
					startInAllScope,
					getTerminalRows: () => this.ctx.ui.terminal.rows,
				},
			);
			selector.setOnRequestRender(() => this.ctx.ui.requestRender());
			return { component: selector, focus: selector };
		});
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
		this.ctx.statusLine.setSessionStartTime(Date.now());
		this.ctx.updateEditorTopBorder();
		this.ctx.updateEditorBorderColor();
		this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
		return true;
	}

	async handleResumeSession(sessionPath: string): Promise<void> {
		this.ctx.clearTransientSessionUi();

		const previousCwd = this.ctx.sessionManager.getCwd();
		// Switch session via AgentSession (emits hook and tool session events). The
		// SessionManager adopts the resumed session's own cwd when it differs.
		await this.ctx.session.switchSession(sessionPath);
		const newCwd = this.ctx.sessionManager.getCwd();
		const movedProject = normalizePathForComparison(newCwd) !== normalizePathForComparison(previousCwd);
		if (movedProject) {
			// Resumed a session from another project: re-point the process and every
			// cwd-derived cache at it before rendering.
			await this.ctx.applyCwdChange(newCwd);
		}
		this.#refreshSessionTerminalTitle();
		this.ctx.updateEditorBorderColor();

		// Clear and re-render the chat
		this.ctx.chatContainer.clear();
		this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		this.ctx.showStatus(movedProject ? `Resumed session in ${shortenPath(newCwd)}` : "Resumed session");
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

	async #handleOAuthLogin(providerId: string): Promise<void> {
		this.ctx.showStatus(`Logging in to ${providerId}…`);
		const manualInput = this.ctx.oauthManualInput;
		const useManualInput = PASTE_CODE_LOGIN_PROVIDERS.has(providerId);
		try {
			await this.ctx.session.modelRegistry.authStorage.login(providerId as OAuthProvider, {
				onAuth: (info: { url: string; instructions?: string }) => {
					const block = new TranscriptBlock();
					block.addChild(new Text(theme.fg("dim", info.url), 1, 0));
					const hyperlink = `\x1b]8;;${info.url}\x07Click here to login\x1b]8;;\x07`;
					block.addChild(new Text(theme.fg("accent", hyperlink), 1, 0));
					if (info.instructions) {
						block.addChild(new Spacer(1));
						block.addChild(new Text(theme.fg("warning", info.instructions), 1, 0));
					}
					if (useManualInput) {
						block.addChild(new Spacer(1));
						block.addChild(new Text(theme.fg("dim", MANUAL_LOGIN_TIP), 1, 0));
					}
					this.ctx.present(block);
					this.ctx.openInBrowser(info.url);
				},
				onPrompt: async (prompt: { message: string; placeholder?: string }) => {
					const promptBlock = new TranscriptBlock();
					promptBlock.addChild(new Text(theme.fg("warning", prompt.message), 1, 0));
					if (prompt.placeholder) {
						promptBlock.addChild(new Text(theme.fg("dim", prompt.placeholder), 1, 0));
					}
					this.ctx.present(promptBlock);
					const { promise, resolve } = Promise.withResolvers<string>();
					const codeInput = new Input();
					codeInput.onSubmit = () => {
						const code = codeInput.getValue();
						this.ctx.remountEditorComposer();
						this.ctx.ui.setFocus(this.ctx.editor);
						resolve(code);
					};
					this.ctx.editorContainer.clear();
					this.ctx.editorContainer.addChild(codeInput);
					this.ctx.ui.setFocus(codeInput);
					this.ctx.ui.requestRender();
					return promise;
				},
				onProgress: (message: string) => {
					this.ctx.present(new Text(theme.fg("dim", message), 1, 0));
				},
				onManualCodeInput: useManualInput ? () => manualInput.waitForInput(providerId) : undefined,
			});
			await this.ctx.session.modelRegistry.refresh();
			const block = new TranscriptBlock();
			block.addChild(
				new Text(theme.fg("success", `${theme.status.success} Successfully logged in to ${providerId}`), 1, 0),
			);
			block.addChild(new Text(theme.fg("dim", `Credentials saved to ${getAgentDbPath()}`), 1, 0));
			this.ctx.present(block);
		} catch (error: unknown) {
			this.ctx.showError(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (useManualInput) {
				manualInput.clear(`Manual OAuth input cleared for ${providerId}`);
			}
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

			await this.ctx.session.modelRegistry.refresh();
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
			let selector: OAuthSelectorComponent;
			selector = new OAuthSelectorComponent(
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

	showAgentHub(observers: SessionObserverRegistry, options?: { requireContent?: boolean }): void {
		const hubKeys = [
			...this.ctx.keybindings.getKeys("app.agents.hub"),
			...this.ctx.keybindings.getKeys("app.session.observe"),
			...this.ctx.keybindings.getKeys("app.session.backgrounds"),
		];
		let hub: AgentHubOverlayComponent | undefined;

		// Render the hub inline in the editor slot — the same anchored region
		// every other selector (model, session, tree, the `ask` tool) uses —
		// rather than a floating overlay. A non-fullscreen overlay composited over
		// a live transcript strands a stale copy in native scrollback every time a
		// running subagent's progress grows the frame and scrolls the window; the
		// hub is opened mid-run, so those copies stacked into a wall of duplicate
		// "Agent Hub" frames bleeding the task tree behind them. As an editor-slot
		// component it rides the normal append-only commit path: the transcript
		// commits above it exactly once and the hub repaints in place.
		const done = () => {
			hub?.dispose();
			this.ctx.remountEditorComposer();
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
		};

		hub = new AgentHubOverlayComponent({
			observers,
			hubKeys,
			expandKeys: this.ctx.keybindings.getKeys("app.tools.expand"),
			onDone: done,
			requestRender: () => this.ctx.ui.requestRender(),
			registry: this.ctx.collabGuest?.agentRegistry,
			remote: this.ctx.collabGuest?.hubRemote,
			ui: this.ctx.ui,
			getTool: name => this.ctx.session.getToolByName(name),
			getMessageRenderer: type => this.ctx.session.extensionRunner?.getMessageRenderer(type),
			cwd: this.ctx.sessionManager.getCwd(),
			hideThinkingBlock: () => this.ctx.hideThinkingBlock,
			focusAgent: id => this.ctx.focusAgentSession(id),
			sessionFile: this.ctx.sessionManager.getSessionFile() ?? null,
			sessionDir: this.ctx.sessionManager.getSessionDir(),
			resumeSession: (sessionPath: string) => this.handleResumeSession(sessionPath),
		});

		const mount = () => {
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(hub);
			this.ctx.ui.setFocus(hub);
			this.ctx.ui.requestRender();
		};

		// The double-← gesture passes requireContent so it stays inert when there
		// is nothing to show; the explicit hub/observe keys still open the empty
		// roster. The persisted-subagent scan is synchronous, but background
		// sessions load via an async disk scan — with no live subagents the hub
		// looks empty at construction, which used to make ←← a no-op even when
		// background sessions existed. Await the scan before judging emptiness.
		if (options?.requireContent && hub.isEmpty) {
			void hub.backgroundsLoaded().then(() => {
				if (hub.isEmpty) {
					hub.dispose();
					return;
				}
				// The scan is fast but real I/O: if the user started typing in the
				// meantime, opening the hub now would steal a non-empty editor.
				if (this.ctx.editor.getText().trim() !== "") {
					hub.dispose();
					return;
				}
				mount();
			});
			return;
		}

		mount();
	}
}

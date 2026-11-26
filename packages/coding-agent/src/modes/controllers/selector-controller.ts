import { type AgentMessage, type AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent, Model, UsageReport } from "@oh-my-pi/pi-ai";
import type { OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { type JSXNode, type KeyEvent, signal, type UiNode, untrack } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { actionKey, formatKeyHint } from "../../ui/keys/hints";
import { getAgentDir, getProjectDir, logger, normalizePathForComparison, sanitizeText } from "@oh-my-pi/pi-utils";
import { ADVISOR_DEFAULT_TOOL_NAMES } from "../../advisor/advise-tool";
import { loadWatchdogConfigFile, resolveAdvisorConfigEditPath, saveWatchdogConfigFile } from "../../advisor/config";
import { reset as resetCapabilities } from "../../capability";
import type { AdvisorConfigScope } from "../../advisor/advisor-config-types";
import { showGitOverlay } from "../../cli/git-tui";
import { formatLoginIdentity } from "../../cli/oauth-terminal";
import {
	acquireModelRoleMutation,
	applyModelPreset,
	formatModelPresetSwitch,
	isCleanModelPresetSwitch,
	modelPresetSavedMessage,
	roleModelCandidates,
	saveModelPreset,
} from "../../config/model-presets";
import { resolveAdvisorRoleSelection, resolveModelRoleValue } from "../../config/model-resolver";
import { routedModelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { formatModelSelectorValue } from "../../config/model-selector";
import { getRoleInfo } from "../../config/model-roles";
import { settings } from "../../config/settings";
import { createSettingsHost } from "../../config/settings-ui";
import { createPluginSettingsHost } from "../../extensibility/plugins/settings-host";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../extensibility/plugins/marketplace";
import type {
	AgentHubOpenOptions,
	InteractiveModeContext,
	ResumeSessionOptions,
	SubmittedUserInput,
} from "../../modes/types";
import type { SessionOAuthAccountList } from "../../session/agent-session-types";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome } from "../../session/auth-storage";
import { credentialStoreLabel } from "../../session/auth-broker-config";
import {
	createForeignSessionStore,
	foreignSessionInfoToSessionInfo,
	foreignSessionSourceName,
	persistForeignSession,
} from "../../session/foreign-session-import";
import type { ForeignSessionInfo, ForeignSessionSource } from "../../session/foreign-session-store";
import { previewModelCompactionPoint, setModelCompactionPoint } from "../../session/model-compaction-threshold";
import { isTranscriptEntry, type TranscriptEntry } from "../../session/session-context";
import { isUserRequestEntry } from "../../session/transcript/transcript-entry";
import type { TurnAct, TurnMessage } from "../../session/transcript/transcript-actions";
import type { SessionEntry, SessionTreeNode } from "../../session/session-entries";
import { findSessionContinuation, readSessionInfo, type SessionInfo } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { loadPinnedSessionIds, setSessionPinned } from "../../session/session-pins";
import { FileSessionStorage } from "../../session/session-storage";
import { listLogoutAccounts, logoutCredential } from "../../slash-commands/helpers/logout";
import type { LogoutAccount } from "../view-model/overlays/logout-account-selector";
import { describeRedeemOutcome, toResetUsageAccounts } from "../../slash-commands/helpers/reset-usage";
import { toSessionPinAccounts } from "../../slash-commands/helpers/session-pin";
import {
	accountIdentityLabel,
	collectStoredAccounts,
	collectUnreportedAccounts,
	selectReportableAccounts,
} from "../../slash-commands/helpers/usage-accounts";
import { loadDailyActivity } from "../../stats/activity-client";
import { AUTO_THINKING, concreteThinkingLevel, parseConfiguredThinkingLevel } from "../../thinking/levels";
import { type ConfiguredThinkingLevel } from "../../utils/render-utils";
import type { ToolSession } from "../../tools";
import { AskTool } from "../../tools/ask";
import { cfgTodoBackend, NATIVE_TODO_BACKEND } from "../../tools/settings";
import { type AskToolDetails } from "../../tools/details/ask";
import { sanitizeDisplayWarnings, shortenPath } from "../../utils/render-utils";
import { ToolAbortError } from "../../tools/tool-errors";
import { captureBrowserSession } from "../../utils/browser-session";
import { copyToClipboard } from "../../utils/clipboard";
import { openPath } from "../../utils/open";
import { setSessionTerminalTitle } from "../../utils/title-generator";
import { createAgentsHubDeps } from "../agents-hub-deps";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { collapseSharedUsageReports } from "../../session/usage-display";
import { limitMatchesActiveAccount } from "../../slash-commands/helpers/active-oauth-account";
import { createAgentHubRuntime } from "../agent-hub-runtime";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { type AgentRef, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { listLiveToolRecords, liveToolRecordFromSession } from "../../extensibility/inventory/live-tool-session";
import { createExtensionDashboardRuntime } from "../components/extensions/dashboard-runtime";
import { type ModelRoleSelectionScope } from "../view-model/overlays/model-hub";
import { createModelBrowserSource } from "../model-browser-source";
import { formatSessionContinuationNotice } from "../persistence-failure";
import { type ResetUsageAccount } from "../view-model/overlays/reset-usage-selector";
import { type BranchVariantPath } from "../view-model/overlays/rewind-selector";
import type { SubmenuOption } from "../../config/settings-defs";
import { renderUsageReports } from "./command-controller";
import type { SessionObserverRegistry } from "../../task/session-observer-registry";
import type { AdvisorConfigCallbacks, AdvisorConfigDeps } from "../../ui/overlays/advisor-config/model";
import { presentShellInspector } from "../../ui/apps/shell-visualizer";
import { AdvisorConfigOverlay } from "../../ui/overlays/advisor-config/advisor-config";
import { AgentTranscriptViewer } from "../../ui/overlays/panels/agent-transcript-viewer";
import {
	AgentTranscriptViewerModel,
	type ViewerTranscriptActions,
} from "../../ui/overlays/panels/agent-transcript-viewer-model";
import { ExtensionDashboard } from "../../ui/overlays/panels/extensions-dashboard";
import { ExtensionDashboardModel } from "../../ui/overlays/panels/extensions-dashboard-model";
import { LoginDialog, LoginDialogState } from "../../ui/overlays/panels/login-dialog";
import { UsageDashboard } from "../../ui/overlays/panels/usage-dashboard";
import { UsageDashboardModel } from "../../ui/overlays/panels/usage-dashboard-model";
import { AgentHub, type AgentHubHandle, type AgentHubProps } from "../../ui/overlays/pickers/agent-hub";
import { AgentsHub, type AgentsHubHandle } from "../../ui/overlays/pickers/agents-hub";
import { CopySelector } from "../../ui/overlays/pickers/copy-selector";
import { HistorySearch } from "../../ui/overlays/pickers/history-search";
import { LogoutAccountSelector } from "../../ui/overlays/pickers/logout-account-selector";
import { ModelHub, type ModelHubProps } from "../../ui/overlays/pickers/model-hub";
import type { ModelHubState } from "../../ui/overlays/pickers/model-hub-state";
import { ModelPicker, type ModelPickerProps, prewarmModelPicker } from "../../ui/overlays/pickers/model-picker";
import { type OAuthAuthState, OAuthSelector } from "../../ui/overlays/pickers/oauth-selector";
import { ResetUsageSelector } from "../../ui/overlays/pickers/reset-usage-selector";
import { RewindSelector, rewindTargets } from "../../ui/overlays/pickers/rewind-selector";
import { SessionAccountSelector } from "../../ui/overlays/pickers/session-account-selector";
import {
	SessionSelector,
	sessionSelectorFocus,
	type SessionSelectorProps,
} from "../../ui/overlays/pickers/session-selector";
import { ThinkingSelector } from "../../ui/overlays/pickers/thinking-selector";
import { TreeSelector } from "../../ui/overlays/pickers/tree-selector";
import { PluginSelector } from "../../ui/overlays/plugins/selector";
import { createPluginSettingsPage } from "../../ui/overlays/plugins/settings";
import { SettingsWindow, type StatusLinePreview } from "../../ui/overlays/settings/settings";
import type { OverlayHandle, OverlayOptions } from "../../ui/shell/overlays";
import { StatusBarPreview } from "../../ui/status/composer-facts";
import type { StatusLineSettings } from "../view-model/status-line/types";
import {
	bottomSheetView,
	firstOfKind,
	isWithin,
	fullscreenMenuView,
	layerContent,
	layerDock,
	outcomeLinesView,
	REWIND_PAGE,
	successText,
	usageDashboardView,
} from "./selector-views";

import { cfgAdvisorSyncBacklog } from "../../advisor/settings";
import { cfgBranchSummaryEnabled } from "../../session/context-settings";
import { cfgCycleOrder, cfgDisabledProviders, cfgModelRoleStorage } from "../../config/model-settings";
import { cfgDefaultThinkingLevel, cfgRetryFallbackChains, cfgSessionWorktreeScope } from "../../session/settings";
import { cfgTreeFilterMode } from "../settings";
import { cfgTaskAgentModelOverrides } from "../../task/settings";
import { previewTheme } from "../../ui/theme/service";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { listThemes } from "@oh-my-pi/pi-tui/theme/loader";

/** First-use boundary for the provider auth catalog. */
async function loadProviderAuthUi() {
	const [{ PASTE_CODE_LOGIN_PROVIDERS }, oauth] = await Promise.all([
		import("@oh-my-pi/pi-ai"),
		import("@oh-my-pi/pi-ai/oauth"),
	]);
	return {
		PASTE_CODE_LOGIN_PROVIDERS,
		getOAuthProviders: oauth.getOAuthProviders,
		getOAuthCredentialProvider: oauth.getOAuthCredentialProvider,
	};
}

/** The settings screen's status line preview as status line settings. */
function statusLinePreview(preview: StatusLinePreview): Partial<StatusLineSettings> {
	return preview as Partial<StatusLineSettings>;
}

/** Keys of a select sheet go to its `picker`. */
const pickerFocus = (root: UiNode): UiNode => firstOfKind(root, "picker");

/** Menus that open at most once: a repeat request focuses the open one. */
type MenuKind = "settings" | "model-picker" | "model-hub" | "agents-dashboard" | "agent-hub" | "usage-dashboard";

/** An open menu: registered when the request runs, given its overlay once the screen mounts. */
interface OpenMenu {
	handle?: OverlayHandle;
	/** The node holding the menu's keys. */
	focus?: UiNode;
}

/**
 * Return input to the current editor-slot owner: the composer, or a dialog
 * shown in its place (an approval prompt that fired while a fullscreen
 * overlay was up, issue #3349).
 */
export function focusActiveEditorArea(ctx: InteractiveModeContext): void {
	ctx.shell.focus(null);
}

export class SelectorController {
	/**
	 * Each single-instance menu from the moment it is requested until it closes,
	 * so a repeat request (typed or clicked while the first is still loading,
	 * or from a composer that stays reachable, as in Tern's native view)
	 * focuses it instead of stacking another menu on top.
	 */
	#openMenus = new Map<MenuKind, OpenMenu>();
	/** The open agent hub's handle (deep links into the open hub). */
	#agentHub: AgentHubHandle | undefined;

	constructor(private ctx: InteractiveModeContext) {}

	/**
	 * Mount `menu`'s screen as a primary fullscreen menu (the one modal path
	 * shared by Settings, Model Hub, Agent Hub and the dashboards). `focus`
	 * picks the node holding the keys (default: the screen); `onKey` takes keys
	 * on the layer itself, for screens that rebuild their root. The menu is
	 * released however it closes.
	 */
	#showFullscreenMenu(
		kind: MenuKind,
		menu: OpenMenu,
		view: () => JSXNode,
		options: { focus?: (screen: UiNode) => UiNode; onKey?: (key: KeyEvent) => boolean; onClose?: () => void } = {},
	): OverlayHandle {
		// Tern docks a prefs sheet beside the session when it is a direct layer child.
		const sheet = kind === "settings" && this.ctx.shell.host?.feature("aside");
		const handle = this.ctx.shell.overlays.show(
			sheet ? view : () => fullscreenMenuView(kind, view(), options.onKey),
			{
				focus: root => {
					const screen = sheet ? root : layerContent(root);
					menu.focus = options.onKey ? root : (options.focus?.(screen) ?? screen);
					return menu.focus;
				},
				onClose: () => {
					this.#releaseMenu(kind, menu);
					options.onClose?.();
				},
			},
		);
		menu.handle = handle;
		return handle;
	}

	/**
	 * Bring the open `kind` menu forward; true when one was open (or is still
	 * loading) and the request is handled. A menu another overlay covers is
	 * raised over it with its state intact.
	 */
	#focusOpenMenu(kind: MenuKind): boolean {
		const open = this.#openMenus.get(kind);
		if (!open) return false;
		if (open.handle && !open.handle.closed) {
			this.ctx.shell.overlays.raise(open.handle);
			this.ctx.shell.focus(open.focus ?? open.handle.node);
		}
		return true;
	}

	/** Register a new `kind` menu; pass it to {@link #releaseMenu} when it closes or fails to open. */
	#claimMenu(kind: MenuKind): OpenMenu {
		const menu: OpenMenu = {};
		this.#openMenus.set(kind, menu);
		return menu;
	}

	#releaseMenu(kind: MenuKind, menu: OpenMenu): void {
		if (this.#openMenus.get(kind) === menu) this.#openMenus.delete(kind);
	}

	/** Close `kind`'s menu and give the keys back to the editor area. */
	#closeMenu(menu: OpenMenu): void {
		menu.handle?.close();
		this.focusActiveEditorArea();
	}

	/**
	 * Serialize default-role mutations with `/modelpreset switch`, which holds the
	 * same shared tail in `config/model-presets.ts` for its whole apply.
	 */
	async #acquireDefaultRoleMutation(): Promise<() => void> {
		return acquireModelRoleMutation();
	}

	async #refreshOAuthProviderAuthState(): Promise<void> {
		const { getOAuthProviders } = await loadProviderAuthUi();
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
	 * Restore keyboard focus to whatever currently owns the editor slot: the
	 * composer, or a hook selector/input/editor `ExtensionUiController` showed
	 * in its place — e.g. an approval prompt that fired while a fullscreen
	 * overlay was up, where the overlay's own focus restore would land on the
	 * covered composer (issue #3349).
	 */
	focusActiveEditorArea(): void {
		focusActiveEditorArea(this.ctx);
	}

	/**
	 * Show a picker in the composer's place until it calls `done`; the composer
	 * and its focus come back then. Keys go to the screen's first picker.
	 */
	#showInEditorArea(build: (done: () => void) => JSXNode, focus: OverlayOptions["focus"] = pickerFocus): void {
		const done = (): void => handle.close();
		const handle = this.ctx.showEditorAreaDialog(() => build(done), { focus });
	}

	showSettingsSelector(): void {
		if (this.#focusOpenMenu("settings")) return;
		const menu = this.#claimMenu("settings");
		// Startup-deferred extensions bind first, so the todo backend row lists their backends.
		const themes = this.ctx.session.hasPendingDeferredExtensions
			? Promise.all([listThemes(), this.ctx.session.loadDeferredExtensions()]).then(([names]) => names)
			: listThemes();
		themes
			.then(availableThemes => {
				if (this.#openMenus.get("settings") !== menu) return;
				// Fullscreen settings editor on the alternate screen: the transcript stays untouched underneath.
				const done = () => this.#closeMenu(menu);
				this.#showFullscreenMenu(
					"settings",
					menu,
					() =>
						SettingsWindow({
							context: {
								availableThinkingLevels: [...this.ctx.session.getAvailableThinkingLevels()],
								availableThemes,
								runtimeOptions: new Map([[cfgTodoBackend.id, this.#todoBackendOptions()]]),
								providers: [
									...new Set(this.ctx.session.getAvailableModels().map(model => model.provider)),
								].sort((a, b) => a.localeCompare(b)),
								settings: createSettingsHost(),
								plugins: createPluginSettingsHost(getProjectDir()),
								composerPreviewStatus: {
									settings: this.ctx.statusLine.settings,
									facts: this.ctx.statusLine.facts,
								},
								model: this.ctx.session.model,
								graphics: this.ctx.shell.host?.driver.capabilities.images != null,
							},
							pluginsPage: createPluginSettingsPage,
							callbacks: {
								onChange: (id, value) => {
									this.handleSettingChange(id, value);
									// A backend offered here is registered, so it gets the current list at once. An approved
									// `cfg://` write can name one whose extension is still loading, like a config reload:
									// those get the list with the next change. The effective value decides: a project or
									// runtime layer can keep another backend selected over the global one written here.
									if (id === cfgTodoBackend.id) {
										const backend = cfgTodoBackend.get(this.ctx.session.settings);
										if (backend !== NATIVE_TODO_BACKEND) {
											this.ctx.session.extensionRunner?.syncTodoBackend(
												backend,
												this.ctx.session.getTodoPhases(),
											);
										}
									}
								},
								onThemePreview: async themeName => {
									await previewTheme(themeName);
								},
								onStatusLinePreview: preview => this.ctx.statusLine.previewSettings(statusLinePreview(preview)),
								getStatusLinePreview: () => this.#statusLinePreviewSpans(),
								describeStatusLinePreview: () => this.#statusLinePreviewView(),
								onPluginsChanged: async () => {
									const projectPath = await resolveActiveProjectRegistryPath(this.ctx.sessionManager.getCwd());
									clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
									await this.ctx.refreshSkillState();
									await this.ctx.refreshSlashCommandState();
									resetCapabilities();
								},
								onCancel: done,
							},
						}),
					{
						focus: screen => firstOfKind(screen, "prefs"),
						// Restore the status line to the saved settings.
						onClose: () => this.ctx.statusLine.previewSettings(undefined),
					},
				);
			})
			.catch((error: unknown) => {
				// A menu that never opened must not block the next `/settings`.
				this.#releaseMenu("settings", menu);
				throw error;
			});
	}

	/** The status line as the settings preview shows it in the terminal: the composer shape's status row. */
	#statusLinePreviewSpans(): readonly TspSpan[] {
		const row = this.ctx.statusLinePreviewRow(untrack(this.ctx.shell.size).columns);
		return row ? [{ t: row }] : [];
	}

	/** The status line with the preview settings, as a bar of its own. */
	#statusLinePreviewView(): JSXNode {
		return StatusBarPreview({ settings: this.ctx.statusLine.settings, facts: this.ctx.statusLine.facts });
	}

	/**
	 * Fullscreen `/usage` dashboard on the alternate screen (the /settings
	 * idiom): compact subscriptions grid + daily activity heatmap, with the
	 * classic full report one keypress away. Takes no transcript space.
	 */
	showUsageDashboard(reports: UsageReport[]): void {
		// Checked here, not before the fetch: a repeat `/usage` whose fetch lands
		// while the first dashboard is open focuses it instead of stacking a copy.
		const kind = "usage-dashboard";
		if (this.#focusOpenMenu(kind)) return;
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		const accounts = selectReportableAccounts(
			collectStoredAccounts(authStorage),
			provider => authStorage.usage.providerFor(provider) !== undefined,
		);
		if (reports.length === 0 && accounts.length === 0) {
			this.ctx.showWarning("No usage data available.");
			return;
		}
		const unavailableAccounts = collectUnreportedAccounts(reports, accounts).map(account => ({
			provider: account.provider,
			label: accountIdentityLabel(account),
		}));
		const currentProvider = this.ctx.session.model?.provider;
		const activeAccount = currentProvider
			? this.ctx.session.modelRegistry.authStorage.oauth.identity(currentProvider, this.ctx.session.sessionId)
			: undefined;
		const usageModelSelectors = this.ctx.session.getUsageReportingModelSelectors(reports);
		const menu = this.#claimMenu(kind);
		const size = this.ctx.shell.size;
		const dashboard = new UsageDashboardModel({
			reports,
			unavailableAccounts,
			renderDetail: (width, current) =>
				renderUsageReports(
					current,
					currentTheme(),
					Date.now(),
					width,
					provider => (provider === currentProvider ? activeAccount : undefined),
					usageModelSelectors,
					unavailableAccounts,
				),
			// A rejection leaves the dashboard up with "History unavailable" in place of the heatmap.
			loadActivity: async (push, signal) => {
				try {
					await loadDailyActivity(push, signal);
				} catch (error) {
					logger.warn("Usage activity history unavailable", {
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
			},
			refresh: () => this.ctx.session.fetchUsageReports(),
			terminalRows: () => size().rows,
			onClose: () => this.#closeMenu(menu),
		});
		// Keep focus on the stable layer when the dashboard rebuilds its body.
		menu.handle = this.ctx.shell.overlays.show(
			() =>
				usageDashboardView(this.ctx.shell.native(), UsageDashboard({ model: dashboard }), key =>
					dashboard.key(key.id),
				),
			{
				onClose: () => {
					this.#releaseMenu(kind, menu);
					dashboard.close();
				},
			},
		);
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
			if (initialDoc.warnings?.length) {
				this.ctx.showWarning(`WATCHDOG.yml: ${sanitizeDisplayWarnings(initialDoc.warnings).join("; ")}`);
			}
			// Fullscreen editor on the alternate screen (the /settings idiom): the
			// overlay holds the alt buffer + mouse tracking; the transcript stays put.
			const done = () => {
				overlayHandle?.close();
				this.focusActiveEditorArea();
			};
			// Label the seeded implicit-default row with the actual advisor-role model
			// (NOT the first live advisor, which may be a named advisor from another scope).
			const advisorRoleSel = resolveAdvisorRoleSelection(
				this.ctx.settings,
				this.ctx.session.modelRegistry.getAvailable(),
			);
			const defaultAdvisorModel = advisorRoleSel?.model;
			const deps: AdvisorConfigDeps = {
				getAvailableModels: () => this.ctx.session.modelRegistry.getAvailable(),
				mruOrder: createModelBrowserSource(this.ctx.settings).mruOrder,
				defaultToolNames: ADVISOR_DEFAULT_TOOL_NAMES,
				externalEditor: text => {
					const command = getEditorCommand();
					return command ? this.ctx.suspend(() => openInEditor(command, text)) : Promise.resolve(null);
				},
				scopedModels: this.ctx.session.scopedModels,
				availableToolNames: this.ctx.session.getAdvisorAvailableToolNames(),
				syncBacklog: cfgAdvisorSyncBacklog.get(this.ctx.settings),
				defaultModelLabel: defaultAdvisorModel
					? `${defaultAdvisorModel.provider}/${defaultAdvisorModel.id}`
					: undefined,
			};
			const callbacks: AdvisorConfigCallbacks = {
				loadDoc: async scope => loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs)),
				save: async (scope, doc) => {
					await saveWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs), doc);
					const { count, warnings } = await this.ctx.session.reloadAdvisorConfigs();
					this.ctx.statusLine.refresh();
					if (warnings.length > 0) {
						this.ctx.showWarning(`WATCHDOG.yml: ${sanitizeDisplayWarnings(warnings).join("; ")}`);
					}
					this.ctx.showStatus(
						count > 0
							? `Saved ${scope} WATCHDOG.yml — ${count} advisor${count === 1 ? "" : "s"} active.`
							: `Saved ${scope} WATCHDOG.yml. Run /advisor on to activate the configured advisors.`,
					);
				},
				close: done,
				notify: message => this.ctx.showStatus(message),
				// Scope switches happen inside the overlay; the initial file's warnings
				// were already shown above, so only newly activated files arrive here.
				warn: message => this.ctx.showWarning(message),
				stats: () => this.ctx.session.getAdvisorStats().advisors,
				getUsageReports: async () => {
					const reports = await this.ctx.session.fetchUsageReports?.();
					return reports ? collapseSharedUsageReports(reports) : null;
				},
				getQuotaLimitFilter: (provider, sessionId) => {
					const identity = this.ctx.session.modelRegistry.authStorage.oauth.identity(
						provider,
						sessionId ?? this.ctx.session.sessionId,
					);
					return identity ? (report, limit) => limitMatchesActiveAccount(report, limit, identity) : undefined;
				},
			};
			const overlayHandle = this.ctx.shell.overlays.show(
				() =>
					fullscreenMenuView(
						"advisor-config",
						AdvisorConfigOverlay({ deps, scope: initialScope, doc: initialDoc, callbacks }),
					),
				{ focus: root => firstOfKind(root, "prefs") },
			);
		})();
	}

	showHistorySearch(): void {
		const historyStorage = this.ctx.historyStorage;
		if (!historyStorage) return;
		// Ctrl+R also opens over hook/ask prompts that replace the composer in the
		// editor slot; the pick belongs to that prompt, not the hidden composer.
		const prompt = this.ctx.promptPasteTarget;
		const focused = this.ctx.shell.focused();
		const target =
			prompt && focused && (focused === prompt.node || isWithin(focused, prompt.node)) ? prompt : this.ctx.composer;
		this.#showInEditorArea(done =>
			HistorySearch({
				source: historyStorage,
				onSelect: text => {
					done();
					target.setText(text);
				},
				onCancel: done,
			}),
		);
	}

	/**
	 * Show the Extension Control Center dashboard.
	 * Replaces /status with a unified view of all providers and extensions.
	 */
	async showExtensionsDashboard(): Promise<void> {
		const dashboard = await ExtensionDashboardModel.create({
			runtime: createExtensionDashboardRuntime({
				cwd: getProjectDir(),
				settings: this.ctx.settings,
				extensionRoots: () => this.ctx.session.effectiveExtensionRoots,
				mcpManager: this.ctx.mcpManager,
				eventBus: this.ctx.eventBus,
				onMcpToolsChanged: tools => this.ctx.session.refreshMCPTools(tools),
				browserMcpFilterEnabled: () =>
					this.ctx.session.getEvalPreludes().some(definition => definition.name === "browser"),
			}),
			terminal: { theme: currentTheme, size: this.ctx.shell.size },
			toolSource: {
				getLiveTool: name => liveToolRecordFromSession(this.ctx.session, name),
				listLiveTools: () => listLiveToolRecords(this.ctx.session),
			},
			expandKey: this.ctx.keybindings.keysFor("app.tools.expand")[0],
			onClose: () => {
				overlay?.close();
				this.focusActiveEditorArea();
			},
		});
		// Fullscreen dashboard on the alternate screen (the /settings idiom): the transcript stays untouched underneath.
		const overlay = this.ctx.shell.overlays.show(
			() => fullscreenMenuView("extensions", ExtensionDashboard({ model: dashboard })),
			{ focus: layerContent, onClose: () => dashboard.dispose() },
		);
	}

	/**
	 * Fullscreen git UI on the alternate screen (the /models idiom): split
	 * diff viewer, staging sidebar, and commit composer. Resolves focus back
	 * to the editor when the user closes it.
	 */
	async showGitTui(revision?: string): Promise<void> {
		try {
			await showGitOverlay(this.ctx.shell, {
				cwd: getProjectDir(),
				revision,
				usageLedger: this.ctx.sessionManager,
			});
		} catch (error) {
			this.ctx.showStatus(error instanceof Error ? error.message : String(error));
		}
		this.focusActiveEditorArea();
	}

	/**
	 * Fullscreen agents hub on the alternate screen (the /models idiom): scope
	 * sidebar, agent rows, and chip strips that dive into the model browser.
	 */
	async showAgentsDashboard(): Promise<void> {
		if (this.#focusOpenMenu("agents-dashboard")) return;
		const menu = this.#claimMenu("agents-dashboard");
		const activeModel = this.ctx.session.model;
		const activeModelPattern = activeModel ? `${activeModel.provider}/${activeModel.id}` : undefined;
		const defaultModelPattern = this.ctx.settings.getModelRole("default");
		const deps = createAgentsHubDeps(
			getProjectDir(),
			this.ctx.settings,
			this.ctx.session.modelRegistry,
			() => this.ctx.session.effectiveExtensionRoots,
			activeModelPattern,
			defaultModelPattern,
			model => this.ctx.session.effectiveServiceTier(model),
		);
		const size = this.ctx.shell.size;
		let hub: AgentsHubHandle | undefined;
		const handle = this.#showFullscreenMenu(
			"agents-dashboard",
			menu,
			() =>
				AgentsHub({
					deps,
					rows: () => size().rows,
					onCancel: () => this.#closeMenu(menu),
					ref: instance => {
						hub = instance;
					},
				}),
			// The hub swaps its root (picker ↔ card): keys go through the layer, not a node it replaces.
			{ onKey: key => hub?.onKey(key) ?? false },
		);
		try {
			await hub?.reload();
		} catch (error) {
			// A dashboard that never loaded must not block the next `/agents`.
			handle.close();
			throw error;
		}
	}

	/** `todo.backend` choices: `Native`, then every backend an enabled extension registered. */
	#todoBackendOptions(): SubmenuOption[] {
		const options: SubmenuOption[] = [
			{ value: NATIVE_TODO_BACKEND, label: "Native", description: "Keep the todo list in the session only" },
		];
		for (const [id, { definition }] of this.ctx.session.extensionRunner?.getTodoBackends() ?? []) {
			options.push({ value: id, label: definition.label ?? id, description: definition.description });
		}
		return options;
	}

	/**
	 * Apply the side effects of a setting change the user made in this process
	 * (settings selector, approved `cfg://` writes); the value is already stored.
	 * Only `defaultThinkingLevel` needs this: it also switches the live session,
	 * which config reloads and parent-session writes must not do. Every other
	 * setting applies through handle listeners owned by the session and InteractiveMode.
	 */
	handleSettingChange(id: string, value: unknown): void {
		if (id !== cfgDefaultThinkingLevel.id || typeof value !== "string") return;
		const level = parseConfiguredThinkingLevel(value);
		if (level === undefined || level === this.ctx.session.configuredThinkingLevel()) return;
		this.ctx.session.setThinkingLevel(level);
	}

	/**
	 * Open a model selector. A focused subagent always gets the session-only
	 * picker: the hub assigns persistent roles, which configure the main session
	 * and future spawns rather than the agent being viewed.
	 */
	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		if (options?.temporaryOnly || this.ctx.focusedAgentId) {
			this.#showModelPicker();
			return;
		}
		this.#showModelHub({});
	}

	/**
	 * Builds what the first alt+p reads ahead of it, in background slices
	 * ({@link prewarmModelPicker}), once the startup model discovery settled:
	 * composing the catalog earlier would make each discovery land recompose it.
	 */
	async warmModelPicker(signal: AbortSignal): Promise<void> {
		const registry = this.ctx.session.modelRegistry;
		await registry.awaitInitialBackgroundRefresh(signal);
		if (signal.aborted) return;
		const viewed = this.ctx.viewSession;
		await prewarmModelPicker({
			source: createModelBrowserSource(this.ctx.settings, model => viewed.effectiveServiceTier(model)),
			registry,
			scopedModels: this.ctx.session.scopedModels.map(entry => entry.model),
			currentContextTokens: viewed.getContextUsage()?.tokens ?? 0,
			signal,
		});
	}

	/**
	 * Session-only model switch (`/switch <selector>`) for the viewed session:
	 * applies the resolved model without persisting it. Compacts first when the
	 * transcript exceeds the target's context window, mirroring an over-context
	 * pick in the alt+p picker. Failures surface as status errors.
	 */
	async switchSessionModel(model: Model, thinkingLevel?: ConfiguredThinkingLevel): Promise<void> {
		const contextTokens = this.ctx.viewSession.getContextUsage()?.tokens ?? 0;
		const contextWindow = model.contextWindow ?? 0;
		const overContext = contextWindow > 0 && contextTokens > contextWindow;
		try {
			await this.#applySessionModel(model, `${model.provider}/${model.id}`, thinkingLevel, overContext);
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * Apply a session-only model to the viewed session: update agent state but
	 * never persist to settings. `compactFirst` runs compaction with the current
	 * model before switching (the target cannot fit the transcript); the switch
	 * runs in the before-flush hook so any prompt queued during compaction
	 * executes on the target model, and the idempotent post-return call covers
	 * the early "nothing to compact" return that skips the hook. A cancelled or
	 * failed compaction keeps the current model. A focused subagent switches
	 * directly: `/compact` drives the main session, and the agent's own context
	 * maintenance recovers an oversized transcript on its next turn.
	 */
	async #applySessionModel(
		model: Model,
		selector: string,
		thinkingLevel: ConfiguredThinkingLevel | undefined,
		compactFirst: boolean,
	): Promise<void> {
		const target = this.ctx.viewSession;
		const focusedAgentId = this.ctx.focusedAgentId;
		const apply = async () => {
			// Without a slider level, the session's level carries over (clamped to the model).
			await target.setModelTemporary(model, thinkingLevel);
			this.ctx.statusLine.refresh();
			this.ctx.updateEditorBorderColor();
			if (focusedAgentId) {
				this.ctx.showStatus(`Agent ${focusedAgentId} model: ${selector}`);
				return;
			}
			const roleSelectorHint = actionKey("app.model.select", this.ctx.keybindings) || formatKeyHint("alt+m");
			this.ctx.showStatus(`Session-only model: ${selector}. Use ${roleSelectorHint} or /model for roles.`);
		};
		if (!compactFirst || focusedAgentId) {
			await apply();
			return;
		}
		let switched = false;
		const switchAfterCompaction = async (outcome: CompactionOutcome) => {
			if (switched || outcome !== "ok") return;
			switched = true;
			await apply();
		};
		// The target reads what this pass writes: no provider-native method it cannot replay.
		const outcome = await this.ctx.handleCompactCommand(undefined, undefined, switchAfterCompaction, {
			readerModel: model,
		});
		await switchAfterCompaction(outcome);
	}

	/**
	 * Compact session-only model picker (alt+p / `/switch`): a floating
	 * bottom-anchored overlay over the transcript. The current model is
	 * highlighted and preselected; a leading `@` searches ctrl+p quick roles.
	 */
	#showModelPicker(): void {
		const menuKind = "model-picker";
		if (this.#focusOpenMenu(menuKind)) return;
		const viewed = this.ctx.viewSession;
		const currentContextTokens = viewed.getContextUsage()?.tokens ?? 0;
		const current = viewed.model;
		const quickRoleOrder = cfgCycleOrder.get(this.ctx.settings);
		const quickRoleCycle = viewed.getRoleModelCycle(quickRoleOrder);
		const currentSelector = current ? `${current.provider}/${current.id}` : undefined;
		// Preselect the effective Task model in task mode: the configured override,
		// else the session model (the bundled task agent inherits it by default).
		const taskOverride = cfgTaskAgentModelOverrides.get(this.ctx.settings).task;
		const taskSelector = (Array.isArray(taskOverride) ? taskOverride[0] : taskOverride) ?? currentSelector;
		const menu = this.#claimMenu(menuKind);
		const done = () => {
			if (this.#openMenus.get(menuKind) !== menu) return;
			this.#closeMenu(menu);
		};
		const isCurrent = () => this.#openMenus.get(menuKind) === menu;
		// One pick per target: an Enter repeated while that pick applies is dropped, but a
		// pick of a different model or role made meanwhile queues behind it, so a slower
		// earlier apply can never resolve after and overwrite a newer pick; a queued pick
		// that a newer one supersedes is dropped before it applies.
		let pickInFlightKey: string | null = null;
		let latestPickId = 0;
		let pickQueue: Promise<void> = Promise.resolve();
		const source = createModelBrowserSource(this.ctx.settings, model => viewed.effectiveServiceTier(model));
		const size = this.ctx.shell.size;
		const callbacks: ModelPickerProps["callbacks"] = {
			onPick: async (model, selector, { overContext, thinkingLevel }) => {
				const key = `model:${selector}:${thinkingLevel ?? ""}`;
				if (!isCurrent() || pickInFlightKey === key) return;
				pickInFlightKey = key;
				const pickId = ++latestPickId;
				const prev = pickQueue;
				let release!: () => void;
				pickQueue = new Promise<void>(resolve => {
					release = resolve;
				});
				try {
					await prev;
					// A closed picker never applies, and a newer pick supersedes this one.
					if (!isCurrent() || pickId !== latestPickId) return;
					// Over-context pick: close the picker first so the compaction
					// loader is visible.
					if (overContext) done();
					await this.#applySessionModel(model, selector, thinkingLevel, overContext);
					if (!overContext && pickId === latestPickId) done();
				} catch (error) {
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				} finally {
					if (pickId === latestPickId) pickInFlightKey = null;
					release();
				}
			},
			onPickRole: async entry => {
				const key = `role:${entry.role}`;
				if (!isCurrent() || pickInFlightKey === key) return;
				pickInFlightKey = key;
				const pickId = ++latestPickId;
				const prev = pickQueue;
				let release!: () => void;
				pickQueue = new Promise<void>(resolve => {
					release = resolve;
				});
				try {
					await prev;
					if (!isCurrent() || pickId !== latestPickId) return;
					await this.ctx.viewSession.applyRoleModel(entry);
					this.ctx.statusLine.refresh();
					this.ctx.updateEditorBorderColor();
					this.ctx.showModelCycleTrack(
						quickRoleOrder.map(role => ({ label: role })),
						quickRoleOrder.indexOf(entry.role),
					);
					if (pickId === latestPickId) done();
				} catch (error) {
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				} finally {
					if (pickId === latestPickId) pickInFlightKey = null;
					release();
				}
			},
			onPickTask: (_model, selector) => {
				if (!isCurrent()) return;
				// Session-only: layer the Task override onto the runtime settings
				// layer so it is never persisted, mirroring the session-model pick.
				cfgTaskAgentModelOverrides.override(this.ctx.settings, {
					...cfgTaskAgentModelOverrides.get(this.ctx.settings),
					task: selector,
				});
				this.ctx.showStatus(`Task subagent model (session-only): ${selector}. Use /agents to persist.`);
				done();
			},
			onKeepThinking: level => {
				if (!isCurrent() || level === viewed.configuredThinkingLevel()) return;
				viewed.setThinkingLevel(level);
				this.ctx.statusLine.refresh();
				this.ctx.updateEditorBorderColor();
			},
			onCatalogRefreshed: async () => {
				await this.ctx.session.refreshScopedModels();
				return this.ctx.session.scopedModels;
			},
			onCancel: done,
		};
		const options: ModelPickerProps["options"] = {
			currentContextTokens,
			currentSelector,
			taskModeKeys: this.ctx.keybindings.keysFor("app.model.selectTemporary"),
			taskSelector,
			quickRoles: quickRoleCycle?.models,
			quickRoleOrder,
			currentQuickRole: quickRoleCycle?.models[quickRoleCycle.currentIndex]?.role,
			// The level the session runs at, auto's resolved effort once a turn settles it (as the
			// status line shows); an untouched slider still carries the selection, auto included.
			thinkingLevelFor: () => viewed.autoResolvedThinkingLevel() ?? viewed.configuredThinkingLevel(),
		};
		menu.handle = this.ctx.shell.overlays.show(
			() => {
				const picker = ModelPicker({
					source,
					registry: this.ctx.session.modelRegistry,
					scopedModels: this.ctx.session.scopedModels,
					callbacks,
					options,
					terminalRows: () => size().rows,
				});
				// Tern's picker is the sheet: its composer anchor is measured from the layer.
				// Only the terminal renderer needs a bottom overlay to place the rows.
				return this.ctx.shell.native() ? picker : bottomSheetView(menuKind, picker);
			},
			{
				focus: root => {
					menu.focus = firstOfKind(root, "picker");
					return menu.focus;
				},
				onClose: () => this.#releaseMenu(menuKind, menu),
			},
		);
	}

	/**
	 * Fullscreen model hub on the alternate screen (the /settings idiom): the
	 * overlay enables mouse tracking for its lifetime and the transcript stays
	 * untouched underneath. `initialProviderId` preselects a provider's sidebar
	 * entry — used when reopening the hub after a /login round-trip.
	 */
	#showModelHub(hubOptions: { initialProviderId?: string }): void {
		if (this.#focusOpenMenu("model-hub")) return;
		const menu = this.#claimMenu("model-hub");
		let closed = false;
		const done = () => {
			// Re-entrant guard: cancel paths (Esc, login forward) may race;
			// the overlay must close exactly once.
			if (closed) return;
			closed = true;
			this.#closeMenu(menu);
		};
		let hub: ModelHubState | undefined;
		const callbacks: ModelHubProps["callbacks"] = {
			onAssign: async (model, role, thinkingLevel, selector, scope?: ModelRoleSelectionScope) => {
				const releaseDefaultMutation = role === "default" ? await this.#acquireDefaultRoleMutation() : undefined;
				const configuredStorage = cfgModelRoleStorage.get(this.ctx.settings);
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
							configuredStorage === "project" && targetScope === "project" && effectiveProvenance === "overlay";
						if (shadowedGlobal) {
							this.ctx.settings.setModelRole(
								"default",
								formatModelSelectorValue(selectorValue, concreteThinking),
							);
							if (isAuto) {
								cfgDefaultThinkingLevel.set(this.ctx.settings, AUTO_THINKING);
							}
						} else if (shadowedProject) {
							this.ctx.settings.setProjectModelRole(
								"default",
								formatModelSelectorValue(selectorValue, concreteThinking),
							);
							if (isAuto) {
								cfgDefaultThinkingLevel.set(this.ctx.settings, AUTO_THINKING);
							}
						} else {
							const { switched } = await this.ctx.session.setModel(model, role, {
								selector,
								thinkingLevel: isAuto ? ThinkingLevel.Inherit : concreteThinking,
								persist: targetScope === "global",
							});
							if (!switched) return false;
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
							this.ctx.statusLine.refresh();
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
					return true;
				} catch (error) {
					this.ctx.showError(error instanceof Error ? error.message : String(error));
					return false;
				} finally {
					releaseDefaultMutation?.();
					hub?.refreshAfterExternalMutation();
				}
			},
			onUnassign: async (role, scope?: ModelRoleSelectionScope) => {
				const releaseDefaultMutation = role === "default" ? await this.#acquireDefaultRoleMutation() : undefined;
				const configuredStorage = cfgModelRoleStorage.get(this.ctx.settings);
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
					// runtime override. When that changes the effective default, or
					// the live session runs a different model than it (an earlier
					// in-session pick that a project role shadows), resolve the
					// exposed persisted layer and switch the live session without
					// writing it back to global settings. Overlay and runtime
					// provenance remain authoritative and session-neutral.
					if (role === "default") {
						const fallbackRoleValue = this.ctx.settings.getModelRole("default");
						const fallbackProvenance = this.ctx.settings.getModelRoleProvenance("default");
						const exposesPersistedFallback = fallbackProvenance === "project" || fallbackProvenance === "global";
						if (fallbackRoleValue && exposesPersistedFallback) {
							const session = this.ctx.session;
							const resolved = resolveModelRoleValue(fallbackRoleValue, roleModelCandidates(session), {
								settings: this.ctx.settings,
							});
							const liveDiffers = !routedModelsAreEqual(session.model, resolved.model);
							if (resolved.model && (fallbackRoleValue !== previousEffectiveRoleValue || liveDiffers)) {
								const fallbackModel = resolved.model;
								const isAuto = resolved.thinkingLevel === AUTO_THINKING;
								let concreteThinking = concreteThinkingLevel(resolved.thinkingLevel);
								let isAutoFromDefault = false;
								if (!resolved.explicitThinkingLevel && !concreteThinking) {
									const defaultLevel = parseConfiguredThinkingLevel(
										cfgDefaultThinkingLevel.get(this.ctx.settings),
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
								this.ctx.statusLine.refresh();
								this.ctx.updateEditorBorderColor();
								this.ctx.showStatus(`Default model: ${fallbackModel.provider}/${fallbackModel.id}`);
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
					cfgRetryFallbackChains.setEntry(this.ctx.settings, role, chain.length > 0 ? chain : undefined);
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
			onCatalogRefreshed: async () => {
				await this.ctx.session.refreshScopedModels();
				return this.ctx.session.scopedModels;
			},
			onCycleOrderChange: order => {
				try {
					cfgCycleOrder.set(this.ctx.settings, order);
					this.ctx.showStatus(
						order.length > 0 ? `Quick-switch cycle: ${order.join(" → ")}` : "Quick-switch cycle cleared",
					);
				} catch (error) {
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				}
			},
			onCompactionPointChange: (model, input, confirmed) => {
				try {
					const update = setModelCompactionPoint(this.ctx.settings, model, input, {
						tiers: this.ctx.session.modelRegistry.contextWindowTiers(model),
						confirmed,
					});
					if (update.kind === "confirm") return update;
					const { described, summary } = update;
					this.ctx.showStatus(
						`Compaction limit for ${model.provider}/${model.id}: ${described}${summary ? ` · ${summary}` : ""}`,
					);
					this.ctx.statusLine.refresh();
					// The entry can move the model between window tiers; the open hub's
					// rows are a pre-rebuild snapshot until the catalog rebuild settles.
					// The settings listener's own reapply coalesces onto this one.
					void this.ctx.session.modelRegistry
						.reapplyModelPolicies()
						.then(() => {
							if (!closed) hub?.refreshAfterExternalMutation();
						})
						.catch(error =>
							logger.warn("model hub refresh after compaction point failed", { error: String(error) }),
						);
					return undefined;
				} catch (error) {
					return { kind: "error", message: error instanceof Error ? error.message : String(error) };
				}
			},
			previewCompactionPoint: (model, input) =>
				previewModelCompactionPoint(
					this.ctx.settings,
					model,
					input,
					this.ctx.session.modelRegistry.contextWindowTiers(model),
				),
			onSavePreset: name => {
				try {
					saveModelPreset(this.ctx.settings, name);
					this.ctx.showStatus(modelPresetSavedMessage(this.ctx.settings, name));
				} catch (error) {
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				}
			},
			onSwitchPreset: async name => {
				try {
					const result = await applyModelPreset(this.ctx.settings, this.ctx.session, name);
					const message = formatModelPresetSwitch(name, result);
					if (result.kind === "switched") {
						this.ctx.statusLine.refresh();
						this.ctx.updateEditorBorderColor();
					}
					if (isCleanModelPresetSwitch(result)) this.ctx.showStatus(message);
					else this.ctx.showWarning(message);
				} catch (error) {
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				} finally {
					hub?.refreshAfterExternalMutation();
				}
			},
			onCancel: () => done(),
		};
		const size = this.ctx.shell.size;
		this.#showFullscreenMenu(
			"model-hub",
			menu,
			() =>
				ModelHub({
					source: createModelBrowserSource(this.ctx.settings, model =>
						this.ctx.session.effectiveServiceTier(model),
					),
					registry: this.ctx.session.modelRegistry,
					scopedModels: this.ctx.session.scopedModels,
					callbacks,
					options: {
						initialProviderId: hubOptions.initialProviderId,
						currentSelector: this.ctx.session.model
							? `${this.ctx.session.model.provider}/${this.ctx.session.model.id}`
							: undefined,
					},
					terminalRows: () => size().rows,
					onState: state => {
						hub = state;
					},
				}),
			{ onClose: () => (closed = true) },
		);
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
			this.#showInEditorArea(done =>
				PluginSelector({
					marketplaceCount: marketplaces.length,
					plugins: items,
					installedIds: new Set(),
					callbacks: {
						onSelect: async (name, marketplace, scope) => {
							done();
							const pluginId = `${name}@${marketplace}`;
							this.ctx.showStatus(`Uninstalling ${pluginId}...`);
							try {
								await mgr.uninstallPlugin(pluginId, scope);
								this.ctx.showStatus(`Uninstalled ${pluginId}`);
							} catch (err) {
								this.ctx.showStatus(`Uninstall failed: ${err}`);
							}
						},
						onCancel: done,
					},
				}),
			);
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

		this.#showInEditorArea(done =>
			PluginSelector({
				marketplaceCount: marketplaces.length,
				plugins: allPlugins,
				installedIds,
				callbacks: {
					onSelect: async (name, marketplace) => {
						done();
						this.ctx.showStatus(`Installing ${name} from ${marketplace}...`);
						try {
							const force = installedIds.has(`${name}@${marketplace}`);
							await mgr.installPlugin(name, marketplace, { force });
							this.ctx.showStatus(`Installed ${name} from ${marketplace}`);
						} catch (err) {
							this.ctx.showStatus(`Install failed: ${err}`);
						}
					},
					onCancel: done,
				},
			}),
		);
	}

	/** The rewind selector (Esc Esc), its outline on the latest turn, or on entry `startAt` (a turn's Rewind to here…). */
	showUserMessageSelector(startAt?: string): void {
		const entries = this.ctx.sessionManager.getBranch().filter(isTranscriptEntry);
		if (entries.length === 0) {
			this.ctx.showStatus("No messages to branch from");
			return;
		}

		if (rewindTargets(entries).length === 0) {
			this.ctx.showStatus("No messages to branch from");
			return;
		}
		const done = () => {
			overlay?.close();
			this.focusActiveEditorArea();
		};
		// Fullscreen alternate-screen overlay: the replica draws over the live
		// transcript, and the normal screen stays untouched until the rewind
		// itself rewrites it.
		const native = this.ctx.shell.native();
		const overlay = this.ctx.shell.overlays.show(
			() =>
				fullscreenMenuView(
					"rewind",
					RewindSelector({
						entries,
						siblingPaths: entryId => this.#siblingBranchPaths(entryId),
						startAt,
						terminalRows: () => this.ctx.shell.size().rows,
						...(native ? { replica: turns => this.ctx.createTranscriptReplica(turns) } : {}),
						onSelect: entryId => void this.#rewindFromTranscript(entryId, done),
						onCancel: done,
					}),
					undefined,
					REWIND_PAGE,
				),
			{ focus: layerDock },
		);
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
			const entries: TranscriptEntry[] = [];
			let node: SessionTreeNode | undefined = sibling;
			while (node) {
				if (isTranscriptEntry(node.entry)) entries.push(node.entry);
				node = node.children.at(-1);
			}
			if (entries.length > 0) paths.push({ rootId: sibling.entry.id, entries });
		}
		return paths;
	}

	/**
	 * Complete an esc-esc rewind by branching: the session moves onto a new file holding the
	 * conversation up to the target, and the file it leaves stays on disk unchanged. A
	 * user-request target (plain prompt, user-invoked skill/collab prompt) branches before
	 * itself and its draft replaces the editor text, so it is a real move even when it is the
	 * current leaf; every other target branches through the entry (`AgentSession.fork`). Work
	 * still running in the abandoned conversation stops first. `done` closes the fullscreen
	 * selector after the transcript is rebuilt so the alternate screen never flashes a stale
	 * transcript. Retry submits instead of leaving the prompt in the editor; otherwise the
	 * status toast offers Undo ({@link #undoRewind}).
	 */
	async #rewindFromTranscript(
		target: string | SubmittedUserInput,
		done: () => void,
		turn?: "edit" | "retry",
	): Promise<void> {
		const draft = { text: this.ctx.composer.text(), images: [...this.ctx.composer.pendingImages] };
		try {
			if (turn || this.ctx.session.isBusyForSnapshot) {
				if (this.ctx.loopModeEnabled) this.ctx.pauseLoop();
				this.ctx.cancelGoalContinuation();
				this.ctx.cancelPendingSubmission();
				this.ctx.yieldCompaction = undefined;
				this.ctx.compactionQueueOrigin = undefined;
				this.ctx.compactionQueuedMessages = [];
				this.ctx.updatePendingMessagesDisplay();
				await this.ctx.session.abortForRewind();
			}
			// Before the first token the bubble exists, but the session may only record
			// its user entry as the abort unwinds. Never substitute another turn by text.
			const entry =
				typeof target === "string"
					? this.ctx.sessionManager.getEntry(target)
					: this.ctx.sessionManager
							.getBranch()
							.findLast(
								e =>
									e.type === "message" &&
									e.message.role === "user" &&
									e.message.timestamp === target.submittedAt,
							);
			if (!entry || !isTranscriptEntry(entry)) {
				if (typeof target !== "string") {
					// Cancelled before dispatch: there is no persisted turn to rewind past.
					await this.#rebuildEditedTranscript();
					this.ctx.composer.setDraft(target.text, target.images);
					if (turn === "retry") this.ctx.composer.submit();
				}
				done();
				return;
			}
			const entryId = entry.id;
			const isUserTarget = isUserRequestEntry(entry);
			// Undo must return to the settled leaf, including any interrupted tool result or partial answer.
			const realLeafId = this.ctx.sessionManager.getLeafId();
			if (entryId === realLeafId && !isUserTarget) {
				done();
				this.ctx.showStatus("Already at this point");
				return;
			}
			const treeRewind = turn ? undefined : this.#treeRewindBoundary(entryId, realLeafId);
			const branch = this.ctx.sessionManager.getBranch();
			const at = branch.findIndex(e => e.id === entryId);
			const dropped =
				at < 0 ? 0 : branch.slice(isUserTarget ? at : at + 1).filter(e => isUserRequestEntry(e)).length;
			// Undo resumes the file the rewind leaves; an unpersisted session has none to return to.
			const sourceFile = this.ctx.sessionManager.isSessionOnDisk()
				? this.ctx.sessionManager.getSessionFile()
				: undefined;
			await this.ctx.prepareSessionSwitch();
			const result = isUserTarget
				? await this.ctx.session.branch(entryId, { requireIdle: true })
				: { cancelled: !(await this.ctx.session.fork(entryId)) };
			if (result.cancelled) {
				done();
				this.ctx.showStatus("Rewind cancelled");
				return;
			}
			const fastRewind =
				treeRewind !== undefined &&
				this.ctx.sessionManager.getLeafId() === treeRewind.expectedLeafId &&
				this.ctx.truncateTranscriptFromMessage(treeRewind.message);
			if (turn) {
				await this.#rebuildEditedTranscript();
			} else {
				if (!fastRewind) await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
			}
			this.ctx.statusLine.refresh();
			if ("selectedText" in result) {
				this.ctx.composer.setDraft(result.selectedText, result.selectedImages);
				if (turn === "retry") this.ctx.composer.submit();
			}
			done();
			if (turn === "retry") {
				this.ctx.showStatus("Retrying the turn");
				return;
			}
			const rewound =
				dropped > 0 ? `Rewound ${dropped} turn${dropped === 1 ? "" : "s"}` : "Rewound to selected point";
			this.ctx.showStatus(
				`${rewound} in a new session`,
				sourceFile
					? {
							action: {
								act: "undo",
								label: "Undo",
								run: () => void this.#undoRewind(sourceFile, isUserTarget ? draft : undefined),
							},
						}
					: undefined,
			);
		} catch (error) {
			done();
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	async #rebuildEditedTranscript(): Promise<void> {
		this.ctx.eventController.resetTranscriptAnchors();
		this.ctx.clearTransientSessionUi();
		await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
	}

	/**
	 * Undo of a transcript rewind: resumes `sessionFile`, the session the rewind branched from (left unchanged
	 * on disk), and brings back `draft`, what the editor held before the rewind put a prompt there.
	 */
	async #undoRewind(sessionFile: string, draft: { text: string; images: ImageContent[] } | undefined): Promise<void> {
		try {
			if (!(await this.handleResumeSession(sessionFile))) return;
			if (draft) this.ctx.composer.setDraft(draft.text, draft.images);
			this.ctx.showStatus("Rewind undone");
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * A transcript turn's hold-menu action on `message`, found on the current branch by role and timestamp:
	 * `rewind` opens the rewind selector on it; `edit` branches a new session before the turn's prompt and puts
	 * it in the editor, as Esc Esc does; `retry` branches the same way and sends the prompt again; `fork` moves
	 * onto a new session holding the conversation up to the message. Each keeps the old session on disk.
	 */
	async runTurnAction(turn: TurnAct, message: TurnMessage, pending?: SubmittedUserInput): Promise<void> {
		if (turn === "retry" && (this.ctx.composer.text().trim() || this.ctx.composer.pendingImages.length > 0)) {
			this.ctx.showStatus("Send or clear the draft to retry this turn");
			return;
		}
		const branch = this.ctx.sessionManager.getBranch();
		const index = branch.findLastIndex(
			e => e.type === "message" && e.message.role === message.role && e.message.timestamp === message.at,
		);
		const entry = branch[index];
		if (!entry) {
			if (message.role === "user" && pending?.submittedAt === message.at && (turn === "edit" || turn === "retry")) {
				await this.#rewindFromTranscript(pending, () => {}, turn);
				return;
			}
			this.ctx.showStatus("That message is no longer on this branch");
			return;
		}
		if (turn === "rewind") {
			this.showUserMessageSelector(entry.id);
			return;
		}
		if (turn === "fork") {
			await this.#forkAt(entry.id);
			return;
		}
		// The turn's prompt: the message itself, or the last one asked before the answer.
		const prompt = message.role === "user" ? entry : branch.slice(0, index).findLast(e => isUserRequestEntry(e));
		if (!prompt) {
			this.ctx.showStatus("No prompt to resend before this answer");
			return;
		}
		await this.#rewindFromTranscript(prompt.id, () => {}, turn);
	}

	/** Fork from here: the session moves onto a new file holding the conversation up to `entryId`. */
	async #forkAt(entryId: string): Promise<void> {
		// An entry fork requires an idle session; stop the running turn first.
		if (this.ctx.session.isStreaming) await this.ctx.session.abort();
		const previous = this.ctx.sessionManager.isSessionOnDisk() ? this.ctx.sessionManager.getSessionId() : undefined;
		try {
			if (!(await this.ctx.session.fork(entryId))) {
				this.ctx.showError("Fork failed (session not persisted or cancelled)");
				return;
			}
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		this.ctx.statusLine.refresh();
		this.ctx.showStatus(
			previous ? `Forked into a new session · /resume ${previous} returns` : "Forked into a new session",
		);
	}

	showCopySelector(): void {
		// The session on screen: a focused subagent's transcript, else the main one.
		const session = this.ctx.viewSession;
		const entries = session.sessionManager.getBranch().filter(isTranscriptEntry);
		if (entries.length === 0) {
			this.ctx.showStatus("Nothing to copy yet.");
			return;
		}

		const done = () => {
			overlay?.close();
			this.focusActiveEditorArea();
		};
		const overlay = this.ctx.shell.overlays.show(
			() =>
				fullscreenMenuView(
					"copy",
					CopySelector({
						entries,
						onPick: (content, label) => {
							done();
							if (!content.trim()) {
								this.ctx.showStatus("Nothing to copy in that item");
								return;
							}
							void copyToClipboard(content);
							this.ctx.showStatus(`Copied ${label} to clipboard`);
						},
						onOpen: (href, label) => {
							done();
							openPath(href);
							this.ctx.showStatus(`Opening ${label}: ${href}`);
						},
						onCancel: done,
						terminalRows: () => this.ctx.shell.size().rows,
					}),
				),
			{ focus: layerContent },
		);
	}

	showTreeSelector(): void {
		const tree = this.ctx.sessionManager.getTree();
		const realLeafId = this.ctx.sessionManager.getLeafId();

		if (tree.length === 0) {
			this.ctx.showStatus("No entries in session");
			return;
		}

		this.#showInEditorArea(done =>
			TreeSelector({
				roots: tree,
				currentLeafId: realLeafId,
				terminalHeight: untrack(this.ctx.shell.size).rows,
				onSelect: async (entryId, options) => {
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

					const branchSummariesEnabled = cfgBranchSummaryEnabled.get(settings);

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

					// While summarizing, the interrupt key aborts the summary and the status row says so.
					let removeEscape: (() => void) | undefined;
					if (wantsSummary) {
						removeEscape = this.ctx.composer.addKeyHandler(key => {
							if (!this.ctx.keybindings.matches(key, "app.interrupt")) return false;
							this.ctx.session.abortBranchSummary();
							return true;
						});
						this.ctx.showWorking("maintenance", {
							label: "Summarizing branch…",
							startedAt: Date.now(),
							interruptKey: this.ctx.maintenanceInterruptKey(),
						});
					}

					try {
						let result = await this.ctx.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
							allowAskReopen: true,
						});

						// Selecting an `ask` toolResult doesn't land the leaf directly —
						// re-open the original form first, then
						// complete the navigation as a new sibling branch (issue #5642).
						if (result.reopenAsk) {
							const reanswer = await this.#reanswerAsk(result.reopenAsk.html);
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
						if (result.editorText && !this.ctx.composer.text().trim()) {
							this.ctx.composer.setDraft(result.editorText, result.editorImages);
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
						if (wantsSummary) this.ctx.clearWorking("maintenance");
						removeEscape?.();
					}
				},
				onCancel: done,
				onLabelChange: (entryId, label) => this.ctx.sessionManager.appendLabelChange(entryId, label),
				initialFilterMode: cfgTreeFilterMode.get(settings),
				sessionName: this.ctx.sessionManager.getSessionName(),
			}),
		);
	}

	/**
	 * First rendered message a pure tree rewind drops, plus the leaf id the
	 * navigation is expected to land on. `targetId` must sit on the current
	 * leaf's path; a user-request target rewinds PAST itself (navigateTree
	 * moves the leaf to its parent and hands the draft back to the editor),
	 * every other target keeps the target as the new leaf. Returns undefined
	 * when the navigation is not a pure rewind or the boundary entry cannot
	 * anchor an in-place truncation (non-message boundary; custom messages
	 * render unkeyed components, so a skill/collab target takes the replay).
	 */
	#treeRewindBoundary(
		targetId: string,
		leafId: string | null,
	): { message: AgentMessage; expectedLeafId: string } | undefined {
		if (!leafId) return undefined;
		const target = this.ctx.sessionManager.getEntry(targetId);
		if (!target) return undefined;
		const rewindsPastTarget = isUserRequestEntry(target);
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
	 * Re-open the `ask` form with the original `html` (issue #5642):
	 * runs a standalone `AskTool.execute()` outside a normal agent turn,
	 * reusing the same dialog primitives a live `ask` tool call gets.
	 * Returns `undefined` when the user cancels — mirrors `navigateTree`'s
	 * cancellation contract instead of throwing.
	 */
	async #reanswerAsk(html: string): Promise<AgentToolResult<AskToolDetails> | undefined> {
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
		try {
			return await askTool.execute("tree-reanswer", { html }, undefined, undefined, context);
		} catch (error) {
			if (error instanceof ToolAbortError) return undefined;
			throw error;
		}
	}

	async showSessionSelector(source?: ForeignSessionSource): Promise<void> {
		let sessions: SessionInfo[];
		let onSelectSession: (session: SessionInfo) => Promise<boolean>;
		let selectorOptions: Omit<SessionSelectorProps, "sessions" | "onSelect" | "onCancel" | "onExit">;

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
				showCwd: true,
			};
		} else {
			const [listing, pinnedIds] = await Promise.all([
				SessionManager.listForPicker(
					this.ctx.sessionManager.getCwd(),
					this.ctx.sessionManager.getSessionDir(),
					undefined,
					cfgSessionWorktreeScope.get(this.ctx.settings),
					this.ctx.settings,
				),
				loadPinnedSessionIds(),
			]);
			sessions = listing.sessions;
			const historyStorage = this.ctx.historyStorage;
			const historyMatcher = historyStorage
				? (query: string) => historyStorage.matchingSessionIds(query)
				: undefined;
			onSelectSession = session => this.handleResumeSession(session.path, { followContinuation: true });
			selectorOptions = {
				onDelete: async session => {
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
				onRename: async (session, title): Promise<string | undefined> => {
					if (this.ctx.sessionManager.getSessionFile() === session.path) {
						// A session that has only been read does not hold
						// its ownership lease, so another omp process can
						// claim it; the live rename would then fork onto
						// a sibling and still report success, leaving the
						// row here pointing at the old path. Claim the
						// lease up front and refuse while it is held by
						// someone else.
						const claim = new FileSessionStorage().claimSession(session.id, session.path);
						if (!claim) {
							throw new Error("Failed to rename session: it is currently in use by another omp process");
						}
						try {
							const renamed = await this.ctx.sessionManager.setSessionName(title, "user");
							return renamed ? this.ctx.sessionManager.getSessionName() : undefined;
						} finally {
							claim();
						}
					}
					const renamed = await SessionManager.renameSessionTitle(session.path, title, {
						cwd: session.cwd,
					});
					// The picker renders the failure itself; throwing
					// hands it the reason so it can show one message
					// instead of two.
					if (!renamed) {
						throw new Error("Failed to rename session: it is currently in use or no longer available");
					}
					return renamed;
				},
				onSetPinned: async (session, pinned) => {
					await setSessionPinned(session.id, pinned);
					this.ctx.applySessionPin(session.id, pinned);
				},
				historyMatcher,
				projectName: path.basename(getProjectDir()),
				completeSessions: listing.complete,
				loadAllSessions: () => SessionManager.listAllForPicker(),
				pinnedIds,
				// Tolerant of partial contexts and in-memory sessions (undefined file means no marker).
				currentSessionPath: this.ctx.sessionManager.getSessionFile?.() ?? undefined,
			};
		}

		// Keep the fullscreen picker on the alternate buffer while a selected
		// session is loaded and its transcript is rebuilt.
		const done = () => {
			overlay?.close();
			this.focusActiveEditorArea();
		};
		const locked = signal(false);
		const overlay = this.ctx.shell.overlays.show(
			() =>
				fullscreenMenuView(
					"sessions",
					SessionSelector({
						...selectorOptions,
						sessions,
						locked,
						terminalRows: () => this.ctx.shell.size().rows,
						fillHeight: true,
						onSelect: session => {
							if (locked.peek()) return;
							locked.set(true);
							void (async () => {
								let keepOpen = false;
								try {
									keepOpen = !(await onSelectSession(session as SessionInfo));
								} catch (error) {
									this.ctx.showError(error instanceof Error ? error.message : String(error));
								} finally {
									if (keepOpen) locked.set(false);
									else done();
								}
							})();
						},
						onCancel: done,
						onExit: () => {
							// Release the alt buffer before teardown: shutdown() awaits flush/save/
							// dispose/drain before the shell stops.
							done();
							void this.ctx.shutdown();
						},
					}),
				),
			{ focus: sessionSelectorFocus },
		);
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

		await this.ctx.prepareSessionSwitch();
		const detached = await this.ctx.session.newSession();
		if (!detached) {
			return false;
		}
		this.ctx.resetObserverRegistry();
		this.#refreshSessionTerminalTitle();

		this.ctx.clearTransientSessionUi();
		this.ctx.statusLine.refresh();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.updateEditorBorderColor();
		await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		return true;
	}

	async handleResumeSession(
		sessionPath: string,
		options?: ResumeSessionOptions & { settingsFlushed?: boolean },
	): Promise<boolean> {
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
		// The conversation may have gone on in a sibling file while another process held this one.
		const continuation =
			options?.continuation ??
			(options?.followContinuation ? await findSessionContinuation(sessionPath) : undefined);
		const target = await this.#relocateStranded(continuation?.session.path ?? sessionPath);
		await this.ctx.prepareSessionSwitch();
		this.ctx.resetObserverRegistry();
		// AgentSession owns the transaction. It restores the complete source state
		// if applying the target project's cwd fails, including in-memory sessions.
		let modelFallbackWarning: string | undefined;
		if (
			(await this.ctx.session.switchSession(target.sessionPath, {
				onCwdChange: async (newCwd, sourceCwd) => {
					if (normalizePathForComparison(newCwd) === normalizePathForComparison(sourceCwd)) return true;
					return this.ctx.applyCwdChange(newCwd);
				},
				onModelFallback: warning => {
					modelFallbackWarning = warning;
				},
			})) === false
		) {
			return false;
		}
		this.ctx.clearTransientSessionUi();
		const newCwd = this.ctx.sessionManager.getCwd();
		const movedProject = normalizePathForComparison(newCwd) !== normalizePathForComparison(previousCwd);
		const recordedCwd = this.ctx.sessionManager.getRecordedCwd();
		const directoryUnavailable =
			recordedCwd !== undefined && normalizePathForComparison(recordedCwd) !== normalizePathForComparison(newCwd);
		this.#refreshSessionTerminalTitle();
		this.ctx.updateEditorBorderColor();

		// Clear and re-render the chat
		await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		this.ctx.showStatus(
			target.movedFrom
				? `Resumed session, moved here from missing ${shortenPath(target.movedFrom)}`
				: movedProject
					? `Resumed session in ${shortenPath(newCwd)}`
					: "Resumed session",
		);
		if (directoryUnavailable) {
			this.ctx.showWarning(
				`Session directory ${shortenPath(recordedCwd)} is missing or cannot be entered; continuing in ${shortenPath(newCwd)}`,
			);
		}
		if (continuation) this.ctx.showWarning(formatSessionContinuationNotice(continuation));
		if (modelFallbackWarning) this.ctx.showWarning(modelFallbackWarning);
		return true;
	}

	/**
	 * Move a session stranded under the current folder (see
	 * {@link SessionManager.isStrandedIn}) into it before resuming: its recorded
	 * directory is gone and cannot be entered.
	 * Returns the session file to switch to.
	 * @throws when the move fails, e.g. another omp process writes the session.
	 */
	async #relocateStranded(sessionPath: string): Promise<{ sessionPath: string; movedFrom?: string }> {
		const sessionManager = this.ctx.sessionManager;
		// Never move the live session out from under its own writer.
		if (sessionManager.getSessionFile() === sessionPath) return { sessionPath };
		const cwd = sessionManager.getCwd();
		const sessionDir = sessionManager.getSessionDir();
		const info = await readSessionInfo(sessionPath);
		if (!info || !(await SessionManager.isStrandedIn(info, cwd, sessionDir, this.ctx.settings)))
			return { sessionPath };
		try {
			const relocated = await SessionManager.openRelocated(sessionPath, info.cwd, cwd, sessionDir);
			const movedPath = relocated.getSessionFile() ?? sessionPath;
			await relocated.close();
			return { sessionPath: movedPath, movedFrom: info.cwd };
		} catch (error) {
			throw new Error(
				`Could not move the session here from missing ${shortenPath(info.cwd)}: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
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
	 * Run the OAuth login flow for `providerId` inside a cancellable login
	 * dialog in the composer's place. Esc aborts: the dialog's abort signal
	 * reaches the provider flow, any pending prompt rejects, and the composer
	 * comes back at once. Returns true when credentials were stored.
	 */
	async #handleOAuthLogin(providerId: string): Promise<boolean> {
		this.ctx.showStatus(`Logging in to ${providerId}…`);
		const { getOAuthCredentialProvider, PASTE_CODE_LOGIN_PROVIDERS } = await loadProviderAuthUi();
		const useManualInput = PASTE_CODE_LOGIN_PROVIDERS.has(providerId);
		const restoreEditor = () => handle.close();
		const dialog = new LoginDialogState(
			providerId,
			(_success, message) => {
				// Fires on Esc: unblock the composer at once; the aborted flow's
				// rejection settles the awaited login below.
				restoreEditor();
				if (message) this.ctx.showStatus(message);
			},
			openPath,
		);
		const handle = this.ctx.showEditorAreaDialog(() => LoginDialog({ state: dialog }));
		try {
			const identity = await this.ctx.session.modelRegistry.authStorage.oauth.login(providerId as OAuthProvider, {
				signal: dialog.signal,
				onBrowserSession: captureBrowserSession,
				onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
					// The dialog shows the full URL (SSH-safe copy target) and
					// opens the browser best-effort.
					dialog.showAuth(info.url, info.instructions, info.launchUrl);
				},
				onPrompt: prompt => dialog.showPrompt(prompt),
				onProgress: (message: string) => {
					dialog.showProgress(message);
				},
				// Paste-code providers (e.g. Codex) may need the user to paste the
				// fallback redirect URL when the loopback callback can't complete
				// (headless/remote/Windows). The dialog's focused field takes the
				// paste the OAuth flow consumes — the hidden composer's `/login <url>`
				// path is unreachable while the dialog holds focus (#5339).
				onManualCodeInput: useManualInput
					? signal =>
							dialog.showManualInput(
								`Paste the authorization code (or full redirect URL), then press ${formatKeyHint("enter")}:`,
								signal,
							)
					: undefined,
			});
			// Scope the post-login refresh to the just-authenticated provider with an
			// `online` strategy: the default all-provider `online-if-uncached` reuses
			// a fresh authoritative cache row (e.g. an empty result fetched before
			// login), so newly persisted credentials would never re-run discovery and
			// models would stay unavailable in-session (#5780). Unrelated providers
			// are left untouched. `refreshProvider` swallows discovery failures, so
			// awaiting cannot reject the login.
			await this.ctx.session.modelRegistry.refreshProvider(getOAuthCredentialProvider(providerId), "online");
			await this.ctx.session.refreshScopedModels();
			// Name the account (and Anthropic organization) that was stored so a
			// login that lands on an unintended account/subscription is visible
			// immediately instead of silently replacing an existing registration.
			const who = formatLoginIdentity(identity);
			const destination = await credentialStoreLabel(getOAuthCredentialProvider(providerId));
			this.ctx.present(() =>
				outcomeLinesView([
					["success", successText(`Successfully logged in to ${providerId}${who ? ` as ${who}` : ""}`)],
					["dim", `Credentials saved to ${destination}`],
				]),
			);
			return true;
		} catch (error: unknown) {
			if (dialog.signal.aborted) {
				// User-cancelled: the dialog already restored the composer and
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
			// Before the logout: removing a broker-unserved provider's last local login hands it back to the broker.
			const source = await credentialStoreLabel(providerId);
			const { removed, remainingSource } = await logoutCredential(
				this.ctx.session,
				providerId,
				account.credentialId,
			);
			if (!removed) {
				this.ctx.showError(`Logout skipped: ${account.label} is no longer stored for ${providerId}.`);
				return;
			}

			const lines: [string, string][] = [
				["success", successText(`Successfully logged out ${account.label} from ${providerId}`)],
				["dim", `Credential removed from ${source}`],
			];
			if (remainingSource) lines.push(["warning", `${providerId} is still authenticated via ${remainingSource}`]);
			this.ctx.present(() => outcomeLinesView(lines));
		} catch (error: unknown) {
			this.ctx.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #showOAuthLogoutAccountSelector(providerId: string): Promise<void> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		let accounts: LogoutAccount[];
		try {
			accounts = await listLogoutAccounts(authStorage, providerId, this.ctx.session.sessionId);
		} catch (error: unknown) {
			this.ctx.showError(
				`Could not load stored credentials: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const { getOAuthProviders } = await loadProviderAuthUi();
		const provider = getOAuthProviders().find(candidate => candidate.id === providerId);
		if (accounts.length === 0) {
			const source = authStorage.keys.describe(
				provider?.storeCredentialsAs ?? providerId,
				this.ctx.session.sessionId,
			);
			const suffix = source ? ` Current auth comes from ${source}; remove that source to log out.` : "";
			this.ctx.showError(`Logout skipped: no stored credentials for ${providerId}.${suffix}`);
			return;
		}

		this.#showInEditorArea(done =>
			LogoutAccountSelector({
				provider: provider?.name ?? providerId,
				accounts,
				onSelect: account => {
					done();
					void this.#handleCredentialLogout(providerId, account);
				},
				onCancel: done,
			}),
		);
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

		const { getOAuthProviders } = await loadProviderAuthUi();
		if (mode === "logout") {
			await this.#refreshOAuthProviderAuthState();
			const oauthProviders = getOAuthProviders();
			const loggedInProviders = oauthProviders.filter(provider =>
				this.ctx.session.modelRegistry.authStorage.credentials.has(provider.id),
			);
			if (loggedInProviders.length === 0) {
				this.ctx.showStatus("No stored provider credentials to log out. Remove env or config auth at its source.");
				return;
			}
		}

		// Each credential the picker can act on is checked once while it is open; a closed picker drops late answers.
		const authState = signal<ReadonlyMap<string, OAuthAuthState>>(new Map());
		let open = true;
		const authSession = this.ctx.session;
		const authStorage = authSession.modelRegistry.authStorage;
		for (const provider of getOAuthProviders()) {
			const stored =
				mode === "logout"
					? authStorage.credentials.has(provider.id)
					: authStorage.keys.source(provider.id) !== undefined;
			if (!stored) continue;
			authState.set(new Map([...authState.peek(), [provider.id, "checking"]]));
			void authSession.modelRegistry
				.getApiKeyForProvider(provider.id, authSession.sessionId)
				.then(
					apiKey => !!apiKey,
					() => false,
				)
				.then(valid => {
					if (open) authState.set(new Map([...authState.peek(), [provider.id, valid ? "valid" : "invalid"]]));
				});
		}
		this.#showInEditorArea(done => {
			const close = () => {
				open = false;
				done();
			};
			return OAuthSelector({
				mode,
				auth: this.ctx.session.modelRegistry.authStorage,
				disabledProviders: cfgDisabledProviders.get(settings),
				authState,
				onSelect: selectedProviderId => {
					close();
					if (mode === "login") void this.#handleOAuthLogin(selectedProviderId);
					else void this.#showOAuthLogoutAccountSelector(selectedProviderId);
				},
				onCancel: close,
			});
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
		const { getOAuthProviders } = await loadProviderAuthUi();
		const provider = getOAuthProviders().find(candidate => candidate.id === accountList.provider);
		const providerName = provider?.name ?? accountList.provider;
		const accounts = toSessionPinAccounts(accountList.accounts);
		if (accounts.length === 0) {
			const source = session.modelRegistry.authStorage.keys.describe(accountList.provider, session.sessionId);
			this.ctx.showStatus(
				source
					? `No stored OAuth accounts for ${providerName}. Current auth comes from ${source}.`
					: `No stored OAuth accounts for ${providerName}. Use /login to add one.`,
			);
			return;
		}

		this.#showInEditorArea(done =>
			SessionAccountSelector({
				provider: providerName,
				accounts,
				onSelect: account => {
					done();
					if (!session.pinCurrentProviderOAuthAccount(account.credentialId)) {
						this.ctx.showWarning(`${account.label} is no longer available to pin.`);
						return;
					}
					this.ctx.showStatus(`Pinned ${account.label} to this session for ${providerName}.`);
					this.ctx.statusLine.refresh();
				},
				onCancel: done,
			}),
		);
	}

	async showResetUsageSelector(): Promise<void> {
		const session = this.ctx.session;
		this.ctx.showStatus("Checking saved rate-limit resets…", { dim: true });
		let statuses: ResetCreditAccountStatus[];
		try {
			statuses = await session.listResetCredits();
		} catch (error) {
			this.ctx.showError(
				sanitizeText(
					`Could not load saved resets: ${error instanceof Error ? error.message : String(error)}`.replace(
						/[\r\n\t]+/g,
						" ",
					),
				),
			);
			return;
		}
		const accounts = toResetUsageAccounts(statuses);
		if (accounts.length === 0) {
			this.ctx.showStatus("No provider accounts found. Use /login to add one.");
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
		this.#showInEditorArea(done =>
			ResetUsageSelector({
				accounts,
				onSelect: account => {
					done();
					void this.#redeemReset(account);
				},
				onCancel: done,
			}),
		);
	}

	async #redeemReset(account: ResetUsageAccount): Promise<void> {
		this.ctx.showStatus(
			`Spending 1 saved reset for ${sanitizeText(account.label.replace(/[\r\n\t]+/g, " "))} (${account.providerLabel})…`,
			{ dim: true },
		);
		let outcome: ResetCreditRedeemOutcome;
		try {
			outcome = await this.ctx.session.redeemResetCredit(account.target);
		} catch (error) {
			this.ctx.showError(
				sanitizeText(
					`Reset failed for ${account.label}: ${error instanceof Error ? error.message : String(error)}`.replace(
						/[\r\n\t]+/g,
						" ",
					),
				),
			);
			return;
		}
		const message = sanitizeText(describeRedeemOutcome(outcome, account.label).replace(/[\r\n\t]+/g, " "));
		if (outcome.ok) {
			this.ctx.showStatus(message);
			// Refresh the status-line usage so the freshly-reset window shows.
			this.ctx.statusLine.refresh();
		} else {
			this.ctx.showWarning(message);
		}
	}

	async showDebugSelector(): Promise<void> {
		const { DebugSelector } = await import("../../debug");
		this.#showInEditorArea(
			done => DebugSelector({ host: this.ctx, onDone: done }),
			root => firstOfKind(root, "list"),
		);
	}

	/** Open the `/effort` picker for the viewed session (the focused subagent's, else main). */
	showThinkingSelector(): void {
		const viewed = this.ctx.viewSession;
		const configured = viewed.configuredThinkingLevel();
		this.#showInEditorArea(done =>
			ThinkingSelector({
				current: configured === ThinkingLevel.Inherit ? ThinkingLevel.Off : configured,
				levels: viewed.getAvailableEffortSelectors(),
				onSelect: level => {
					done();
					// thinking_level_changed refreshes the status line and editor border.
					this.ctx.viewSession.setThinkingLevel(level);
				},
				onCancel: done,
			}),
		);
	}

	showAgentHub(
		observers: SessionObserverRegistry,
		options?: AgentHubOpenOptions,
		transcriptActions?: ViewerTranscriptActions,
	): void {
		// A repeat request reuses the open hub, still honoring its deep link (`/hub` → activity).
		const reuseOpenHub = (): boolean => {
			if (!this.#focusOpenMenu("agent-hub")) return false;
			if (options?.initialSection) this.#agentHub?.showSection(options.initialSection);
			return true;
		};
		if (reuseOpenHub()) return;
		const hubKeys = [
			...this.ctx.keybindings.keysFor("app.agents.hub"),
			...this.ctx.keybindings.keysFor("app.session.observe"),
		];
		const remote = this.ctx.collabGuest?.hubRemote;
		const sessionFile = this.ctx.sessionManager.getSessionFile() ?? null;
		const runtime = createAgentHubRuntime({
			settings: this.ctx.settings,
			registry: this.ctx.collabGuest?.agentRegistry,
			remote,
			sessionFile,
		});
		const size = this.ctx.shell.size;
		let cancelled = false;

		const show = (): void => {
			// Another open mounted while discovery was pending: keep that one.
			if (cancelled || reuseOpenHub()) return;
			const menu = this.#claimMenu("agent-hub");
			let viewer: OverlayHandle | undefined;
			const done = () => {
				viewer?.close();
				this.#closeMenu(menu);
			};
			const openTranscript = (agentId: string, entryId?: string): void => {
				viewer?.close();
				const model = new AgentTranscriptViewerModel({
					agentId,
					transcript: runtime.transcript,
					registry: runtime.registry,
					remote,
					observers,
					lifecycle: () => AgentLifecycleManager.global(),
					terminalRows: () => size().rows,
					expandKeys: this.ctx.keybindings.keysFor("app.tools.expand"),
					hubKeys,
					onClose: () => viewer?.close(),
					onHubClose: done,
					initialEntryId: entryId,
					actions: transcriptActions,
					hour12: this.ctx.shell.hour12,
					inspectShell: source => presentShellInspector(this.ctx.shell, source),
					settings: this.ctx.settings,
				});
				viewer = this.ctx.shell.overlays.show(
					() => fullscreenMenuView("agent-transcript", AgentTranscriptViewer({ model })),
					{
						focus: root => firstOfKind(root, "editor"),
						onClose: () => {
							viewer = undefined;
							model.dispose();
						},
					},
				);
			};
			this.#showFullscreenMenu(
				"agent-hub",
				menu,
				() =>
					AgentHub({
						...runtime,
						observers,
						hubKeys,
						initialSection: options?.initialSection,
						rows: () => size().rows,
						focusAgent: id => this.ctx.focusAgentSession(id),
						openTranscript,
						remote,
						sessionFile,
						onDone: done,
						ref: hub => {
							this.#agentHub = hub;
							// The editor's double-← gesture that opened the hub consumed the first tap:
							// the next single ← dismisses it.
							if (options?.armCloseTap) hub.armCloseTap();
						},
					}),
				{
					focus: screen => firstOfKind(screen, "picker"),
					onClose: () => {
						this.#agentHub = undefined;
						viewer?.close();
					},
				},
			);
		};

		// The double-← gesture stays inert when neither live nor saved subagents
		// exist, so the gate waits for the saved-agent scan before deciding.
		if (!options?.requireContent || this.#hubHasAgents(runtime, observers)) {
			show();
			return;
		}
		void runtime
			.loadPersisted(() => !cancelled)
			.catch((error: unknown) => logger.warn("Failed to register persisted subagents", { error }))
			.then(() => {
				if (this.#hubHasAgents(runtime, observers)) show();
				else cancelled = true;
			});
	}

	/** Whether the hub would list any agent of this session (live or saved). */
	#hubHasAgents(
		runtime: Pick<AgentHubProps<AgentRef>, "registry" | "inSession">,
		observers: SessionObserverRegistry,
	): boolean {
		if (observers.getSessions().length > 0) return true;
		return runtime.registry.list().some(ref => ref.id !== MAIN_AGENT_ID && (runtime.inSession?.(ref) ?? true));
	}
}

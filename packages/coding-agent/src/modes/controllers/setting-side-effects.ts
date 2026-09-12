import { type ResizeScrollbackMode, setTerminalTextSizing, TERMINAL, setTuiTight } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { settings, type SettingPath, type Settings } from "../../config/settings";
import { disableProvider, enableProvider } from "../../discovery";
import type { MCPManager } from "../../mcp";
import { setColorBlindMode, setMarkdownMermaidRendering, setSymbolPreset, setTheme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import type { ConfiguredThinkingLevel } from "../../thinking";
import {
	isSearchProviderId,
	setExcludedSearchProviders,
	setImageProviderOrder,
	setSearchProviderOrder,
} from "../../tools";
import { applyHyperlinkSetting } from "../../tui/hyperlink";
import { setTerminalTitleStateEnabled } from "../../utils/title-generator";
import { AssistantMessageComponent } from "../components/assistant-message";
import { ReadToolGroupComponent } from "../components/read-tool-group";
import { ToolExecutionComponent } from "../components/tool-execution";
import type { InteractiveModeContext } from "../types";

export interface SettingSideEffectOptions {
	/**
	 * Whether persisting session setters write through to global config
	 * (`setSteeringMode` and friends, `setThinkingLevel`). Selector changes
	 * persist; replaying values that were just loaded from disk must not — a
	 * project-overlay value would be promoted into global config.
	 */
	persist?: boolean;
	/**
	 * When provided, the async mutations this apply launches (prompt rebuilds,
	 * think-tool re-registration, memory-backend swap) push their promises here
	 * so the caller can await completion. The fire-and-forget path leaves it
	 * undefined.
	 */
	pending?: Promise<unknown>[];
	/**
	 * Failure sink for async applies. The interactive mode surfaces apply
	 * failures in the transcript; protocol hosts (ACP/RPC) have no UI and
	 * omit the sink, which routes failures to the logger.
	 */
	onError?: (message: string) => void;
	/**
	 * Live MCP manager for the `mcp.notifications` apply: `setNotificationsEnabled`
	 * owns the subscribe/unsubscribe sweep across connected servers, so a replay
	 * reuses it instead of duplicating that logic. The interactive path reads
	 * `ctx.mcpManager` directly; protocol hosts thread their manager here
	 * (optional — hosts with no MCP configured skip the apply).
	 */
	mcpManager?: Pick<MCPManager, "setNotificationsEnabled">;
}

/**
 * Settings whose consumers cache the value on components or agent fields
 * instead of re-reading it per use. A settings reload swaps layers without
 * touching these caches, so `/reload-settings` replays each id through
 * {@link applySettingSideEffects} after the refresh.
 */
export const REPLAYED_SETTING_IDS = [
	"autocompleteMaxVisible",
	"tui.imeSafeCursor",
	"tui.vimMode",
	"tui.vimModeDisplay",
	"spelling.typoDetection",
	"spelling.autocomplete",
	"spelling.autocorrect",
	"display.hideToolActivity",
	"display.showTokenUsage",
	"display.showTurnTime",
	"display.cacheMissMarker",
	"display.collapseCompacted",
	"terminal.showImages",
	"hideThinkingBlock",
	"proseOnlyThinking",
	"tui.renderMermaid",
	"tui.tight",
	"tui.resizeScrollback",
	"tui.hyperlinks",
	"tui.maxInlineImages",
	"showHardwareCursor",
	"tui.textSizing",
	"tui.titleState",
	"composer.shape",
	"compaction.enabled",
	"compaction.idleEnabled",
	"compaction.idleThresholdTokens",
	"compaction.idleTimeoutSeconds",
	"recap.enabled",
	"recap.idleSeconds",
	"defaultThinkingLevel",
	"personality",
	"tools.xdevDocs",
	"externalThinking",
	"memory.backend",
	"mcp.notifications",
	"git.enabled",
	"statusLine.preset",
	"statusLine.separator",
	"statusLine.showHookStatus",
	"statusLine.sessionAccent",
	"statusLine.transparent",
	"statusLine.compactThinkingLevel",
	"statusLine.contextLine",
	"statusLine.leftSegments",
	"statusLine.rightSegments",
	"statusLine.segmentOptions",
] as const satisfies readonly SettingPath[];

/**
 * Applies the session-level side effects of one setting change against any
 * {@link AgentSession} — no interactive-mode context required. This is the
 * session subset of {@link applySettingSideEffects}'s switch, kept here so the
 * TUI path and the headless protocol hosts share one implementation instead of
 * drifting. Settings without a session-level effect (pure TUI caches, status
 * line, discovery) are ignored.
 */
export function applySessionSettingSideEffects(
	session: AgentSession,
	id: string,
	value: unknown,
	options: SettingSideEffectOptions = {},
): void {
	const report = (message: string): void => {
		if (options.onError) options.onError(message);
		else logger.warn(message);
	};
	switch (id) {
		case "thinkingLevel":
		case "defaultThinkingLevel":
			session.setThinkingLevel(value as ConfiguredThinkingLevel, options.persist ?? true);
			break;
		case "personality": {
			const rebuild = session.refreshBaseSystemPrompt().catch(err => {
				report(`Failed to apply personality: ${err}`);
			});
			options.pending?.push(rebuild);
			break;
		}
		case "tools.xdevDocs": {
			const rebuild = session.refreshBaseSystemPrompt().catch(err => {
				report(`Failed to apply xd:// prompt docs setting: ${err}`);
			});
			options.pending?.push(rebuild);
			break;
		}
		case "memory.backend": {
			const backend = session.applyMemoryBackend().catch(err => {
				report(`Failed to apply memory backend: ${err}`);
			});
			options.pending?.push(backend);
			break;
		}
		case "externalThinking": {
			const thinkTool = session.setThinkToolEnabled(value as boolean).catch(err => {
				report(`Failed to apply external thinking: ${err}`);
			});
			options.pending?.push(thinkTool);
			break;
		}
		case "mcp.notifications":
			options.mcpManager?.setNotificationsEnabled(value as boolean);
			break;
	}
}

/**
 * Snapshots every replayed id's current value so a host can diff the settings
 * a command actually changed. Capture this before the command runs; pass the
 * map to {@link replaySessionSettingSideEffects} so a no-op reload replays
 * nothing instead of clobbering session-only overrides (a Shift+Tab thinking
 * level, a session-scoped model) with unchanged disk values.
 */
export function snapshotReplaySettings(snapshotSettings: Settings): Map<string, unknown> {
	return new Map(REPLAYED_SETTING_IDS.map(id => [id, snapshotSettings.get(id)]));
}

/**
 * Replays the allowlisted settings whose value changed since `before` against
 * `session` after a settings reload, resolving only after the async mutations
 * (prompt rebuilds, think-tool re-registration, memory-backend swap) have
 * settled — a protocol host must not acknowledge the reload, or accept the
 * next prompt, while the previous tool set or memory backend is still live.
 * Apply failures never reject the replay: they are routed to the logger just
 * like the fire-and-forget path. The TUI adapter replays the full list
 * through {@link applySettingSideEffects} (component caches included); the
 * protocol hosts (ACP/RPC) have no interactive components, so the session
 * subset is what applies there — filtered through the same before/after diff
 * the TUI adapter applies, or a no-op `/reload-settings` would reset a
 * session-only thinking level and append a `thinking_level_change`. Always
 * `persist: false` — the values were just loaded from disk, and a
 * project-overlay value must not be promoted into global config.
 * Hosts with a live MCP manager thread it through `options.mcpManager` so a
 * changed `mcp.notifications` reuses `MCPManager.setNotificationsEnabled`.
 */
export async function replaySessionSettingSideEffects(
	session: AgentSession,
	before: ReadonlyMap<string, unknown>,
	options: SettingSideEffectOptions = {},
): Promise<void> {
	const pending: Promise<unknown>[] = [];
	for (const id of REPLAYED_SETTING_IDS) {
		const value = session.settings.get(id);
		if (Bun.deepEquals(before.get(id), value)) continue;
		applySessionSettingSideEffects(session, id, value, { ...options, persist: false, pending });
	}
	await Promise.all(pending);
}

/**
 * Applies the live side effects of one setting change against the interactive
 * mode context. Shared by the settings selector (`handleSettingChange`) and
 * the TUI slash-command adapter's `notifyConfigChanged` so both paths run the
 * same applies — a second partial implementation would drift.
 *
 * Session-managed queue modes and thinking level honor `options.persist`;
 * callers replaying freshly loaded values pass `persist: false`.
 */
export function applySettingSideEffects(
	ctx: InteractiveModeContext,
	id: string,
	value: unknown,
	options: SettingSideEffectOptions = {},
): void {
	const persist = options.persist ?? true;

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
			ctx.session.setAutoCompactionEnabled(value as boolean);
			ctx.statusLine.setAutoCompactEnabled(value as boolean);
			break;
		case "compaction.enabled":
			// The status line snapshots the effective flag at construction
			// (interactive-mode) to gate the context bar's compaction boundary
			// markers; the session's own gating re-reads the setting live. Push
			// the effective getter so a value enabled but methodless still reads
			// as off, matching the construction-time snapshot's semantics.
			ctx.statusLine.setAutoCompactEnabled(ctx.session.autoCompactionEnabled);
			break;
		case "compaction.idleEnabled":
		case "compaction.idleThresholdTokens":
		case "compaction.idleTimeoutSeconds":
			ctx.eventController.refreshIdleCompactionTimer();
			break;
		case "recap.enabled":
		case "recap.idleSeconds":
			ctx.eventController.refreshIdleRecapTimer();
			break;
		case "composer.shape":
			ctx.syncComposerShape();
			break;
		case "advisor.enabled":
			ctx.session.setAdvisorEnabled(value as boolean);
			ctx.statusLine.invalidate();
			ctx.ui.requestRender();
			break;
		case "advisor.maxNotesPerUpdate":
			if (ctx.session.isAdvisorEnabled()) {
				ctx.session.setAdvisorEnabled(true);
				ctx.ui.requestRender();
			}
			break;
		case "steeringMode":
			ctx.session.setSteeringMode(value as "all" | "one-at-a-time", persist);
			break;
		case "followUpMode":
			ctx.session.setFollowUpMode(value as "all" | "one-at-a-time", persist);
			break;
		case "interruptMode":
			ctx.session.setInterruptMode(value as "immediate" | "wait", persist);
			break;
		case "thinkingLevel":
		case "defaultThinkingLevel":
			applySessionSettingSideEffects(ctx.session, id, value, { persist, onError: msg => ctx.showError(msg) });
			ctx.statusLine.invalidate();
			ctx.updateEditorBorderColor();
			break;
		case "personality":
		case "tools.xdevDocs":
		case "memory.backend":
		case "externalThinking":
			applySessionSettingSideEffects(ctx.session, id, value, {
				persist,
				onError: msg => ctx.showError(msg),
				pending: options.pending,
			});
			break;

		case "autocompleteMaxVisible":
			ctx.editor.setAutocompleteMaxVisible(typeof value === "number" ? value : Number(value));
			break;
		case "tui.imeSafeCursor":
			ctx.editor.setImeSafeCursorLayout(value === true);
			break;
		case "tui.vimMode":
		case "tui.vimModeDisplay":
			ctx.applyVimModeSetting();
			break;
		case "display.pinnedAgents":
			ctx.applyPinnedAgentsSetting();
			break;
		case "spelling.typoDetection":
		case "spelling.autocomplete":
		case "spelling.autocorrect":
			ctx.syncEditorSpelling();
			ctx.ui.requestRender();
			break;

		// Settings with UI side effects
		case "display.hideToolActivity": {
			const hidden = value as boolean;
			ctx.hideToolActivity = hidden;
			if (!hidden) ctx.toolOutputExpanded = false;
			for (const child of ctx.chatContainer.children) {
				if (!hidden && (child instanceof ToolExecutionComponent || child instanceof ReadToolGroupComponent)) {
					child.setExpanded(false);
				} else if (child instanceof AssistantMessageComponent) {
					child.setToolResultImagesVisible(!hidden);
				}
			}
			ctx.chatContainer.setToolActivityVisible(!hidden);
			if (hidden) ctx.ui.clearInlineImages();
			// Match the shortcut path: visibility changes must rebuild retired terminal history.
			ctx.ui.resetDisplay();
			break;
		}
		case "terminal.showImages":
		case "showImages": {
			const visible = value as boolean;
			for (const child of ctx.chatContainer.children) {
				if (child instanceof ToolExecutionComponent) {
					child.setShowImages(visible);
				} else if (child instanceof AssistantMessageComponent) {
					child.setImagesVisible(visible);
				}
			}
			if (!visible) ctx.ui.clearInlineImages();
			ctx.ui.requestRender(true);
			break;
		}
		case "hideThinkingBlock":
			ctx.hideThinkingBlock = value as boolean;
			for (const child of ctx.chatContainer.children) {
				if (child instanceof AssistantMessageComponent) {
					child.setHideThinkingBlock(ctx.effectiveHideThinkingBlock);
				}
			}
			ctx.ui.requestRender(true);
			break;
		case "proseOnlyThinking":
			ctx.proseOnlyThinking = value as boolean;
			for (const child of ctx.chatContainer.children) {
				if (child instanceof AssistantMessageComponent) {
					child.setProseOnlyThinking(value as boolean);
				}
			}
			ctx.ui.requestRender(true);
			break;
		case "omitThinking":
			ctx.session.agent.hideThinkingSummary = value as boolean;
			break;
		case "display.cacheMissMarker":
			// Rebuild re-runs the usage-based detection under the new setting so
			// markers appear/disappear; full reset retires any already committed
			// to native scrollback (mirrors hideThinking).
			ctx.rebuildChatFromMessages();
			ctx.ui.resetDisplay();
			break;
		case "display.collapseCompacted":
			// Rebuild swaps between the collapsed tail and the full inline
			// history; full reset retires blocks already committed to native
			// scrollback (mirrors cacheMissMarker).
			ctx.rebuildChatFromMessages();
			ctx.ui.resetDisplay();
			break;
		case "display.showTokenUsage":
			// Rebuild reruns usage-row detection under the new setting; resetDisplay
			// retires rows already committed to native scrollback.
			ctx.rebuildChatFromMessages();
			ctx.ui.resetDisplay();
			break;
		case "display.showTurnTime":
			// Same as showTokenUsage: the prompt→yield delta lives in the same
			// usage row, so toggling it must rebuild and retire committed rows.
			ctx.rebuildChatFromMessages();
			ctx.ui.resetDisplay();
			break;
		case "tui.tight":
			setTuiTight(value as boolean);
			ctx.ui.invalidate();
			ctx.ui.requestRender();
			break;
		case "tui.resizeScrollback":
			ctx.ui.setResizeScrollback(value as ResizeScrollbackMode);
			break;

		case "tui.hyperlinks":
			applyHyperlinkSetting(value as "off" | "auto" | "always");
			ctx.ui.invalidate();
			ctx.statusLine.invalidate();
			ctx.ui.requestRender();
			break;

		case "tui.maxInlineImages":
			ctx.ui.setMaxInlineImages(typeof value === "number" ? value : Number(value));
			break;
		case "showHardwareCursor":
			ctx.ui.setShowHardwareCursor(value === true);
			ctx.editor.setUseTerminalCursor(value === true);
			break;
		case "tui.textSizing":
			// Same resolve as startup: OSC 66 text-sizing is Kitty-only, so gate the
			// setting on the terminal's static capability instead of emitting raw
			// escape sequences on terminals without support.
			setTerminalTextSizing(value === true && TERMINAL.supportsTextSizing);
			ctx.ui.invalidate();
			ctx.ui.requestRender();
			break;
		case "tui.titleState":
			setTerminalTitleStateEnabled(value === true);
			break;

		case "tui.renderMermaid": {
			setMarkdownMermaidRendering(value as boolean);
			const rebuild = ctx.session.refreshBaseSystemPrompt().catch(err => {
				ctx.showError(`Failed to apply Mermaid rendering setting: ${err}`);
			});
			options.pending?.push(rebuild);
			ctx.rebuildChatFromMessages();
			ctx.ui.resetDisplay();
			break;
		}

		case "theme": {
			setTheme(value as string, true).then(result => {
				ctx.statusLine.invalidate();
				ctx.ui.requestRender();
				ctx.ui.invalidate();
				if (!result.success) {
					ctx.showError(`Failed to load theme "${value}": ${result.error}\nFell back to dark theme.`);
				}
			});
			break;
		}
		case "symbolPreset": {
			setSymbolPreset(value as "unicode" | "nerd" | "ascii").then(() => {
				ctx.statusLine.invalidate();
				ctx.ui.requestRender();
				ctx.ui.invalidate();
			});
			break;
		}
		case "colorBlindMode": {
			setColorBlindMode(value === "true" || value === true).then(() => {
				ctx.ui.invalidate();
			});
			break;
		}
		case "temperature": {
			const temp = typeof value === "number" ? value : Number(value);
			ctx.session.agent.temperature = temp >= 0 ? temp : undefined;
			break;
		}
		case "topP": {
			const topP = typeof value === "number" ? value : Number(value);
			ctx.session.agent.topP = topP >= 0 ? topP : undefined;
			break;
		}
		case "topK": {
			const topK = typeof value === "number" ? value : Number(value);
			ctx.session.agent.topK = topK >= 0 ? topK : undefined;
			break;
		}
		case "minP": {
			const minP = typeof value === "number" ? value : Number(value);
			ctx.session.agent.minP = minP >= 0 ? minP : undefined;
			break;
		}
		case "presencePenalty": {
			const presencePenalty = typeof value === "number" ? value : Number(value);
			ctx.session.agent.presencePenalty = presencePenalty >= 0 ? presencePenalty : undefined;
			break;
		}
		case "repetitionPenalty": {
			const repetitionPenalty = typeof value === "number" ? value : Number(value);
			ctx.session.agent.repetitionPenalty = repetitionPenalty >= 0 ? repetitionPenalty : undefined;
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
		case "statusLine.contextLine":
		case "statusLine.leftSegments":
		case "statusLine.rightSegments":
		case "statusLine.segmentOptions":
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
				contextLine: settings.get("statusLine.contextLine"),
			};
			ctx.statusLine.updateSettings(statusLineSettings);
			ctx.ui.requestRender();
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
			ctx.mcpManager?.setNotificationsEnabled(value as boolean);
			break;

		// All other settings are handled by the definitions (get/set on SettingsManager)
		// No additional side effects needed
	}
}

/**
 * Applies one setting's live side effects and resolves only after the
 * asynchronous mutations complete (prompt rebuilds, think-tool
 * re-registration, memory-backend swap). The interactive selector keeps using
 * {@link applySettingSideEffects} fire-and-forget; the `/reload-settings`
 * replay awaits this so a reloaded setting is reported applied only once its
 * side effect has landed.
 */
export async function applySettingSideEffectsAwaitingCompletion(
	ctx: InteractiveModeContext,
	id: string,
	value: unknown,
	options: SettingSideEffectOptions = {},
): Promise<void> {
	const pending: Promise<unknown>[] = [];
	applySettingSideEffects(ctx, id, value, { ...options, pending });
	await Promise.all(pending);
}

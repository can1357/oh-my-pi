import { type ResizeScrollbackMode, setTuiTight } from "@oh-my-pi/pi-tui";
import { settings } from "../../config/settings";
import { disableProvider, enableProvider } from "../../discovery";
import { setColorBlindMode, setMarkdownMermaidRendering, setSymbolPreset, setTheme } from "../../modes/theme/theme";
import type { ConfiguredThinkingLevel } from "../../thinking";
import {
	isSearchProviderId,
	setExcludedSearchProviders,
	setImageProviderOrder,
	setSearchProviderOrder,
} from "../../tools";
import { applyHyperlinkSetting } from "../../tui/hyperlink";
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
	"composer.shape",
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
] as const;

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
		case "composer.shape":
			ctx.syncComposerShape();
			break;
		case "advisor.enabled":
			ctx.session.setAdvisorEnabled(value as boolean);
			ctx.statusLine.invalidate();
			ctx.ui.requestRender();
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
			ctx.session.setThinkingLevel(value as ConfiguredThinkingLevel, persist);
			ctx.statusLine.invalidate();
			ctx.updateEditorBorderColor();
			break;
		case "personality":
			void ctx.session.refreshBaseSystemPrompt().catch(err => {
				ctx.showError(`Failed to apply personality: ${err}`);
			});
			break;
		case "tools.xdevDocs":
			void ctx.session.refreshBaseSystemPrompt().catch(err => {
				ctx.showError(`Failed to apply xd:// prompt docs setting: ${err}`);
			});
			break;
		case "memory.backend":
			void ctx.session.applyMemoryBackend().catch(err => {
				ctx.showError(`Failed to apply memory backend: ${err}`);
			});
			break;
		case "inspect_image.mode":
			void ctx.session.applyInspectImageModeChange().catch(err => {
				ctx.showError(`Failed to apply vision mode: ${err}`);
			});
			break;
		case "externalThinking":
			void ctx.session.setThinkToolEnabled(value as boolean).catch(err => {
				ctx.showError(`Failed to apply external thinking: ${err}`);
			});
			break;

		case "autocompleteMaxVisible":
			ctx.editor.setAutocompleteMaxVisible(typeof value === "number" ? value : Number(value));
			break;
		case "tui.imeSafeCursor":
			ctx.editor.setImeSafeCursorLayout(value === true);
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
			ctx.ui.requestRender(true);
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

		case "tui.renderMermaid":
			setMarkdownMermaidRendering(value as boolean);
			ctx.session.refreshBaseSystemPrompt().catch(err => {
				ctx.showError(`Failed to apply Mermaid rendering setting: ${err}`);
			});
			ctx.rebuildChatFromMessages();
			ctx.ui.resetDisplay();
			break;

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

import { clearSubmittedText, restoreDetachedDraft } from "./helpers/draft";
import * as path from "node:path";
import { reloadTuiPluginState } from "./builtin-marketplace";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { prompt } from "@oh-my-pi/pi-utils";
import {
	formatModelString,
	getModelMatchPreferences,
	resolveCliModel,
	type ResolveCliModelResult,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import {
	applyModelPreset,
	deleteModelPreset,
	formatModelPresetSwitch,
	getModelPresetNames,
	isCleanModelPresetSwitch,
	isValidModelPresetName,
	modelPresetSavedMessage,
	type ModelPresetSession,
	saveModelPreset,
} from "../config/model-presets";
import { describeLoopCondition } from "../modes/loop-condition";
import { describeLoopLimitRuntime } from "../modes/loop-limit";
import type { InteractiveModeContext } from "../modes/types";
import ratchetKickoffPrompt from "../prompts/ratchet-kickoff.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { CLI_THINKING_LEVELS, getConfiguredThinkingLevelMetadata } from "@oh-my-pi/pi-tui/thinking";
import { noThinkingMessage, resolveThinkingArgument } from "./helpers/effort";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { handleSecurityCommand } from "./helpers/security";
import type { ParsedSlashCommand, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";

import {
	cfgComputerDisplay,
	cfgComputerEnabled,
	cfgComputerMaxHeight,
	cfgComputerMaxWidth,
	cfgRatchetEnabled,
} from "../tools/settings";
import { cfgSkillful } from "../session/settings";
import { formatSlowModeResetClock } from "../session/anthropic-slow-mode";
import { cfgExtendedContext } from "../session/context-settings";
import { cfgGoalEnabled } from "../goals/settings";
import { cfgPlanEnabled } from "../plan-mode/settings";

export function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

/**
 * Resolve a `/model` / `/switch` selector the way `omp bench` and `--model`
 * do: exact `provider/id`, fuzzy ids (`opus`), role aliases (`@smol`, `smol`),
 * and `:level` thinking suffixes. Unqualified selectors prefer the session's
 * `--models` scope, else the authenticated set, before the full catalog.
 */
function resolveSessionModelSelector(
	selector: string,
	session: AgentSession,
	settings: Settings,
): ResolveCliModelResult {
	const scoped = session.scopedModels.map(entry => entry.model);
	return resolveCliModel({
		cliModel: selector,
		modelRegistry: session.modelRegistry,
		availableModels: scoped.length > 0 ? scoped : undefined,
		settings,
		preferences: getModelMatchPreferences(settings),
	});
}
/**
 * Split `/model` args into a model selector and an optional
 * `--context-window <tokens>` override (issue #12578). Returns
 * `contextWindow: NaN` for unparseable values so the caller can report usage.
 */
function parseModelArgs(args: string): { selector: string; contextWindow: number | undefined } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let contextWindow: number | undefined;
	const selectorParts: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token === "--context-window" || token === "--context") {
			const raw = tokens[index + 1];
			index++;
			const parsed = raw !== undefined ? Number(raw.replaceAll("_", "").replace(/k$/i, "000")) : NaN;
			contextWindow = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : NaN;
			continue;
		}
		const inline = /^(?:--context-window|--context)=(.+)$/.exec(token);
		if (inline) {
			const parsed = Number(inline[1]!.replaceAll("_", "").replace(/k$/i, "000"));
			contextWindow = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : NaN;
			continue;
		}
		selectorParts.push(token);
	}
	return { selector: selectorParts.join(" "), contextWindow };
}

async function runWithDetachedModeDraft(
	command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
	run: () => Promise<boolean>,
): Promise<void> {
	const { editor } = runtime.ctx;
	if (!runtime.draftDetached) editor.clearDraft();
	try {
		const submitted = await run();
		const hasAttachments = (runtime.input?.images?.length ?? 0) > 0 || (runtime.input?.imageLinks?.length ?? 0) > 0;
		if (!submitted && hasAttachments) {
			if (runtime.draftDetached) {
				// Newer typing may already sit in the editor: merge the submission
				// back beside it so each draft's image markers keep their images.
				restoreDetachedDraft(editor, command.text, runtime.input?.images, runtime.input?.imageLinks);
				return;
			}
			editor.pendingImages = [...(runtime.input?.images ?? []), ...editor.pendingImages];
			editor.pendingImageLinks = [
				...(runtime.input?.imageLinks ?? runtime.input?.images?.map(() => undefined) ?? []),
				...editor.pendingImageLinks,
			];
			editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		}
	} catch (error) {
		if (runtime.draftDetached) {
			// The caller already took this draft out of the editor before
			// dispatch (Ctrl+Enter's `handleFollowUp`, or `onSubmit` for these
			// mode commands); it owns restoring the submission and reporting
			// the error so a submission that failed after newer text was typed
			// merges with it once, instead of being silently dropped here.
			throw error;
		}
		if (!editor.getText() && editor.pendingImages.length === 0) {
			editor.setText(command.text);
			editor.pendingImages = runtime.input?.images ? [...runtime.input.images] : [];
			editor.pendingImageLinks = runtime.input?.imageLinks ? [...runtime.input.imageLinks] : [];
			editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		}
		runtime.ctx.showError(error instanceof Error ? error.message : String(error));
	}
}

/** `/fast status` label for the active model: "ultra" for the Ultrafast tier, "on" for priority, else "off". */
function formatFastModeStatus(session: AgentSession): string {
	if (session.isUltrafastModeEnabled()) return "ultra";
	return session.isFastModeEnabled() ? "on" : "off";
}

const FAST_USAGE = "Usage: /fast [on|ultra|off|status]";

/**
 * `/fast [on|ultra|off|status]` for the active model: `on` selects the
 * family's `priority` tier, `ultra` the OpenAI `ultrafast` tier, `off` clears
 * either. Bare invocation toggles between off and priority. Returns the
 * user-facing reply, or `undefined` for an unknown argument.
 */
function runFastCommand(arg: string, session: AgentSession): string | undefined {
	switch (arg) {
		case "":
		case "toggle":
			return `Fast mode ${session.toggleFastMode() ? "enabled" : "disabled"}.`;
		case "on":
			return session.setFastMode(true) ? "Fast mode enabled." : "Fast mode is unavailable for the current model.";
		case "ultra":
		case "ultrafast":
			return session.setUltrafastMode(true)
				? "Ultrafast mode enabled."
				: "Ultrafast is unavailable for the current model.";
		case "off":
			session.setFastMode(false);
			return "Fast mode disabled.";
		case "status":
			return `Fast mode is ${formatFastModeStatus(session)}.`;
		default:
			return undefined;
	}
}

const SLOW_UNSUPPORTED =
	"The current model has no slow mode: /slow uses the flex tier on OpenAI/Google models and low priority on Anthropic subscriptions.";

/**
 * `/slow [on|off|status]` for the active model: the `flex` service tier on
 * OpenAI/Google, subscription low priority (`providers.anthropic.slowMode`
 * `auto`/`off`) on Anthropic. Bare invocation toggles. Returns the user-facing
 * reply, or `undefined` for an unknown argument.
 */
function runSlowCommand(arg: string, session: AgentSession): string | undefined {
	if (arg !== "" && arg !== "toggle" && arg !== "on" && arg !== "off" && arg !== "status") return undefined;
	const anthropic = session.model?.provider === "anthropic";
	if (arg === "status") {
		const label = anthropic ? session.getAnthropicSlowModeLabel() : undefined;
		if (!session.isSlowModeEnabled()) return label ? `Slow mode is off (${label}).` : "Slow mode is off.";
		if (!anthropic) return "Slow mode is on (flex tier).";
		return label ? `Slow mode is on (${label}).` : "Slow mode is on (low priority at the Claude session limit).";
	}
	const enabled = arg === "on" || (arg !== "off" && !session.isSlowModeEnabled());
	if (!session.setSlowMode(enabled)) return SLOW_UNSUPPORTED;
	if (!session.isSlowModeEnabled()) {
		return anthropic
			? "Slow mode off: at your Claude usage limit, requests may get a short wrap-up allowance, then wait for the limit to reset."
			: "Slow mode off.";
	}
	if (!anthropic) return "Slow mode on: requests use the flex tier (lower cost, higher latency).";
	const resetsAtSec = session.getAnthropicSlowModeLane()?.activeResetsAtSec();
	return resetsAtSec !== undefined
		? `Slow mode on: continuing at low priority until your limit resets at ${formatSlowModeResetClock(resetsAtSec)}. Your weekly limit still applies, and responses may pause while waiting for spare capacity.`
		: "Slow mode on: when your Claude subscription hits its session limit and Anthropic offers low priority, requests switch to it after any wrap-up allowance.";
}

/** `/extended-context status` label for the premium long-context window setting. */
function formatExtendedContextStatus(settings: Settings): string {
	return cfgExtendedContext.get(settings) ? "on" : "off";
}

/** Applies an `/extended-context` argument and returns its operator feedback. */
function applyExtendedContextCommand(settings: Settings, args: string): string | undefined {
	const arg = args.trim().toLowerCase();
	const current = cfgExtendedContext.get(settings);
	if (!arg || arg === "toggle") {
		const enabled = !current;
		cfgExtendedContext.set(settings, enabled);
		return `Extended context ${enabled ? "enabled" : "disabled"}.`;
	}
	if (arg === "on") {
		cfgExtendedContext.set(settings, true);
		return "Extended context enabled.";
	}
	if (arg === "off") {
		cfgExtendedContext.set(settings, false);
		return "Extended context disabled.";
	}
	if (arg === "status") return `Extended context is ${formatExtendedContextStatus(settings)}.`;
	return undefined;
}

/** Detailed, session-effective `/computer status` diagnostics. */
function formatComputerUseStatus(session: AgentSession): string {
	const enabled = cfgComputerEnabled.get(session.settings);
	const active = session.getEvalPreludes().some(definition => definition.name === "computer");
	const configured = {
		display: cfgComputerDisplay.get(session.settings),
		maxWidth: cfgComputerMaxWidth.get(session.settings),
		maxHeight: cfgComputerMaxHeight.get(session.settings),
	};
	return [
		`Computer use: ${enabled ? "enabled" : "disabled"}`,
		`prelude: ${active ? "active" : "inactive"}`,
		`configured: display=${configured.display}, maxWidth=${configured.maxWidth}, maxHeight=${configured.maxHeight}`,
	].join(" · ");
}

/**
 * Apply a session-scoped computer-use toggle; the session's setting listener
 * reconciles the prompt without a mid-session cache-busting rebuild.
 * The override is never persisted to settings.json.
 */
function applyComputerUseToggle(session: AgentSession, enable: boolean): string {
	const previous = cfgComputerEnabled.get(session.settings);
	cfgComputerEnabled.override(session.settings, enable);
	if (enable && !session.getEvalPreludes().some(definition => definition.name === "computer")) {
		cfgComputerEnabled.override(session.settings, previous);
		return "Computer use is unavailable in this session.";
	}
	return enable
		? `Computer use enabled for this session. ${formatComputerUseStatus(session)}`
		: "Computer use disabled for this session.";
}

/** Tools the ratchet loop needs: the eval kernel hosts `ratchet()`, `task` runs its analyzer. */
const RATCHET_REQUIRED_TOOLS = ["eval", "task"] as const;

/**
 * Arm `/ratchet`: enable the ratchet prelude for this session (override, never persisted) and
 * render the kickoff prompt carrying the user's request as data.
 */
function prepareRatchet(session: AgentSession, request: string): { kickoff: string } | { error: string } {
	const tools = session.getEnabledToolNames();
	const missing = RATCHET_REQUIRED_TOOLS.filter(tool => !tools.includes(tool));
	if (missing.length > 0) return { error: `/ratchet needs the ${missing.join(" and ")} tool active.` };
	const previous = cfgRatchetEnabled.get(session.settings);
	if (!previous) cfgRatchetEnabled.override(session.settings, true);
	if (!session.getEvalPreludes().some(definition => definition.name === "ratchet")) {
		if (!previous) cfgRatchetEnabled.override(session.settings, previous);
		return { error: "The ratchet eval prelude is unavailable in this session." };
	}
	const kickoff = prompt.render(ratchetKickoffPrompt, { request: request.trim() || undefined, tools }).trim();
	return { kickoff };
}

const AUTOCOMPLETE_DETAIL_LIMIT = 48;

function shortDetail(value: string, limit = AUTOCOMPLETE_DETAIL_LIMIT): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit - 1)}…`;
}

export function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

/**
 * Shared `/model` body for both dispatchers.
 *
 * The TUI dispatcher prefers `handleTui` over `handle`, so the picker shortcut and
 * this parser cannot both live in anonymous spec fields: the argument path would be
 * unreachable from the TUI. Both entries point here instead.
 */
async function handleModelCommand(command: ParsedSlashCommand, runtime: SlashCommandRuntime) {
	const { selector, contextWindow } = parseModelArgs(command.args);
		if (contextWindow !== undefined && !Number.isInteger(contextWindow)) {
			return usage(
				`Invalid context window: ${command.args.trim()}. Use /model [<selector>] [--context-window <tokens>].`,
				runtime,
			);
		}
		if (selector) {
			const resolved = resolveSessionModelSelector(selector, runtime.session, runtime.settings);
			const match = resolved.model;
			if (!match) {
				return usage(
					`Unknown model: ${selector}. Use ACP \`session/setModel\` for picker-driven selection or list available models with /model.`,
					runtime,
				);
			}
			try {
				await runtime.session.setModel(contextWindow !== undefined ? { ...match, contextWindow } : match);
				if (resolved.thinkingLevel !== undefined) runtime.session.setThinkingLevel(resolved.thinkingLevel);
				await runtime.output(
					`Model set to ${match.provider}/${match.id}${contextWindow !== undefined ? ` with ${contextWindow.toLocaleString()}-token context.` : "."}`,
				);
				await runtime.notifyTitleChanged?.();
				await runtime.notifyConfigChanged?.();
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to set model: ${errorMessage(err)}`, runtime);
			}
		}
		if (contextWindow !== undefined) {
			const model = runtime.session.model;
			if (!model) return usage("No model is currently selected.", runtime);
			try {
				await runtime.session.setModel({ ...model, contextWindow });
				await runtime.output(
					`Context window set to ${contextWindow.toLocaleString()} tokens for ${model.provider}/${model.id} (this session).`,
				);
				await runtime.notifyTitleChanged?.();
				await runtime.notifyConfigChanged?.();
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to set context window: ${errorMessage(err)}`, runtime);
			}
		}
		const model = runtime.session.model;
		await runtime.output(
			model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
		);
		return commandConsumed();
}

export const BUILTIN_MODE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "security",
		icon: "shield",
		description: "Plan, run, inspect, import, and compare OMP-native security scans",
		allowArgs: true,
		acpInputHint: "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
		subcommands: [
			{ name: "plan", description: "Create an immutable security scan plan" },
			{ name: "scan", description: "Start a planned or newly planned native scan" },
			{ name: "status", description: "Show native scan operation status" },
			{ name: "cancel", description: "Cancel a running native scan" },
			{ name: "scans", description: "List stored project security scans" },
			{ name: "show", description: "Render a scan or security:// resource" },
			{ name: "import", description: "Import SARIF or a Codex Security bundle" },
			{ name: "export", description: "Export a canonical bundle, SARIF, or report" },
			{ name: "validate", description: "Validate one finding with OMP-native tools" },
			{ name: "compare", description: "Compare finding lineage across two scans" },
			{ name: "disposition", description: "Set a finding disposition with rationale" },
		],
		handle: handleSecurityCommand,
	},
	{
		name: "settings",
		icon: "settings",
		description: "Open settings menu",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "setup",
		aliases: ["providers"],
		icon: "gear",
		description: "Open provider setup",
		allowArgs: true,
		subcommands: [{ name: "providers", description: "Configure sign-in and web search providers" }],
		handleTui: async (command, runtime) => {
			const args = command.args.trim().toLowerCase();
			const opensProviders = args === "" || args === "providers";
			if (opensProviders) {
				await runtime.ctx.showProviderSetup();
			} else {
				runtime.ctx.showWarning(`Usage: /${command.name} [providers]`);
			}
			clearSubmittedText(runtime);
		},
	},
	{
		name: "plan",
		icon: "plan",
		description: "Toggle plan mode (agent plans before executing)",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!cfgPlanEnabled.get(runtime.ctx.settings)) return "Plan: disabled in settings";
			if (runtime.ctx.planModeEnabled) {
				const planFile = runtime.ctx.planModePlanFilePath;
				return `Plan: on${planFile ? ` (${path.basename(planFile)})` : ""}`;
			}
			if (runtime.ctx.goalModeEnabled) return "Plan: blocked by goal mode";
			return "Plan: off";
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handlePlanModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "plan-review",
		icon: "plan",
		description: "Re-open the plan review for the latest plan (plan mode only)",
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.planModeEnabled ? "Plan review: available" : "Plan review: plan mode inactive",
		handleTui: async (_command, runtime) => {
			await runtime.ctx.openPlanReview();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "vibe",
		icon: "wave",
		description: "Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.vibeModeEnabled) return "Vibe: on";
			if (runtime.ctx.planModeEnabled) return "Vibe: blocked by plan mode";
			if (runtime.ctx.goalModeEnabled) return "Vibe: blocked by goal mode";
			return "Vibe: off";
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleVibeModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "goal",
		icon: "goal",
		description: "Toggle goal mode (persistent autonomous objective for this session)",
		subcommands: [
			{ name: "set", description: "Set or replace the goal", usage: "<objective>" },
			{ name: "show", description: "Show current goal details" },
			{ name: "pause", description: "Pause the current goal" },
			{ name: "resume", description: "Resume a paused goal" },
			{ name: "drop", description: "Drop the current goal" },
			{ name: "budget", description: "Adjust the token budget", usage: "<N|off>" },
		],
		inlineHint: "[objective]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!cfgGoalEnabled.get(runtime.ctx.settings)) return "Goal: disabled in settings";
			if (runtime.ctx.planModeEnabled) return "Goal: blocked by plan mode";
			const state = runtime.ctx.session.getGoalModeState();
			return state ? `Goal: ${state.goal.status} (${shortDetail(state.goal.objective)})` : "Goal: off";
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleGoalModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "guided-goal",
		icon: "compass",
		description: "Have the agent interview you in chat, then set up goal mode",
		inlineHint: "[rough objective]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleGuidedGoalCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "loop",
		icon: "loop",
		get description() {
			return `Toggle loop mode. While enabled, the next prompt you send re-submits after every yield. Bound it with a count/duration, or gate it with \`--until '<cmd>'\` / \`--while '<cmd>'\` — the command's exit status decides whether the next iteration runs. ${formatKeyHint("escape")} suspends the ongoing loop; /loop again to disable.`;
		},
		inlineHint: "[count|duration] [--while|--until '<cmd>'] [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.loopModeEnabled) return "Loop: off";
			if (runtime.ctx.loopModePaused) return "Loop: paused";
			const bounds = [
				runtime.ctx.loopLimit ? describeLoopLimitRuntime(runtime.ctx.loopLimit) : undefined,
				runtime.ctx.loopCondition ? describeLoopCondition(runtime.ctx.loopCondition) : undefined,
			].filter((part): part is string => part !== undefined);
			if (bounds.length > 0) return `Loop: on (${bounds.join(", ")})`;
			if (runtime.ctx.loopPrompt) return "Loop: on (repeating prompt)";
			return "Loop: on (waiting for next prompt)";
		},
		handleTui: async (command, runtime) => {
			const prompt = await runtime.ctx.handleLoopCommand(command.args);
			clearSubmittedText(runtime);
			// Surface any inline prompt so the dispatcher returns it and the normal
			// submit flow runs the first loop iteration (recording it as the loop prompt).
			if (prompt) return { prompt };
		},
	},
	{
		name: "queue",
		icon: "inbox",
		description: "Queue a message for after the agent yields",
		inlineHint: "<message>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleQueueCommand(
				command.args,
				runtime.draftDetached ? { ...runtime.input, text: command.text } : undefined,
			);
		},
	},
	{
		name: "model",
		aliases: ["models"],
		icon: "model",
		allowArgs: true,
		description: "Switch model for this session",
		acpDescription: "Show current model selection",
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? `Model: ${model.provider}/${model.id}` : "Model: none selected";
		},
		handle: handleModelCommand,
		handleTui: (command, runtime) => {
			// Anything with arguments has to reach the shared handler, otherwise
			// `/model --context-window 400k` drops the flag and opens the picker.
			if (command.args.trim()) {
				const ctx = runtime.ctx;
				return handleModelCommand(command, {
					session: ctx.session,
					sessionManager: ctx.sessionManager,
					settings: ctx.settings,
					cwd: ctx.sessionManager.getCwd(),
					output: (text: string) => {
						ctx.showStatus(text);
					},
					refreshCommands: () => ctx.refreshSlashCommandState(),
					reloadPlugins: () => reloadTuiPluginState(ctx),
				});
			}
			runtime.ctx.showModelSelector();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "switch",
		icon: "swap",
		get description() {
			return `Switch model for this session (same as ${formatKeyHint("alt+p")}); accepts fuzzy ids, provider/id, @role, :level`;
		},
		acpDescription: "Switch model for this session only",
		acpInputHint: "[model]",
		inlineHint: "[model]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? `Model: ${model.provider}/${model.id}` : "Model: none selected";
		},
		handle: async (command, runtime) => {
			const selector = command.args.trim();
			if (!selector) {
				const model = runtime.session.model;
				await runtime.output(
					model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
				);
				return commandConsumed();
			}
			const resolved = resolveSessionModelSelector(selector, runtime.session, runtime.settings);
			if (!resolved.model) return usage(`Unknown model: ${selector}`, runtime);
			try {
				await runtime.session.setModelTemporary(resolved.model, resolved.thinkingLevel);
				await runtime.output(`Session-only model: ${formatModelString(resolved.model)}.`);
				await runtime.notifyTitleChanged?.();
				await runtime.notifyConfigChanged?.();
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to switch model: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const selector = command.args.trim();
			if (!selector) {
				runtime.ctx.showModelSelector({ temporaryOnly: true });
				return;
			}
			const resolved = resolveSessionModelSelector(selector, runtime.ctx.session, runtime.ctx.settings);
			if (!resolved.model) {
				runtime.ctx.showError(`Unknown model: ${selector}`);
				return;
			}
			if (resolved.warning) runtime.ctx.showStatus(resolved.warning);
			await runtime.ctx.switchSessionModel(resolved.model, resolved.thinkingLevel);
		},
	},
	{
		name: "fast",
		icon: "fast",
		description:
			"Toggle fast service (OpenAI service_tier=priority or ultrafast, Anthropic speed=fast, Google priority)",
		acpDescription: "Toggle fast mode",
		acpInputHint: "[on|ultra|off|status]",
		subcommands: [
			{ name: "on", description: "Enable fast mode (priority tier)" },
			{ name: "ultra", description: "Enable Ultrafast (OpenAI API, or Codex models that offer it)" },
			{ name: "off", description: "Disable fast mode" },
			{ name: "status", description: "Show fast mode status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => `Fast: ${formatFastModeStatus(runtime.ctx.session)}`,
		handle: async (command, runtime) => {
			const message = runFastCommand(command.args.trim().toLowerCase(), runtime.session);
			if (message === undefined) return usage(FAST_USAGE, runtime);
			await runtime.output(message);
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const message = runFastCommand(command.args.trim().toLowerCase(), runtime.ctx.session);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(message ?? FAST_USAGE);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "slow",
		icon: "fast",
		description:
			"Toggle slow mode: flex tier on OpenAI/Google; on Anthropic, continue at low priority after the Claude session limit",
		acpDescription: "Toggle slow mode",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Flex tier, or Anthropic low priority at the session limit (auto)" },
			{ name: "off", description: "Standard service; stop Anthropic low priority" },
			{ name: "status", description: "Show slow mode status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isSlowModeEnabled() ? "Slow mode: on" : "Slow mode: off",
		handle: async (command, runtime) => {
			const message = runSlowCommand(command.args.trim().toLowerCase(), runtime.session);
			if (message === undefined) return usage("Usage: /slow [on|off|status]", runtime);
			await runtime.output(message);
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const message = runSlowCommand(command.args.trim().toLowerCase(), runtime.ctx.session);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(message ?? "Usage: /slow [on|off|status]");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "skillful",
		icon: "compass",
		description: "Toggle listing available skills in the system prompt (session only)",
		acpDescription: "Toggle skill listing",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "List skills in the prompt for this session" },
			{ name: "off", description: "Omit the skills listing for this session" },
			{ name: "status", description: "Show skill listing status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`Skill listing: ${cfgSkillful.get(runtime.ctx.session.settings) ? "on" : "off"}`,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(
					`Skill listing: ${cfgSkillful.get(runtime.session.settings) ? "on" : "off"} (session override; default from the skillful setting).`,
				);
				return commandConsumed();
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enabled =
					arg === "on"
						? await runtime.session.setSkillful(true)
						: arg === "off"
							? await runtime.session.setSkillful(false)
							: await runtime.session.toggleSkillful();
				await runtime.output(`Skill listing ${enabled ? "enabled" : "disabled"} for this session.`);
				return commandConsumed();
			}
			return usage("Usage: /skillful [on|off|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(`Skill listing: ${cfgSkillful.get(runtime.ctx.session.settings) ? "on" : "off"}.`);
				clearSubmittedText(runtime);
				return;
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enabled =
					arg === "on"
						? await runtime.ctx.session.setSkillful(true)
						: arg === "off"
							? await runtime.ctx.session.setSkillful(false)
							: await runtime.ctx.session.toggleSkillful();
				runtime.ctx.showStatus(`Skill listing ${enabled ? "enabled" : "disabled"} for this session.`);
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus("Usage: /skillful [on|off|status]");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "extended-context",
		icon: "expand",
		description: "Toggle extended context windows",
		acpDescription: "Toggle extended context",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable larger context windows" },
			{ name: "off", description: "Use default or standard-pricing context windows" },
			{ name: "status", description: "Show extended context status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`Extended context: ${formatExtendedContextStatus(runtime.ctx.settings)}`,
		handle: async (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.settings, command.args);
			if (!output) return usage("Usage: /extended-context [on|off|status]", runtime);
			await runtime.output(output);
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.ctx.settings, command.args);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(output ?? "Usage: /extended-context [on|off|status]");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "computer",
		icon: "computer",
		description: "Toggle the native computer-use eval prelude for this session",
		acpDescription: "Toggle computer use",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable computer use for this session" },
			{ name: "off", description: "Disable computer use for this session" },
			{ name: "status", description: "Show computer use status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`Computer: ${cfgComputerEnabled.get(runtime.ctx.session.settings) ? "on" : "off"}`,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(formatComputerUseStatus(runtime.session));
				return commandConsumed();
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable = arg === "off" ? false : arg === "on" || !cfgComputerEnabled.get(runtime.session.settings);
				await runtime.output(applyComputerUseToggle(runtime.session, enable));
				return commandConsumed();
			}
			return usage("Usage: /computer [on|off|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(formatComputerUseStatus(runtime.ctx.session));
				clearSubmittedText(runtime);
				return;
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable =
					arg === "off" ? false : arg === "on" || !cfgComputerEnabled.get(runtime.ctx.session.settings);
				runtime.ctx.showStatus(applyComputerUseToggle(runtime.ctx.session, enable));
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus("Usage: /computer [on|off|status]");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "ratchet",
		icon: "loop",
		description: "Build (or reuse) an eval for an LLM flow, then hillclimb it unattended",
		inlineHint: "[flow and goal]",
		allowArgs: true,
		handle: (command, runtime) => {
			const armed = prepareRatchet(runtime.session, command.args);
			if ("error" in armed) return usage(armed.error, runtime);
			return { prompt: armed.kickoff };
		},
		handleTui: async (command, runtime) => {
			const { session } = runtime.ctx;
			const armed = prepareRatchet(session, command.args);
			clearSubmittedText(runtime);
			if ("error" in armed) {
				runtime.ctx.showWarning(armed.error);
				return;
			}
			// Same delivery as /guided-goal: the kickoff is a hidden developer message queued behind
			// any in-flight run; the agent's batched `ask` is the first thing the user sees.
			const images = runtime.input?.images?.length ? runtime.input.images : undefined;
			if (session.isStreaming) {
				await session.followUp(armed.kickoff, images, { synthetic: true });
				return;
			}
			try {
				await session.prompt(armed.kickoff, images ? { synthetic: true, images } : { synthetic: true });
			} catch (error) {
				if (!(error instanceof AgentBusyError)) throw error;
				await session.followUp(armed.kickoff, images, { synthetic: true });
			}
		},
	},
	{
		name: "prewalk",
		icon: "prewalk",
		description: "Arm, restart, or cancel a one-shot model handoff",
		allowArgs: true,
		acpDescription: "Arm, restart, or cancel prewalk",
		acpInputHint: "[restart|off]",
		subcommands: [
			{ name: "restart", description: "Return to @default and re-arm the handoff to @smol" },
			{ name: "off", description: "Cancel this session's handoff without changing the active model" },
		],
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg && arg !== "restart" && arg !== "off") return usage("Usage: /prewalk [restart|off]", runtime);
			if (arg === "off") {
				const armed = runtime.session.getPrewalkState() !== undefined;
				runtime.session.disarmPrewalk();
				await runtime.output(
					armed
						? "Prewalk off: canceled this session's pending handoff; keeping the active model."
						: "Prewalk already off for this session; keeping the active model.",
				);
				return commandConsumed();
			}
			const target = resolveSessionModelSelector("@smol", runtime.session, runtime.settings);
			if (target.error || !target.model) {
				return usage(target.error ?? 'Model "@smol" not found', runtime);
			}
			if (!runtime.session.modelRegistry.hasConfiguredAuth(target.model)) {
				return usage(`No API key for ${target.model.provider}/${target.model.id}`, runtime);
			}
			if (arg === "restart") {
				const source = resolveSessionModelSelector("@default", runtime.session, runtime.settings);
				if (source.error || !source.model) {
					return usage(source.error ?? 'Model "@default" not found', runtime);
				}
				if (!runtime.session.modelRegistry.hasConfiguredAuth(source.model)) {
					return usage(`No API key for ${source.model.provider}/${source.model.id}`, runtime);
				}
				const result = await runtime.session.restartPrewalk(
					source.model,
					source.thinkingLevel,
					target.model,
					target.thinkingLevel,
				);
				if (result === "rejected") return commandConsumed();
				const restartSource = `${source.model.provider}/${source.model.id}`;
				await runtime.output(
					result === "armed"
						? `Prewalk restarted: using @default (${restartSource}) for planning, then switching to @smol (${target.model.provider}/${target.model.id}) at the next edit/write (todo-gated).`
						: `Prewalk reset: using @default (${restartSource}); @smol resolves to the same model and thinking level, so no handoff was armed.`,
				);
				return commandConsumed();
			}
			const armed = runtime.session.armPrewalk(target.model, target.thinkingLevel);
			if (armed) {
				await runtime.output(
					`Prewalk on: switching to ${target.model.provider}/${target.model.id} at the next edit/write (todo-gated).`,
				);
			}
			return commandConsumed();
		},
	},
	{
		name: "modelpreset",
		icon: "model",
		description: "Save and switch model presets (role models + thinking level)",
		acpDescription: "Manage model presets",
		acpInputHint: "[list|save|switch|delete] [name]",
		inlineHint: "[save|switch|delete|list] [name]",
		subcommands: [
			{ name: "list", description: "List saved presets" },
			{ name: "save", description: "Save the current role models and thinking level", usage: "<name>" },
			{ name: "switch", description: "Apply a saved preset", usage: "<name>" },
			{ name: "delete", description: "Delete a saved preset", usage: "<name>" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const count = getModelPresetNames(runtime.ctx.settings).length;
			return count > 0 ? `Presets: ${count} saved` : "Presets: none saved";
		},
		handle: async (command, runtime) => {
			const outcome = await runPresetsCommand(command.args, runtime.settings, runtime.session);
			if (outcome.usage) return usage(outcome.message, runtime);
			await runtime.output(outcome.message);
			if (outcome.switched) await runtime.notifyTitleChanged?.();
			if (outcome.changedConfig) await runtime.notifyConfigChanged?.();
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const { ctx } = runtime;
			let args = command.args;
			if (!args.trim()) {
				const names = getModelPresetNames(ctx.settings);
				if (names.length === 0) {
					ctx.showStatus(NO_PRESETS_MESSAGE);
					return;
				}
				const picked = await ctx.showHookSelector("Switch to model preset", names);
				if (picked === undefined) return;
				args = `switch ${picked}`;
			}
			const outcome = await runPresetsCommand(args, ctx.settings, ctx.session);
			if (outcome.switched) {
				ctx.statusLine.invalidate();
				ctx.updateEditorBorderColor();
			}
			if (outcome.failed || outcome.usage) ctx.showWarning(outcome.message);
			else ctx.showStatus(outcome.message);
			ctx.ui.requestRender();
		},
	},
	{
		name: "effort",
		icon: "gauge",
		get description() {
			return `Set reasoning effort (thinking level, intelligence) for this session; ${formatKeyHint("shift+tab")} cycles levels`;
		},
		acpDescription: "Set or show reasoning effort (thinking level, intelligence)",
		acpInputHint: "[level]",
		inlineHint: "[level]",
		allowArgs: true,
		subcommands: CLI_THINKING_LEVELS.map(level => ({
			name: level,
			description: getConfiguredThinkingLevelMetadata(level).description,
		})),
		getTuiAutocompleteDescription: runtime =>
			`Thinking: ${runtime.ctx.session.configuredThinkingLevel() ?? "model default"}`,
		handle: async (command, runtime) => {
			const session = runtime.session;
			if (!command.args.trim()) {
				await runtime.output(
					session.model?.reasoning
						? `Thinking: ${session.configuredThinkingLevel() ?? "model default"}\nAvailable: ${session.getAvailableEffortSelectors().join(", ")}`
						: noThinkingMessage(session),
				);
				return commandConsumed();
			}
			const resolved = resolveThinkingArgument(session, command.args);
			if ("error" in resolved) return usage(resolved.error, runtime);
			session.setThinkingLevel(resolved.level);
			await runtime.output(`Thinking set to ${resolved.level}.`);
			// `setThinkingLevel` emits `thinking_level_changed`, which hosts with a
			// session-lifetime subscription (ACP) already turn into a config push.
			await runtime.notifyConfigChanged?.({ handledBySessionEvent: true });
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			clearSubmittedText(runtime);
			const { ctx } = runtime;
			if (!command.args.trim()) {
				if (ctx.session.model?.reasoning) ctx.showThinkingSelector();
				else ctx.showStatus(noThinkingMessage(ctx.session));
				return;
			}
			const resolved = resolveThinkingArgument(ctx.session, command.args);
			if ("error" in resolved) {
				ctx.showError(resolved.error);
				return;
			}
			// thinking_level_changed refreshes the status line and editor border.
			ctx.session.setThinkingLevel(resolved.level);
			ctx.showStatus(`Thinking set to ${resolved.level}.`);
		},
	},
];

const PRESETS_USAGE = "Usage: /modelpreset [list | save <name> | switch <name> | delete <name>]";
const NO_PRESETS_MESSAGE = "No model presets saved. Use /modelpreset save <name> to create one.";

interface PresetsCommandOutcome {
	message: string;
	usage?: boolean;
	failed?: boolean;
	switched?: boolean;
	changedConfig?: boolean;
}

/** Shared by the ACP and TUI handlers of `/modelpreset`; `args` is everything after the command name. */
async function runPresetsCommand(
	args: string,
	settings: Settings,
	session: ModelPresetSession,
): Promise<PresetsCommandOutcome> {
	const [sub = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
	const name = rest.join(" ");
	switch (sub) {
		case "list": {
			const names = getModelPresetNames(settings);
			return { message: names.length > 0 ? `Model presets: ${names.join(", ")}` : NO_PRESETS_MESSAGE };
		}
		case "save": {
			if (!name) return { message: "Usage: /modelpreset save <name>", usage: true };
			if (!isValidModelPresetName(name)) {
				return {
					message: `Invalid preset name "${name}": use a letter, then letters, digits, - or _`,
					usage: true,
				};
			}
			saveModelPreset(settings, name);
			return { message: modelPresetSavedMessage(settings, name), changedConfig: true };
		}
		case "switch": {
			if (!name) return { message: "Usage: /modelpreset switch <name>", usage: true };
			const result = await applyModelPreset(settings, session, name);
			const message = formatModelPresetSwitch(name, result);
			const wroteRoles = result.kind === "switched" || result.kind === "failed";
			return {
				message,
				failed: !isCleanModelPresetSwitch(result),
				switched: result.kind === "switched",
				changedConfig: wroteRoles,
			};
		}
		case "delete": {
			if (!name) return { message: "Usage: /modelpreset delete <name>", usage: true };
			const result = deleteModelPreset(settings, name);
			if (result === "deleted") return { message: `Deleted model preset "${name}"`, changedConfig: true };
			if (result === "project") {
				return {
					message: `Preset "${name}" is defined by a project or --config file; remove it there`,
					failed: true,
				};
			}
			return { message: `Preset not found: ${name}`, failed: true };
		}
		default:
			return { message: PRESETS_USAGE, usage: true };
	}
}

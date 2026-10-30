import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { clearSubmittedText, runWithDetachedDraft } from "./helpers/draft";
import * as path from "node:path";
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
import type { SlashCommandSpec } from "./types";

import {
	cfgComputerBackgroundFallback,
	cfgComputerDisplay,
	cfgComputerEnabled,
	cfgComputerMaxHeight,
	cfgComputerMaxWidth,
	cfgRatchetEnabled,
} from "../tools/settings";
import { cfgPrewalkFrom, cfgPrewalkInto, cfgSkillful } from "../session/settings";
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
			return __ompTranslate(
				"Fast mode {0}.",
				`${session.toggleFastMode() ? __ompTranslate("enabled\u0004mcp.server.activation.state") : __ompTranslate("disabled\u0004mcp.server.activation.state")}`,
			);
		case "on":
			return session.setFastMode(true)
				? __ompTranslate("Fast mode enabled.")
				: __ompTranslate("Fast mode is unavailable for the current model.");
		case "ultra":
		case "ultrafast":
			return session.setUltrafastMode(true)
				? __ompTranslate("Ultrafast mode enabled.")
				: __ompTranslate("Ultrafast is unavailable for the current model.");
		case "off":
			session.setFastMode(false);
			return __ompTranslate("Fast mode disabled.");
		case "status":
			return __ompTranslate("Fast mode is {0}.", `${formatFastModeStatus(session)}`);
		default:
			return undefined;
	}
}

const SLOW_UNSUPPORTED = __ompTranslate(
	"The current model has no slow mode: /slow uses the flex tier on OpenAI/Google models and low priority on Anthropic subscriptions.",
);

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
		if (!session.isSlowModeEnabled())
			return label ? __ompTranslate("Slow mode is off ({0}).", `${label}`) : __ompTranslate("Slow mode is off.");
		if (!anthropic) return __ompTranslate("Slow mode is on (flex tier).");
		return label
			? __ompTranslate("Slow mode is on ({0}).", `${label}`)
			: __ompTranslate("Slow mode is on (low priority at the Claude session limit).");
	}
	const enabled = arg === "on" || (arg !== "off" && !session.isSlowModeEnabled());
	if (!session.setSlowMode(enabled)) return SLOW_UNSUPPORTED;
	if (!session.isSlowModeEnabled()) {
		return anthropic
			? __ompTranslate(
					"Slow mode off: at your Claude usage limit, requests may get a short wrap-up allowance, then wait for the limit to reset.",
				)
			: __ompTranslate("Slow mode off.");
	}
	if (!anthropic) return __ompTranslate("Slow mode on: requests use the flex tier (lower cost, higher latency).");
	const resetsAtSec = session.getAnthropicSlowModeLane()?.activeResetsAtSec();
	return resetsAtSec !== undefined
		? __ompTranslate(
				"Slow mode on: continuing at low priority until your limit resets at {0}. Your weekly limit still applies, and responses may pause while waiting for spare capacity.",
				`${formatSlowModeResetClock(resetsAtSec)}`,
			)
		: __ompTranslate(
				"Slow mode on: when your Claude subscription hits its session limit and Anthropic offers low priority, requests switch to it after any wrap-up allowance.",
			);
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
		return __ompTranslate(
			"Extended context {0}.",
			`${enabled ? __ompTranslate("enabled\u0004mcp.server.activation.state") : __ompTranslate("disabled\u0004mcp.server.activation.state")}`,
		);
	}
	if (arg === "on") {
		cfgExtendedContext.set(settings, true);
		return __ompTranslate("Extended context enabled.");
	}
	if (arg === "off") {
		cfgExtendedContext.set(settings, false);
		return __ompTranslate("Extended context disabled.");
	}
	if (arg === "status") return __ompTranslate("Extended context is {0}.", `${formatExtendedContextStatus(settings)}`);
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
		backgroundFallback: cfgComputerBackgroundFallback.get(session.settings),
	};
	return [
		__ompTranslate(
			"Computer use: {0}",
			`${enabled ? __ompTranslate("enabled\u0004mcp.server.activation.state") : __ompTranslate("disabled\u0004mcp.server.activation.state")}`,
		),
		__ompTranslate(
			"prelude: {0}",
			`${active ? __ompTranslate("active\u0004session.state.active") : __ompTranslate("inactive")}`,
		),
		__ompTranslate(
			"configured: display={0}, maxWidth={1}, maxHeight={2}, backgroundFallback={3}",
			`${configured.display}`,
			`${configured.maxWidth}`,
			`${configured.maxHeight}`,
			`${configured.backgroundFallback}`,
		),
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
		return __ompTranslate("Computer use is unavailable in this session.");
	}
	return enable
		? __ompTranslate("Computer use enabled for this session. {0}", `${formatComputerUseStatus(session)}`)
		: __ompTranslate("Computer use disabled for this session.");
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
		return { error: __ompTranslate("The ratchet eval prelude is unavailable in this session.") };
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

export const BUILTIN_MODE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "security",
		icon: "shield",
		description: __ompTranslate("Plan, run, inspect, import, and compare OMP-native security scans"),
		allowArgs: true,
		acpInputHint: "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
		subcommands: [
			{ name: "plan", description: __ompTranslate("Create an immutable security scan plan") },
			{ name: "scan", description: __ompTranslate("Start a planned or newly planned native scan") },
			{ name: "status", description: __ompTranslate("Show native scan operation status") },
			{ name: "cancel", description: __ompTranslate("Cancel a running native scan") },
			{ name: "scans", description: __ompTranslate("List stored project security scans") },
			{ name: "show", description: __ompTranslate("Render a scan or security:// resource") },
			{ name: "import", description: __ompTranslate("Import SARIF or a Codex Security bundle") },
			{ name: "export", description: __ompTranslate("Export a canonical bundle, SARIF, or report") },
			{ name: "validate", description: __ompTranslate("Validate one finding with OMP-native tools") },
			{ name: "compare", description: __ompTranslate("Compare finding lineage across two scans") },
			{ name: "disposition", description: __ompTranslate("Set a finding disposition with rationale") },
		],
		handle: handleSecurityCommand,
	},
	{
		name: "settings",
		icon: "settings",
		description: __ompTranslate("Open settings menu"),
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "setup",
		aliases: ["providers"],
		icon: "gear",
		description: __ompTranslate("Open provider setup"),
		allowArgs: true,
		subcommands: [{ name: "providers", description: __ompTranslate("Configure sign-in and web search providers") }],
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
		description: __ompTranslate("Toggle plan mode (agent plans before executing)"),
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!cfgPlanEnabled.get(runtime.ctx.settings)) return __ompTranslate("Plan: disabled in settings");
			if (runtime.ctx.planModeEnabled) {
				const planFile = runtime.ctx.planModePlanFilePath;
				return __ompTranslate("Plan: on{0}", `${planFile ? ` (${path.basename(planFile)})` : ""}`);
			}
			if (runtime.ctx.goalModeEnabled) return __ompTranslate("Plan: blocked by goal mode");
			return __ompTranslate("Plan: off");
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedDraft(command, runtime, () =>
				runtime.ctx.handlePlanModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "plan-review",
		icon: "plan",
		description: __ompTranslate("Re-open the plan review for the latest plan (plan mode only)"),
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.planModeEnabled
				? __ompTranslate("Plan review: available")
				: __ompTranslate("Plan review: plan mode inactive"),
		handleTui: async (_command, runtime) => {
			await runtime.ctx.openPlanReview();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "vibe",
		icon: "wave",
		description: __ompTranslate("Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)"),
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.vibeModeEnabled) return __ompTranslate("Vibe: on");
			if (runtime.ctx.planModeEnabled) return __ompTranslate("Vibe: blocked by plan mode");
			if (runtime.ctx.goalModeEnabled) return __ompTranslate("Vibe: blocked by goal mode");
			return __ompTranslate("Vibe: off");
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedDraft(command, runtime, () =>
				runtime.ctx.handleVibeModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "goal",
		icon: "goal",
		description: __ompTranslate("Toggle goal mode (persistent autonomous objective for this session)"),
		subcommands: [
			{ name: "set", description: __ompTranslate("Set or replace the goal"), usage: "<objective>" },
			{ name: "show", description: __ompTranslate("Show current goal details") },
			{ name: "pause", description: __ompTranslate("Pause the current goal") },
			{ name: "resume", description: __ompTranslate("Resume a paused goal") },
			{ name: "drop", description: __ompTranslate("Drop the current goal") },
			{ name: "budget", description: __ompTranslate("Adjust the token budget"), usage: "<N|off>" },
		],
		inlineHint: "[objective]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!cfgGoalEnabled.get(runtime.ctx.settings)) return __ompTranslate("Goal: disabled in settings");
			if (runtime.ctx.planModeEnabled) return __ompTranslate("Goal: blocked by plan mode");
			const state = runtime.ctx.session.getGoalModeState();
			return state
				? __ompTranslate("Goal: {0} ({1})", `${state.goal.status}`, `${shortDetail(state.goal.objective)}`)
				: __ompTranslate("Goal: off");
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedDraft(command, runtime, () =>
				runtime.ctx.handleGoalModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "guided-goal",
		icon: "compass",
		description: __ompTranslate("Have the agent interview you in chat, then set up goal mode"),
		inlineHint: __ompTranslate("[rough objective]"),
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runWithDetachedDraft(command, runtime, () =>
				runtime.ctx.handleGuidedGoalCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "loop",
		icon: "loop",
		get description() {
			return __ompTranslate(
				"Toggle loop mode. While enabled, the next prompt you send re-submits after every yield. Bound it with a count/duration, or gate it with `--until '<cmd>'` / `--while '<cmd>'` — the command's exit status decides whether the next iteration runs. {0} suspends the ongoing loop; /loop again to disable.",
				`${formatKeyHint("escape")}`,
			);
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
			if (bounds.length > 0) return __ompTranslate("Loop: on ({0})", `${bounds.join(", ")}`);
			if (runtime.ctx.loopPrompt) return __ompTranslate("Loop: on (repeating prompt)");
			return __ompTranslate("Loop: on (waiting for next prompt)");
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
		description: __ompTranslate("Queue a message for after the agent yields"),
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
		description: __ompTranslate("Switch model for this session"),
		acpDescription: __ompTranslate("Show current model selection"),
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.viewSession.model;
			return model ? `Model: ${model.provider}/${model.id}` : "Model: none selected";
		},
		handle: async (command, runtime) => {
			if (command.args) {
				const selector = command.args.trim();
				const resolved = resolveSessionModelSelector(selector, runtime.session, runtime.settings);
				const match = resolved.model;
				if (!match) {
					return usage(
						__ompTranslate(
							"Unknown model: {0}. Use ACP `session/setModel` for picker-driven selection or list available models with /model.",
							`${selector}`,
						),
						runtime,
					);
				}
				try {
					await runtime.session.setModel(match);
					if (resolved.thinkingLevel !== undefined) runtime.session.setThinkingLevel(resolved.thinkingLevel);
					await runtime.output(__ompTranslate("Model set to {0}/{1}.", `${match.provider}`, `${match.id}`));
					await runtime.notifyTitleChanged?.();
					await runtime.notifyConfigChanged?.();
					return commandConsumed();
				} catch (err) {
					return usage(__ompTranslate("Failed to set model: {0}", `${errorMessage(err)}`), runtime);
				}
			}

			const model = runtime.session.model;
			await runtime.output(
				model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
			);
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "switch",
		icon: "swap",
		get description() {
			return __ompTranslate(
				"Switch model for this session (same as {0}); accepts fuzzy ids, provider/id, @role, :level",
				`${formatKeyHint("alt+p")}`,
			);
		},
		acpDescription: __ompTranslate("Switch model for this session only"),
		acpInputHint: "[model]",
		inlineHint: "[model]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.viewSession.model;
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
			if (!resolved.model) return usage(__ompTranslate("Unknown model: {0}", `${selector}`), runtime);
			try {
				await runtime.session.setModelTemporary(resolved.model, resolved.thinkingLevel);
				await runtime.output(__ompTranslate("Session-only model: {0}.", `${formatModelString(resolved.model)}`));
				await runtime.notifyTitleChanged?.();
				await runtime.notifyConfigChanged?.();
				return commandConsumed();
			} catch (err) {
				return usage(__ompTranslate("Failed to switch model: {0}", `${errorMessage(err)}`), runtime);
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
				runtime.ctx.showError(__ompTranslate("Unknown model: {0}", `${selector}`));
				return;
			}
			if (resolved.warning) runtime.ctx.showStatus(resolved.warning);
			await runtime.ctx.switchSessionModel(resolved.model, resolved.thinkingLevel);
		},
	},
	{
		name: "fast",
		icon: "fast",
		description: __ompTranslate(
			"Toggle fast service (OpenAI service_tier=priority or ultrafast, Anthropic speed=fast, Google priority)",
		),
		acpDescription: __ompTranslate("Toggle fast mode"),
		acpInputHint: "[on|ultra|off|status]",
		subcommands: [
			{ name: "on", description: __ompTranslate("Enable fast mode (priority tier)") },
			{ name: "ultra", description: __ompTranslate("Enable Ultrafast (OpenAI API, or Codex models that offer it)") },
			{ name: "off", description: __ompTranslate("Disable fast mode") },
			{ name: "status", description: __ompTranslate("Show fast mode status") },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			__ompTranslate("Fast: {0}", `${formatFastModeStatus(runtime.ctx.session)}`),
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
		description: __ompTranslate(
			"Toggle slow mode: flex tier on OpenAI/Google; on Anthropic, continue at low priority after the Claude session limit",
		),
		acpDescription: __ompTranslate("Toggle slow mode"),
		acpInputHint: "[on|off|status]",
		subcommands: [
			{
				name: "on",
				description: __ompTranslate("Flex tier, or Anthropic low priority at the session limit (auto)"),
			},
			{ name: "off", description: __ompTranslate("Standard service; stop Anthropic low priority") },
			{ name: "status", description: __ompTranslate("Show slow mode status") },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isSlowModeEnabled() ? __ompTranslate("Slow mode: on") : __ompTranslate("Slow mode: off"),
		handle: async (command, runtime) => {
			const message = runSlowCommand(command.args.trim().toLowerCase(), runtime.session);
			if (message === undefined) return usage(__ompTranslate("Usage: /slow [on|off|status]"), runtime);
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
		description: __ompTranslate("Toggle listing available skills in the system prompt (session only)"),
		acpDescription: __ompTranslate("Toggle skill listing"),
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: __ompTranslate("List skills in the prompt for this session") },
			{ name: "off", description: __ompTranslate("Omit the skills listing for this session") },
			{ name: "status", description: __ompTranslate("Show skill listing status") },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			__ompTranslate(
				"Skill listing: {0}",
				`${cfgSkillful.get(runtime.ctx.session.settings) ? __ompTranslate("on") : __ompTranslate("off")}`,
			),
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(
					__ompTranslate(
						"Skill listing: {0} (session override; default from the skillful setting).",
						`${cfgSkillful.get(runtime.session.settings) ? __ompTranslate("on") : __ompTranslate("off")}`,
					),
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
				await runtime.output(
					__ompTranslate(
						"Skill listing {0} for this session.",
						`${enabled ? __ompTranslate("enabled\u0004mcp.server.activation.state") : __ompTranslate("disabled\u0004mcp.server.activation.state")}`,
					),
				);
				return commandConsumed();
			}
			return usage(__ompTranslate("Usage: /skillful [on|off|status]"), runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(
					__ompTranslate(
						"Skill listing: {0}.",
						`${cfgSkillful.get(runtime.ctx.session.settings) ? __ompTranslate("on") : __ompTranslate("off")}`,
					),
				);
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
				runtime.ctx.showStatus(
					__ompTranslate(
						"Skill listing {0} for this session.",
						`${enabled ? __ompTranslate("enabled\u0004mcp.server.activation.state") : __ompTranslate("disabled\u0004mcp.server.activation.state")}`,
					),
				);
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
		description: __ompTranslate("Toggle extended context windows"),
		acpDescription: __ompTranslate("Toggle extended context"),
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: __ompTranslate("Enable larger context windows") },
			{ name: "off", description: __ompTranslate("Use default or standard-pricing context windows") },
			{ name: "status", description: __ompTranslate("Show extended context status") },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			__ompTranslate("Extended context: {0}", `${formatExtendedContextStatus(runtime.ctx.settings)}`),
		handle: async (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.settings, command.args);
			if (!output) return usage(__ompTranslate("Usage: /extended-context [on|off|status]"), runtime);
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
		description: __ompTranslate("Toggle the native computer-use eval prelude for this session"),
		acpDescription: __ompTranslate("Toggle computer use"),
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: __ompTranslate("Enable computer use for this session") },
			{ name: "off", description: __ompTranslate("Disable computer use for this session") },
			{ name: "status", description: __ompTranslate("Show computer use status") },
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
		description: __ompTranslate("Build (or reuse) an eval for an LLM flow, then hillclimb it unattended"),
		inlineHint: __ompTranslate("[flow and goal]"),
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
		description: __ompTranslate("Arm, restart, or cancel a one-shot model handoff"),
		allowArgs: true,
		acpDescription: __ompTranslate("Arm, restart, or cancel prewalk"),
		acpInputHint: "[into] | restart [from] [into] | off",
		subcommands: [
			{
				name: "restart",
				description: "Return to the planning model and re-arm the handoff (default prewalk.from → prewalk.into)",
				usage: "[from] [into]",
			},
			{
				name: "off",
				description: __ompTranslate("Cancel this session's handoff without changing the active model"),
			},
		],
		handle: async (command, runtime) => {
			const [verb, ...rest] = command.args.trim().split(/\s+/).filter(Boolean);
			const keyword = verb?.toLowerCase();
			const restart = keyword === "restart";
			const args = restart || keyword === "off" ? rest : verb ? [verb, ...rest] : [];
			if (args.length > (restart ? 2 : keyword === "off" ? 0 : 1)) {
				return usage("Usage: /prewalk [into] | restart [from] [into] | off", runtime);
			}
			if (keyword === "off") {
				const armed = runtime.session.getPrewalkState() !== undefined;
				runtime.session.disarmPrewalk();
				await runtime.output(
					armed
						? __ompTranslate("Prewalk off: canceled this session's pending handoff; keeping the active model.")
						: __ompTranslate("Prewalk already off for this session; keeping the active model."),
				);
				return commandConsumed();
			}
			const into = (restart ? args[1] : args[0]) ?? cfgPrewalkInto.get(runtime.settings);
			const target = resolveSessionModelSelector(into, runtime.session, runtime.settings);
			if (target.error || !target.model) {
				return usage(target.error ?? `Model "${into}" not found`, runtime);
			}
			if (!runtime.session.modelRegistry.hasConfiguredAuth(target.model)) {
				return usage(
					__ompTranslate("No API key for {0}/{1}", `${target.model.provider}`, `${target.model.id}`),
					runtime,
				);
			}
			const targetLabel = `${into} (${target.model.provider}/${target.model.id})`;
			if (restart) {
				const from = args[0] ?? cfgPrewalkFrom.get(runtime.settings);
				const source = resolveSessionModelSelector(from, runtime.session, runtime.settings);
				if (source.error || !source.model) {
					return usage(source.error ?? `Model "${from}" not found`, runtime);
				}
				if (!runtime.session.modelRegistry.hasConfiguredAuth(source.model)) {
					return usage(
						__ompTranslate("No API key for {0}/{1}", `${source.model.provider}`, `${source.model.id}`),
						runtime,
					);
				}
				const result = await runtime.session.restartPrewalk(
					source.model,
					source.thinkingLevel,
					target.model,
					target.thinkingLevel,
				);
				if (result === "rejected") return commandConsumed();
				const sourceLabel = `${from} (${source.model.provider}/${source.model.id})`;
				await runtime.output(
					result === "armed"
						? `Prewalk restarted: using ${sourceLabel} for planning, then switching to ${targetLabel} at the next edit/write (todo-gated).`
						: `Prewalk reset: using ${sourceLabel}; ${into} resolves to the same model and thinking level, so no handoff was armed.`,
				);
				return commandConsumed();
			}
			const armed = runtime.session.armPrewalk(target.model, target.thinkingLevel);
			if (armed) {
				await runtime.output(
					__ompTranslate(
						"Prewalk on: switching to {0}/{1} at the next edit/write (todo-gated).",
						`${target.model.provider}`,
						`${target.model.id}`,
					),
				);
			}
			return commandConsumed();
		},
	},
	{
		name: "modelpreset",
		icon: "model",
		description: __ompTranslate("Save and switch model presets (role models + thinking level)"),
		acpDescription: __ompTranslate("Manage model presets"),
		acpInputHint: "[list|save|switch|delete] [name]",
		inlineHint: "[save|switch|delete|list] [name]",
		subcommands: [
			{ name: "list", description: __ompTranslate("List saved presets") },
			{
				name: "save",
				description: __ompTranslate("Save the current role models and thinking level"),
				usage: "<name>",
			},
			{ name: "switch", description: __ompTranslate("Apply a saved preset"), usage: "<name>" },
			{ name: "delete", description: __ompTranslate("Delete a saved preset"), usage: "<name>" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const count = getModelPresetNames(runtime.ctx.settings).length;
			return count > 0 ? __ompTranslate("Presets: {0} saved", `${count}`) : __ompTranslate("Presets: none saved");
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
				const picked = await ctx.showHookSelector(__ompTranslate("Switch to model preset"), names);
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
			return __ompTranslate(
				"Set reasoning effort (thinking level, intelligence) for this session; {0} cycles levels",
				`${formatKeyHint("shift+tab")}`,
			);
		},
		acpDescription: __ompTranslate("Set or show reasoning effort (thinking level, intelligence)"),
		acpInputHint: "[level]",
		inlineHint: "[level]",
		allowArgs: true,
		subcommands: CLI_THINKING_LEVELS.map(level => ({
			name: level,
			description: getConfiguredThinkingLevelMetadata(level).description,
		})),
		getTuiAutocompleteDescription: runtime =>
			__ompTranslate(
				"Thinking: {0}",
				`${runtime.ctx.viewSession.configuredThinkingLevel() ?? __ompTranslate("model default")}`,
			),
		handle: async (command, runtime) => {
			const session = runtime.session;
			if (!command.args.trim()) {
				await runtime.output(
					session.model?.reasoning
						? __ompTranslate(
								"Thinking: {0}\nAvailable: {1}",
								`${session.configuredThinkingLevel() ?? __ompTranslate("model default")}`,
								`${session.getAvailableEffortSelectors().join(", ")}`,
							)
						: noThinkingMessage(session),
				);
				return commandConsumed();
			}
			const resolved = resolveThinkingArgument(session, command.args);
			if ("error" in resolved) return usage(resolved.error, runtime);
			session.setThinkingLevel(resolved.level);
			await runtime.output(__ompTranslate("Thinking set to {0}.", `${resolved.level}`));
			// `setThinkingLevel` emits `thinking_level_changed`, which hosts with a
			// session-lifetime subscription (ACP) already turn into a config push.
			await runtime.notifyConfigChanged?.({ handledBySessionEvent: true });
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			clearSubmittedText(runtime);
			const { ctx } = runtime;
			const session = ctx.viewSession;
			if (!command.args.trim()) {
				if (session.model?.reasoning) ctx.showThinkingSelector();
				else ctx.showStatus(noThinkingMessage(session));
				return;
			}
			const resolved = resolveThinkingArgument(session, command.args);
			if ("error" in resolved) {
				ctx.showError(resolved.error);
				return;
			}
			// thinking_level_changed refreshes the status line and editor border.
			session.setThinkingLevel(resolved.level);
			ctx.showStatus(__ompTranslate("Thinking set to {0}.", `${resolved.level}`));
		},
	},
];

const PRESETS_USAGE = __ompTranslate("Usage: /modelpreset [list | save <name> | switch <name> | delete <name>]");
const NO_PRESETS_MESSAGE = __ompTranslate("No model presets saved. Use /modelpreset save <name> to create one.");

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
			return {
				message:
					names.length > 0 ? __ompTranslate("Model presets: {0}", `${names.join(", ")}`) : NO_PRESETS_MESSAGE,
			};
		}
		case "save": {
			if (!name) return { message: __ompTranslate("Usage: /modelpreset save <name>"), usage: true };
			if (!isValidModelPresetName(name)) {
				return {
					message: __ompTranslate(
						'Invalid preset name "{0}": use a letter, then letters, digits, - or _',
						`${name}`,
					),
					usage: true,
				};
			}
			saveModelPreset(settings, name);
			return { message: modelPresetSavedMessage(settings, name), changedConfig: true };
		}
		case "switch": {
			if (!name) return { message: __ompTranslate("Usage: /modelpreset switch <name>"), usage: true };
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
			if (!name) return { message: __ompTranslate("Usage: /modelpreset delete <name>"), usage: true };
			const result = deleteModelPreset(settings, name);
			if (result === "deleted")
				return { message: __ompTranslate('Deleted model preset "{0}"', `${name}`), changedConfig: true };
			if (result === "project") {
				return {
					message: __ompTranslate(
						'Preset "{0}" is defined by a project or --config file; remove it there',
						`${name}`,
					),
					failed: true,
				};
			}
			return { message: __ompTranslate("Preset not found: {0}", `${name}`), failed: true };
		}
		default:
			return { message: PRESETS_USAGE, usage: true };
	}
}

import { AgentRegistry } from "../../registry/agent-registry";
import {
	FUSION_POOL_MAX_TIER,
	FUSION_POOL_MIN_TIER,
	formatFusionPoolEntries,
	parseFusionPoolEntries,
} from "../../session/fusion-router";
import { computeFusionTokenSplit } from "../../session/fusion-usage";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { handleModelRoleVerb } from "./fusion-model-roles";
import { resolutionNote } from "./fusion-resolution";
import { commandConsumed, parseSubcommand, usage } from "./parse";

/** Valid `fusion.mode` values, mirrored from the settings schema enum. */
const FUSION_MODES = ["off", "delegate", "escalate"] as const;
type FusionModeValue = (typeof FUSION_MODES)[number];

function isFusionMode(value: string): value is FusionModeValue {
	return (FUSION_MODES as readonly string[]).includes(value);
}

/** Resolve the tracked sidekick's live registry state for `/fusion status`. */
function describeSidekickState(runtime: SlashCommandRuntime): { label: string; degraded: boolean } {
	const id = runtime.session.getFusionSidekickId();
	if (!id) return { label: "unavailable (not spawned)", degraded: true };
	const ref = AgentRegistry.global().get(id);
	if (!ref) return { label: `unavailable (stale id ${id})`, degraded: true };
	if (ref.status === "aborted") return { label: `aborted (${id})`, degraded: true };
	if (ref.status === "parked") return { label: `parked (${id})`, degraded: false };
	if (ref.status === "running") return { label: `running (${id})`, degraded: false };
	return { label: `idle (${id})`, degraded: false };
}

/** One-line tier listing used by `/fusion status` and the pool verbs. */
function describePoolTiers(runtime: SlashCommandRuntime): string[] {
	const pool = parseFusionPoolEntries(runtime.settings.get("fusion.modelPool") ?? []);
	const lines: string[] = [];
	for (let tier = FUSION_POOL_MIN_TIER; tier <= FUSION_POOL_MAX_TIER; tier++) {
		const entry = pool.find(t => t.tier === tier);
		lines.push(`  ${tier}. ${entry ? entry.selector : "(unassigned)"}`);
	}
	return lines;
}

/** Full fusion status block shared by `/fusion` (text mode) and `/fusion status`. */
export function buildFusionStatusText(runtime: SlashCommandRuntime): string {
	const enabled = runtime.settings.get("fusion.enabled") === true;
	const mode = runtime.settings.get("fusion.mode");
	const dynamicRouting = runtime.settings.get("fusion.dynamicRouting") === true;
	const sidekick = runtime.settings.get("fusion.sidekickModel") || "pi/smol";
	const strong = runtime.settings.get("fusion.sidekickStrongModel")?.trim();
	const compact = runtime.settings.get("fusion.compactModel")?.trim();
	const pool = parseFusionPoolEntries(runtime.settings.get("fusion.modelPool") ?? []);

	const active = enabled && mode !== "off";
	const sidekickState = describeSidekickState(runtime);
	const header = `Fusion is ${active ? "ON" : "OFF"}${enabled && mode === "off" ? ' (enabled, but fusion.mode is "off")' : ""}${
		active && sidekickState.degraded ? " (degraded: sidekick unavailable)" : ""
	}`;
	const lines = [
		header,
		`  Mode:            ${mode}`,
		`  Sidekick model:  ${sidekick}`,
		`  Sidekick state:  ${sidekickState.label}`,
		`  Strong sidekick: ${strong || "(unset)"}`,
		`  Compact model:   ${compact || "(unset)"}`,
		`  Dynamic routing: ${dynamicRouting ? "on" : "off"}`,
	];
	const poolStatus =
		pool.length >= 2
			? dynamicRouting && active
				? "active"
				: "configured, waiting on fusion enabled + dynamic routing"
			: pool.length === 1
				? "needs at least 2 tiers to route"
				: "empty";
	lines.push(`  Pool (${poolStatus}):`);
	lines.push(...describePoolTiers(runtime));
	const { share, sidekickTokens } = computeFusionTokenSplit(runtime.session.getFusionUsageSplit());
	if (active && sidekickTokens > 0) {
		lines.push(`  Delegated:       ${share.toFixed(1)}% of billable tokens to the sidekick`);
	}
	if (!active) {
		lines.push("Enable with /fusion on.");
	}
	return lines.join("\n");
}

/**
 * Pool verbs shared by `/fusion pool …` and the legacy `/fusion-pool` alias.
 * `usagePrefix` keeps usage strings honest for whichever spelling invoked it.
 */
export async function handleFusionPoolArgs(
	args: string,
	runtime: SlashCommandRuntime,
	usagePrefix = "/fusion pool",
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(args);
	const pool = parseFusionPoolEntries(runtime.settings.get("fusion.modelPool") ?? []);
	const describePool = (): string => {
		if (pool.length === 0) {
			return `Fusion pool is empty. Assign tiers with ${usagePrefix} set <1-5> <model> (1 = most powerful, 5 = least intelligent).`;
		}
		const status =
			pool.length >= 2
				? runtime.settings.get("fusion.dynamicRouting") === true && runtime.settings.get("fusion.enabled") === true
					? "active"
					: "configured, but needs fusion.enabled + fusion.dynamicRouting to route"
				: "needs at least 2 tiers to route";
		return `Fusion routing pool (1 = most powerful … 5 = least intelligent) — ${status}:\n${describePoolTiers(runtime).join("\n")}`;
	};
	if (!verb || verb === "list" || verb === "status") {
		await runtime.output(describePool());
		return commandConsumed();
	}
	if (verb === "clear") {
		runtime.settings.set("fusion.modelPool", []);
		await runtime.output("Fusion pool cleared.");
		return commandConsumed();
	}
	if (verb === "set") {
		const { verb: tierArg, rest: selector } = parseSubcommand(rest);
		const tier = Number.parseInt(tierArg, 10);
		if (!Number.isInteger(tier) || tier < FUSION_POOL_MIN_TIER || tier > FUSION_POOL_MAX_TIER || !selector.trim()) {
			return usage(
				`Usage: ${usagePrefix} set <1-5> <model-or-alias>  (1 = most powerful, 5 = least intelligent)`,
				runtime,
			);
		}
		const trimmedSelector = selector.trim();
		const next = formatFusionPoolEntries([...pool.filter(t => t.tier !== tier), { tier, selector: trimmedSelector }]);
		runtime.settings.set("fusion.modelPool", next);
		const note = resolutionNote(trimmedSelector, runtime);
		const poolSize = next.length;
		const inactive: string[] = [];
		if (runtime.settings.get("fusion.enabled") !== true) inactive.push("fusion.enabled");
		if (runtime.settings.get("fusion.dynamicRouting") !== true) inactive.push("fusion.dynamicRouting");
		const activation =
			poolSize < 2
				? "\nPool needs at least 2 assigned tiers before routing kicks in."
				: inactive.length > 0
					? `\nConfigured but inactive until ${inactive.join(" and ")} ${inactive.length > 1 ? "are" : "is"} enabled.`
					: "";
		await runtime.output(`Tier ${tier} → ${trimmedSelector}${note}${activation}`);
		return commandConsumed();
	}
	if (verb === "remove" || verb === "rm") {
		const tier = Number.parseInt(rest.trim(), 10);
		if (!Number.isInteger(tier) || tier < FUSION_POOL_MIN_TIER || tier > FUSION_POOL_MAX_TIER) {
			return usage(`Usage: ${usagePrefix} remove <1-5>`, runtime);
		}
		if (!pool.some(t => t.tier === tier)) {
			await runtime.output(`Tier ${tier} is not assigned.`);
			return commandConsumed();
		}
		runtime.settings.set("fusion.modelPool", formatFusionPoolEntries(pool.filter(t => t.tier !== tier)));
		await runtime.output(`Tier ${tier} unassigned.`);
		return commandConsumed();
	}
	return usage(`Usage: ${usagePrefix} [list|set <1-5> <model>|remove <1-5>|clear]`, runtime);
}

/**
 * Enable fusion: flips `fusion.enabled` on and bumps `fusion.mode` off "off"
 * (to the schema default "escalate") so the toggle actually activates the
 * feature instead of leaving it gated by a second setting.
 * Returns the message to show; the TUI wrapper additionally spawns the sidekick.
 */
export function enableFusion(runtime: SlashCommandRuntime): string {
	runtime.settings.set("fusion.enabled", true);
	const parts = ["Fusion enabled."];
	if (runtime.settings.get("fusion.mode") === "off") {
		runtime.settings.set("fusion.mode", "escalate");
		parts.push('fusion.mode was "off" — set to "escalate".');
	}
	const sidekick = runtime.settings.get("fusion.sidekickModel") || "pi/smol";
	parts.push(`Sidekick model: ${sidekick}.`);
	return parts.join(" ");
}

/** Disable fusion. A live sidekick is left running; it stops being advertised next turn. */
export function disableFusion(runtime: SlashCommandRuntime): string {
	runtime.settings.set("fusion.enabled", false);
	return "Fusion disabled. A running sidekick stays alive but is no longer advertised to the main model.";
}

export const FUSION_USAGE =
	"Usage: /fusion [on|off|status|mode <off|delegate|escalate>|routing <on|off>|sidekick <model>|strong <model|clear>|compact <model|clear>|pool <list|set|remove|clear>]";

/**
 * Text/ACP handler for `/fusion`. Bare invocation prints status (the TUI
 * dispatcher intercepts bare `/fusion` earlier and shows the menu instead).
 */
export async function handleFusionCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	switch (verb) {
		case "":
		case "status":
			await runtime.output(buildFusionStatusText(runtime));
			return commandConsumed();
		case "on":
			await runtime.output(enableFusion(runtime));
			return commandConsumed();
		case "off":
			await runtime.output(disableFusion(runtime));
			return commandConsumed();
		case "toggle": {
			const enabled = runtime.settings.get("fusion.enabled") === true;
			await runtime.output(enabled ? disableFusion(runtime) : enableFusion(runtime));
			return commandConsumed();
		}
		case "mode": {
			const value = rest.trim().toLowerCase();
			if (!value) {
				await runtime.output(
					`fusion.mode is "${runtime.settings.get("fusion.mode")}". Usage: /fusion mode <off|delegate|escalate>`,
				);
				return commandConsumed();
			}
			if (!isFusionMode(value)) {
				return usage("Usage: /fusion mode <off|delegate|escalate>", runtime);
			}
			runtime.settings.set("fusion.mode", value);
			await runtime.output(`fusion.mode set to "${value}".`);
			return commandConsumed();
		}
		case "routing": {
			const value = rest.trim().toLowerCase();
			if (value !== "on" && value !== "off") {
				return usage("Usage: /fusion routing <on|off>  (fusion.dynamicRouting)", runtime);
			}
			runtime.settings.set("fusion.dynamicRouting", value === "on");
			await runtime.output(`Dynamic routing ${value}.`);
			return commandConsumed();
		}
		case "sidekick":
		case "strong":
		case "compact":
			return handleModelRoleVerb(verb, rest, runtime);
		case "pool":
			return handleFusionPoolArgs(rest, runtime);
		default:
			return usage(FUSION_USAGE, runtime);
	}
}

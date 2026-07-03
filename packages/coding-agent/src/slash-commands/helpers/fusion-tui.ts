import { formatModelString } from "../../config/model-resolver";
import type { ExtensionUISelectItem } from "../../extensibility/extensions";
import type { InteractiveModeContext } from "../../modes/types";
import {
	FUSION_POOL_MAX_TIER,
	FUSION_POOL_MIN_TIER,
	formatFusionPoolEntries,
	parseFusionPoolEntries,
} from "../../session/fusion-router";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { handleFusionCommand } from "./fusion";
import { parseSubcommand } from "./parse";

function refreshFusionStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.updateEditorTopBorder();
	ctx.ui.requestRender();
}

export async function handleFusionCommandTui(
	command: ParsedSlashCommand,
	ctx: InteractiveModeContext,
): Promise<SlashCommandResult> {
	const messages: string[] = [];
	const runtime: SlashCommandRuntime = {
		session: ctx.session,
		sessionManager: ctx.sessionManager,
		settings: ctx.settings,
		cwd: ctx.sessionManager.getCwd(),
		output: text => {
			messages.push(text);
		},
		refreshCommands: () => ctx.refreshSlashCommandState(),
		reloadPlugins: async () => {},
	};
	const result = await handleFusionCommand(command, runtime);
	const { verb, rest } = parseSubcommand(command.args);
	const active = ctx.settings.get("fusion.enabled") === true && ctx.settings.get("fusion.mode") !== "off";
	if ((verb === "on" || verb === "toggle" || verb === "mode") && active) {
		if (ctx.session.getFusionSidekickId()) {
			messages.push(await ctx.reconcileFusionSidekickModel());
		} else {
			void ctx.ensureFusionSidekick();
		}
	} else if (verb === "sidekick" && rest.trim() && active) {
		messages.push(await ctx.reconcileFusionSidekickModel());
	}
	refreshFusionStatusLine(ctx);
	ctx.showStatus(messages.filter(Boolean).join("\n"));
	ctx.editor.setText("");
	return result;
}

const CUSTOM_PICK = "(custom selector...)";
const CLEAR_PICK = "(clear)";

async function pickModelSelector(
	ctx: InteractiveModeContext,
	title: string,
	clearable: boolean,
): Promise<string | undefined> {
	const items: ExtensionUISelectItem[] = [
		{ label: CUSTOM_PICK, description: "Type any selector or alias (e.g. pi/smol)" },
		...(clearable ? [{ label: CLEAR_PICK, description: "Unset this model" }] : []),
		...ctx.session.modelRegistry
			.getAvailable()
			.map(model => ({ label: formatModelString(model), description: model.name })),
	];
	const selected = await ctx.showHookSelector(title, items);
	if (selected === undefined) return undefined;
	if (selected === CUSTOM_PICK) {
		const typed = await ctx.showHookInput(title, "provider/id or alias");
		return typed?.trim() || undefined;
	}
	if (selected === CLEAR_PICK) return "clear";
	return selected;
}

async function pickFusionMode(ctx: InteractiveModeContext): Promise<string | undefined> {
	return ctx.showHookSelector("Fusion mode", [
		{ label: "escalate", description: "Downgrade at compaction, escalate back when work turns hard (default)" },
		{ label: "delegate", description: "Sidekick delegation only; the main model never downgrades" },
		{ label: "off", description: "Disable fusion behavior while keeping settings" },
	]);
}

async function showFusionPoolMenu(
	ctx: InteractiveModeContext,
	run: (args: string) => Promise<SlashCommandResult>,
): Promise<void> {
	for (;;) {
		const pool = parseFusionPoolEntries(ctx.settings.get("fusion.modelPool") ?? []);
		const items: ExtensionUISelectItem[] = [];
		for (let tier = FUSION_POOL_MIN_TIER; tier <= FUSION_POOL_MAX_TIER; tier++) {
			const entry = pool.find(t => t.tier === tier);
			items.push({
				label: `Tier ${tier}: ${entry ? entry.selector : "(unassigned)"}`,
				description:
					tier === FUSION_POOL_MIN_TIER
						? "most powerful"
						: tier === FUSION_POOL_MAX_TIER
							? "least intelligent"
							: undefined,
			});
		}
		if (pool.length > 0) items.push({ label: "Clear all", description: "Remove every tier assignment" });
		const selected = await ctx.showHookSelector("Fusion pool (1 = most powerful ... 5 = least intelligent)", items);
		if (selected === undefined) return;
		if (selected === "Clear all") {
			await run("pool clear");
			continue;
		}
		const tier = Number.parseInt(selected.slice("Tier ".length), 10);
		const assigned = pool.some(t => t.tier === tier);
		const model = await pickModelSelector(ctx, `Tier ${tier} model`, assigned);
		if (model === undefined) continue;
		await run(model === "clear" ? `pool remove ${tier}` : `pool set ${tier} ${model}`);
	}
}

async function runFusionSetup(
	ctx: InteractiveModeContext,
	run: (args: string) => Promise<SlashCommandResult>,
): Promise<void> {
	await run("on");
	const mode = await pickFusionMode(ctx);
	if (mode) await run(`mode ${mode}`);
	const sidekick = await pickModelSelector(ctx, "Sidekick model", false);
	if (sidekick) await run(`sidekick ${sidekick}`);
	const compact = await pickModelSelector(ctx, "Compact model (optional)", true);
	if (compact) await run(compact === "clear" ? "compact clear" : `compact ${compact}`);
	const routing = await ctx.showHookSelector("Dynamic routing", [
		{ label: "on", description: "Classifier picks a tier at each compaction (needs a 2+ tier pool)" },
		{ label: "off", description: "Static one-shot downgrade to the compact model" },
	]);
	if (routing) await run(`routing ${routing}`);
	await run("status");
}

export async function showFusionMenu(ctx: InteractiveModeContext): Promise<void> {
	const run = (args: string) => handleFusionCommandTui({ name: "fusion", args, text: `/fusion ${args}` }, ctx);
	let cursor = 0;
	for (;;) {
		const cfg = ctx.settings;
		const enabled = cfg.get("fusion.enabled") === true;
		const pool = parseFusionPoolEntries(cfg.get("fusion.modelPool") ?? []);
		const items: ExtensionUISelectItem[] = [
			{ label: `Fusion: ${enabled ? "ON" : "OFF"}`, description: "Toggle cost mode (fusion.enabled)" },
			{ label: `Mode: ${cfg.get("fusion.mode")}`, description: "escalate | delegate | off" },
			{
				label: `Sidekick model: ${cfg.get("fusion.sidekickModel") || "pi/smol"}`,
				description: "Cheap warm subagent for menial work",
			},
			{
				label: `Strong sidekick: ${cfg.get("fusion.sidekickStrongModel")?.trim() || "(unset)"}`,
				description: "Sidekick tier for hard stretches (dynamic routing)",
			},
			{
				label: `Compact model: ${cfg.get("fusion.compactModel")?.trim() || "(unset)"}`,
				description: "Main-model downgrade at compaction boundaries",
			},
			{
				label: `Dynamic routing: ${cfg.get("fusion.dynamicRouting") === true ? "on" : "off"}`,
				description: "Classifier re-tiers at each compaction",
			},
			{
				label: `Pool: ${pool.length > 0 ? `${pool.length} tier${pool.length === 1 ? "" : "s"} assigned` : "empty"}`,
				description:
					pool.length > 0
						? formatFusionPoolEntries(pool).join("  ")
						: "Assign models to tiers 1-5 for dynamic routing",
			},
			{ label: "Setup", description: "Guided setup: enable, mode, models, routing" },
			{ label: "Settings", description: "Open the settings menu" },
			{ label: "Status", description: "Print the full fusion status" },
		];
		const selected = await ctx.showHookSelector("Fusion", items, { initialIndex: cursor });
		if (selected === undefined) return;
		cursor = Math.max(
			0,
			items.findIndex(item => typeof item !== "string" && item.label === selected),
		);
		const action = selected.split(":", 1)[0];
		switch (action) {
			case "Fusion":
				await run("toggle");
				break;
			case "Mode": {
				const mode = await pickFusionMode(ctx);
				if (mode) await run(`mode ${mode}`);
				break;
			}
			case "Sidekick model": {
				const picked = await pickModelSelector(ctx, "Sidekick model", false);
				if (picked && picked !== "clear") await run(`sidekick ${picked}`);
				break;
			}
			case "Strong sidekick": {
				const picked = await pickModelSelector(ctx, "Strong sidekick model", true);
				if (picked) await run(picked === "clear" ? "strong clear" : `strong ${picked}`);
				break;
			}
			case "Compact model": {
				const picked = await pickModelSelector(ctx, "Compact model", true);
				if (picked) await run(picked === "clear" ? "compact clear" : `compact ${picked}`);
				break;
			}
			case "Dynamic routing":
				await run(`routing ${cfg.get("fusion.dynamicRouting") === true ? "off" : "on"}`);
				break;
			case "Pool":
				await showFusionPoolMenu(ctx, run);
				break;
			case "Setup":
				await runFusionSetup(ctx, run);
				break;
			case "Settings":
				ctx.showSettingsSelector();
				return;
			case "Status":
				await run("status");
				return;
			default:
				return;
		}
	}
}

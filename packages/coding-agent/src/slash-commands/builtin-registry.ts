import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveOAuthProvider } from "@pk-nerdsaver-ai/pi-ai/oauth";
import * as requestDebug from "@pk-nerdsaver-ai/pi-ai/utils/request-debug";
import { type AutocompleteItem, Markdown, Spacer } from "@pk-nerdsaver-ai/pi-tui";
import { $which, APP_NAME, getProjectDir, prompt, setProjectDir } from "@pk-nerdsaver-ai/pi-utils";
import { reset as resetCapabilities } from "../capability";
import { COLLAB_GUEST_ALLOWED_COMMANDS, CollabGuestLink } from "../collab/guest";
import { CollabHost } from "../collab/host";
import { writeCollabLinkFile } from "../collab/link-file";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import { applyNineRouterRouting, type NineRouterRoutingResult } from "../config/nine-router-controller";
import type { SettingPath, Settings, SettingValue } from "../config/settings";
import { settings } from "../config/settings";
import {
	clearPluginRootsAndCaches,
	resolveActiveProjectRegistryPath,
	resolveOrDefaultProjectRegistryPath,
} from "../discovery/helpers.js";
import { shareSession } from "../export/share";
import { PluginManager } from "../extensibility/plugins";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../extensibility/plugins/marketplace";
import { renderHelp } from "../help/recommendations";
import { IrcIpc } from "../irc/ipc";
import { resolveMemoryBackend } from "../memory-backend";
import { getMarkdownTheme, theme } from "../modes/theme/theme";
import type { InteractiveModeContext } from "../modes/types";
import deepResearchCommandTemplate from "../prompts/commands/deep-research.md" with { type: "text" };
import type { AgentSession, FreshSessionResult } from "../session/agent-session";
import { COMPACT_MODES, parseCompactArgs } from "../session/compact-modes";
import { HubError, HubService, parseHubLink } from "../session/hub-service";
import { resolveResumableSession } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { formatShakeSummary, type ShakeMode } from "../session/shake-types";
import { clearSpeechHardStop, enableSpeechHardStop, isSpeechHardStopped } from "../tts/speech-hard-stop";
import { vocalizer } from "../tts/vocalizer";
import { urlHyperlinkAlways } from "../tui";
import { getChangelogPath, parseChangelog } from "../utils/changelog";
import { handleGraphtreeCommand, handleGraphtreeCommandTui } from "./builtin/graphtree";
import { handleWikigraphCommand, handleWikigraphCommandTui } from "./builtin/wikigraph";
import { handleColabModelSlashCommand } from "./helpers/colab-model";
import { CollabQrCodeComponent } from "./helpers/collab-qrcode";
import { buildContextReportText } from "./helpers/context-report";
import { handleDelegateSlashCommand } from "./helpers/delegate";
import { formatDuration } from "./helpers/format";
import { handleFusionCommand, handleFusionPoolArgs } from "./helpers/fusion";
import { handleFusionCommandTui, showFusionMenu } from "./helpers/fusion-tui";
import { createMarketplaceManager } from "./helpers/marketplace-manager";
import { handleMcpAcp } from "./helpers/mcp";
import { handleOkfSlashCommand } from "./helpers/okf";
import { commandConsumed, errorMessage, parseSlashCommand, parseSubcommand, usage } from "./helpers/parse";
import { describeRedeemOutcome, type ResetUsageAccount, toResetUsageAccounts } from "./helpers/reset-usage";
import { handleRouteSlashCommand } from "./helpers/route";
import { handleSshAcp } from "./helpers/ssh";
import { launchStatsDashboard, parseStatsDashboardArgs } from "./helpers/stats-dashboard";
import { handleSubagentSlashCommand } from "./helpers/subagent";
import { handleTierSlashCommand, handleTierSlashCommandTui } from "./helpers/tier";
import { handleTodoAcp } from "./helpers/todo";
import { buildUsageReportText } from "./helpers/usage-report";
import { parseMarketplaceInstallArgs, parsePluginScopeArgs } from "./marketplace-install-parser";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	SubcommandDef,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef } from "./types";

/** TUI-specific runtime accepted by `executeBuiltinSlashCommand`. */
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

type ModelSlashCommandRuntime = Pick<
	SlashCommandRuntime,
	"session" | "settings" | "output" | "notifyTitleChanged" | "notifyConfigChanged"
>;

async function handleModelSlashCommand(
	command: ParsedSlashCommand,
	runtime: ModelSlashCommandRuntime,
): Promise<SlashCommandResult> {
	if (command.args) {
		const modelId = command.args.trim();
		const availableModels = runtime.session.getAvailableModels?.() ?? [];
		let match = availableModels.find(model => model.id === modelId || `${model.provider}/${model.id}` === modelId);
		if (!match) {
			// Role aliases (pi/budget, pi/max-intelligence, …) and fuzzy
			// patterns resolve through the shared role-value pipeline.
			match = resolveModelRoleValue(modelId, availableModels, {
				settings: runtime.settings,
				matchPreferences: getModelMatchPreferences(runtime.settings),
				modelRegistry: runtime.session.modelRegistry,
			}).model;
		}
		if (!match) {
			await runtime.output(
				`Unknown model: ${modelId}. Use ACP \`session/setModel\` for picker-driven selection or list available models with /model.`,
			);
			return commandConsumed();
		}
		try {
			await runtime.session.setModel(match);
			await runtime.output(`Model set to ${match.provider}/${match.id}.`);
			await runtime.notifyTitleChanged?.();
			await runtime.notifyConfigChanged?.();
			return commandConsumed();
		} catch (err) {
			await runtime.output(`Failed to set model: ${errorMessage(err)}`);
			return commandConsumed();
		}
	}

	const model = runtime.session.model;
	await runtime.output(model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.");
	return commandConsumed();
}

function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.updateEditorTopBorder();
	ctx.ui.requestRender();
}

/** `/fast status` label: "off", "on", or scope-qualified "on (… only)". */
function formatFastModeStatus(session: AgentSession): string {
	if (!session.isFastModeEnabled()) return "off";
	switch (session.serviceTier) {
		case "openai-only":
			return "on (OpenAI only)";
		case "claude-only":
			return "on (Claude only)";
		default:
			return "on";
	}
}

/** Scheme-less display form of a browser deep link: accent + underline, OSC-8 linked to the full URL. */
function collabWebLinkClickable(webLink: string): string {
	const display = theme.fg("accent", `\x1b[4m${webLink.replace(/^https?:\/\//, "")}\x1b[24m`);
	return urlHyperlinkAlways(webLink, display);
}

/** Join hint printed by /collab: compact terminal link + clickable browser deep link. */
function collabLinkHint(host: CollabHost, heading: string, view = false): string {
	const bullet = theme.fg("accent", theme.format.bullet);
	const link = view ? host.viewLink : host.link;
	const webLink = view ? host.webViewLink : host.webLink;
	return [
		theme.fg("success", heading),
		` ${bullet} ${theme.fg("muted", view ? "Watch from another terminal:" : "Join from another terminal:")} ${APP_NAME} join "${link}"`,
		` ${bullet} ${theme.fg("muted", "or any web browser:")} ${collabWebLinkClickable(webLink)}`,
		theme.fg(
			"dim",
			view
				? "Anyone with this link can watch the session but cannot prompt the agent."
				: "Anyone with the link can read the session and prompt the agent. Read-only link: /collab view",
		),
	].join("\n");
}

function showCollabQrCode(ctx: InteractiveModeContext, webLink: string): void {
	try {
		ctx.present([new Spacer(1), new CollabQrCodeComponent(webLink)]);
	} catch (err) {
		ctx.showError(`Failed to render collab QR code: ${errorMessage(err)}`);
	}
}

function showCollabLink(ctx: InteractiveModeContext, host: CollabHost, heading: string, view = false): void {
	ctx.showStatus(collabLinkHint(host, heading, view), { dim: false });
	showCollabQrCode(ctx, view ? host.webViewLink : host.webLink);
}

async function startCollabShare(
	ctx: InteractiveModeContext,
	input: {
		relayInput: string;
		view: boolean;
		missingRelayUsage: string;
		startedHeading: string;
		activeHeading: string;
		errorPrefix: string;
	},
): Promise<void> {
	if (ctx.collabGuest) {
		ctx.showError("Already in a collab session as a guest (/leave first)");
		return;
	}
	if (ctx.collabHost) {
		showCollabLink(ctx, ctx.collabHost, input.activeHeading, input.view);
		return;
	}
	const relayInput = input.relayInput || ctx.settings.get("collab.relayUrl") || "";
	if (!relayInput) {
		ctx.showError(input.missingRelayUsage);
		return;
	}
	// Scheme-less relay args default to wss (ws:// must be spelled out for localhost).
	const relayUrl = relayInput.includes("://") ? relayInput : `wss://${relayInput}`;
	const webUrl = ctx.settings.get("collab.webUrl") || "";
	const host = new CollabHost(ctx);
	try {
		await host.start(relayUrl, webUrl);
	} catch (err) {
		ctx.showError(`${input.errorPrefix}: ${errorMessage(err)}`);
		return;
	}
	ctx.collabHost = host;
	writeCollabLinkFile({
		webLink: host.webLink,
		webViewLink: host.webViewLink,
		link: host.link,
		viewLink: host.viewLink,
		view: input.view,
	});
	showCollabLink(ctx, host, input.startedHeading, input.view);
}

function formatRemoteControlStatus(ctx: InteractiveModeContext): string {
	if (ctx.collabHost) {
		const names = ctx.collabHost.participants.map(p =>
			p.role === "host" ? `${p.name} (host)` : p.readOnly ? `${p.name} (view-only)` : p.name,
		);
		return [
			`Remote control: ${names.join(", ")}`,
			`Phone/web: ${collabWebLinkClickable(ctx.collabHost.webLink)}`,
			"Capabilities: prompt, interrupt, agent hub chat/kill/revive, transcript fetch, session list/load.",
		].join("\n");
	}
	if (ctx.collabGuest) {
		return ctx.collabGuest.readOnly
			? "In a remote collab session as a read-only guest (/leave to exit)"
			: "In a remote collab session as a guest (/leave to exit)";
	}
	return "Remote control is not running";
}

function openKanbanForRemoteControl(ctx: InteractiveModeContext): void {
	const bin = $which("pk-kanban");
	if (!bin) {
		ctx.showError("pk-kanban is not installed or not on PATH");
		return;
	}
	try {
		const proc = Bun.spawn({
			cmd: [bin],
			cwd: ctx.sessionManager.getCwd(),
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
		});
		proc.unref();
		ctx.showStatus(`Opening Kanban for ${ctx.sessionManager.getCwd()}`);
	} catch (err) {
		ctx.showError(`Failed to open Kanban: ${errorMessage(err)}`);
	}
}

function formatFreshSessionResult(result: FreshSessionResult): string {
	const stateLabel = result.closedProviderSessions === 1 ? "provider state" : "provider states";
	return `Fresh provider session started (${result.closedProviderSessions} ${stateLabel} pruned).`;
}

const shutdownHandlerTui = (_command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): SlashCommandResult => {
	runtime.ctx.editor.setText("");
	void runtime.ctx.shutdown();
	return commandConsumed();
};

async function handleUsageResetCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	let accounts: ResetUsageAccount[];
	try {
		accounts = toResetUsageAccounts(await session.listResetCredits());
	} catch (error) {
		await output(`Could not load saved resets: ${errorMessage(error)}`);
		return;
	}
	if (accounts.length === 0) {
		await output("No Codex accounts found. Use /login to add one.");
		return;
	}
	const targetArg = arg.trim();
	if (!targetArg) {
		const lines = ["Saved Codex rate-limit resets:"];
		for (const account of accounts) {
			const detail = account.error ? `unavailable (${account.error})` : `${account.availableCount} available`;
			lines.push(`- ${account.label}: ${detail}${account.active ? " (active)" : ""}`);
		}
		lines.push("", "Spend one with `/usage reset <account email>` or `/usage reset active`.");
		await output(lines.join("\n"));
		return;
	}
	const wanted = targetArg.toLowerCase();
	const target =
		wanted === "active"
			? accounts.find(account => account.active)
			: accounts.find(
					account =>
						account.label.toLowerCase() === wanted ||
						account.target.email?.toLowerCase() === wanted ||
						account.target.accountId?.toLowerCase() === wanted,
				);
	if (!target) {
		await output(`No Codex account matches "${targetArg}".`);
		return;
	}
	if (target.availableCount <= 0) {
		await output(`${target.label}: no saved resets to spend.`);
		return;
	}
	const outcome = await session.redeemResetCredit(target.target);
	await output(describeRedeemOutcome(outcome, target.label));
}

const DEBUG_DUMP_NEXT_REQUEST_USAGE = "Usage: /debug dump-next-request <path>";

function resolveDebugRequestDumpPath(target: string, cwd: string): string {
	const expanded =
		target === "~"
			? os.homedir()
			: target.startsWith("~/") || target.startsWith("~\\")
				? path.join(os.homedir(), target.slice(2))
				: target;
	return path.resolve(cwd, expanded);
}

async function handleDebugSubcommand(
	args: string,
	cwd: string,
	output: (text: string) => Promise<void> | void,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(args);
	switch (verb) {
		case "":
			await output(DEBUG_DUMP_NEXT_REQUEST_USAGE);
			return commandConsumed();
		case "dump-next-request":
		case "dump-request":
		case "next-request": {
			if (!rest) {
				await output(DEBUG_DUMP_NEXT_REQUEST_USAGE);
				return commandConsumed();
			}
			const requestPath = resolveDebugRequestDumpPath(rest, cwd);
			const setNextPath: unknown = Object.getOwnPropertyDescriptor(requestDebug, "setNextRequestDebugPath")?.value;
			if (typeof setNextPath !== "function") {
				await output(
					"Per-request paths are unavailable in this pi-ai build; set PI_REQ_DEBUG=1 before startup instead.",
				);
				return commandConsumed();
			}
			setNextPath(requestPath);
			await output(`Next AI provider request will be dumped to ${requestPath}`);
			return commandConsumed();
		}
		default:
			await output(`Unknown /debug subcommand "${verb}". ${DEBUG_DUMP_NEXT_REQUEST_USAGE}`);
			return commandConsumed();
	}
}

/** Parse the `/shake` subcommand into a {@link ShakeMode}; empty defaults to elide. */
function parseShakeMode(args: string): ShakeMode | { error: string } {
	const verb = args.trim().toLowerCase();
	if (verb === "" || verb === "elide") return "elide";
	if (verb === "images") return "images";
	return { error: `Unknown /shake mode "${verb}". Use elide or images.` };
}

function resolveMoveCompletionBase(base: string, cwd: string): string {
	if (!base) return cwd;
	if (base === "~" || base === "~/") return os.homedir();
	if (base.startsWith("~/")) return path.join(os.homedir(), base.slice(2));
	if (path.isAbsolute(base)) return base;
	return path.resolve(cwd, base);
}

async function listMoveDirectoryCompletions(
	dir: string,
	displayPrefix: string,
	query: string,
): Promise<AutocompleteItem[] | null> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return null;
	}
	const includeHidden = query.startsWith(".");
	const lower = query.toLowerCase();
	const items: AutocompleteItem[] = [];
	for (const name of names.sort((a, b) => a.localeCompare(b))) {
		if (!includeHidden && name.startsWith(".")) continue;
		if (query && !name.toLowerCase().startsWith(lower)) continue;
		try {
			if (!(await fs.stat(path.join(dir, name))).isDirectory()) continue;
		} catch {
			continue;
		}
		items.push({ value: `${displayPrefix}${name}/`, label: `${name}/` });
	}
	return items.length > 0 ? items : null;
}

/** Directory completions for `/move <path>`: `~`, absolute, and cwd-relative prefixes. */
function completeMoveDirectories(argumentPrefix: string): Promise<AutocompleteItem[] | null> {
	const cwd = getProjectDir();
	const normalized = argumentPrefix.replace(/\\/g, "/");
	const slashIdx = normalized.lastIndexOf("/");
	const base = slashIdx === -1 ? "" : normalized.slice(0, slashIdx + 1);
	const query = slashIdx === -1 ? normalized : normalized.slice(slashIdx + 1);
	// A bare navigation token (".", "..", "~") means "list that directory's
	// children", not "filter the current listing by it".
	if (query === "." || query === ".." || query === "~") {
		const asBase = `${normalized}/`;
		return listMoveDirectoryCompletions(resolveMoveCompletionBase(asBase, cwd), asBase, "");
	}
	return listMoveDirectoryCompletions(resolveMoveCompletionBase(base, cwd), base, query);
}

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "pk-speak",
		aliases: ["speech"],
		description: "Hard-stop or control assistant speech vocalization",
		acpDescription: "Hard-stop or control assistant speech vocalization",
		acpInputHint: "[stop|off|quiet|silence|shush|on|status]",
		subcommands: [
			{ name: "stop", description: "Hard silence: disable speech and stop playback" },
			{ name: "off", description: "Hard silence: disable speech and stop playback" },
			{ name: "quiet", description: "Hard silence: disable speech and stop playback" },
			{ name: "silence", description: "Hard silence: disable speech and stop playback" },
			{ name: "shush", description: "Hard silence: disable speech and stop playback" },
			{ name: "on", description: "Enable speech vocalization" },
			{ name: "status", description: "Show speech vocalization status" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "stop" || arg === "off" || arg === "quiet" || arg === "silence" || arg === "shush") {
				runtime.settings.set("speech.enabled", false);
				enableSpeechHardStop();
				vocalizer.clear();
				await runtime.output("pk-speak stopped: speech disabled and playback cleared.");
				return commandConsumed();
			}
			if (arg === "on" || arg === "enable" || arg === "start") {
				clearSpeechHardStop();
				runtime.settings.set("speech.enabled", true);
				await runtime.output("pk-speak enabled: speech vocalization on.");
				return commandConsumed();
			}
			if (arg === "status") {
				const enabled = runtime.settings.get("speech.enabled");
				const hard = isSpeechHardStopped();
				await runtime.output(`pk-speak: speech ${enabled ? "on" : "off"}${hard ? " (hard-stopped)" : ""}.`);
				return commandConsumed();
			}
			return usage("Usage: /pk-speak [stop|off|on|status]", runtime);
		},
		handleTui: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "stop" || arg === "off" || arg === "quiet" || arg === "silence" || arg === "shush") {
				runtime.ctx.settings.set("speech.enabled", false);
				enableSpeechHardStop();
				vocalizer.clear();
				runtime.ctx.showStatus("pk-speak stopped: speech disabled and playback cleared.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on" || arg === "enable" || arg === "start") {
				clearSpeechHardStop();
				runtime.ctx.settings.set("speech.enabled", true);
				runtime.ctx.showStatus("pk-speak enabled: speech vocalization on.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				const enabled = runtime.ctx.settings.get("speech.enabled");
				const hard = isSpeechHardStopped();
				runtime.ctx.showStatus(`pk-speak: speech ${enabled ? "on" : "off"}${hard ? " (hard-stopped)" : ""}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /pk-speak [stop|off|on|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "settings",
		description: "Open settings menu",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "tier",
		description: "Configure or inspect the default spawned-agent execution tier",
		allowArgs: true,
		subcommands: [
			{ name: "status", description: "Show the effective default spawn envelope" },
			{ name: "light", description: "Constrain new agents to read/search/report controls" },
			{ name: "mid", description: "Constrain new agents to basic tools and replace-only editing" },
			{ name: "frontier", description: "Permit frontier capabilities for new agents" },
			{ name: "auto", description: "Use agent/workflow policies or the normal frontier default" },
		],
		handle: async (command, runtime) => {
			await handleTierSlashCommand(command.args, runtime);
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			handleTierSlashCommandTui(command.args, runtime);
		},
	},
	{
		name: "help",
		description: "Recommend built-in features and show related documentation",
		inlineHint: "[question]",
		allowArgs: true,
		handle: async (command, runtime) => {
			await runtime.output(renderHelp(command.args));
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			runtime.ctx.showStatus(renderHelp(command.args));
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "wikigraph",
		description: "Build and query WikiGraph index",
		aliases: ["wiki"],
		allowArgs: true,
		subcommands: [
			{ name: "build", description: "Refresh WikiGraph index" },
			{ name: "extract", description: "Extract facts from a section node" },
			{ name: "repair", description: "Drop and rebuild WikiGraph index" },
		],
		handle: (command, runtime) => handleWikigraphCommand(command.args, runtime),
		handleTui: (command, runtime) => handleWikigraphCommandTui(command.args, runtime),
	},
	{
		name: "setup",
		aliases: ["providers"],
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
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "plan",
		description: "Toggle plan mode (agent plans before executing)",
		inlineHint: "[prompt]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handlePlanModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "plan-review",
		description: "Re-open the plan review for the latest plan (plan mode only)",
		handleTui: async (_command, runtime) => {
			await runtime.ctx.openPlanReview();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "goal",
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
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleGoalModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "guided-goal",
		description: "Interview and refine a goal before enabling goal mode",
		inlineHint: "[rough objective]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleGuidedGoalCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "loop",
		description:
			"Toggle loop mode. Use --spiral/--wall-climb for verifier-reflection iterations. Esc cancels the current iteration; /loop again disables.",
		inlineHint: "[--spiral|--mode MODE] [count|duration] [prompt]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const prompt = await runtime.ctx.handleLoopCommand(command.args);
			runtime.ctx.editor.setText("");
			// Surface any inline prompt so the dispatcher returns it and the normal
			// submit flow runs the first loop iteration (recording it as the loop prompt).
			if (prompt) return { prompt };
		},
	},
	{
		name: "colab-model",
		description: "Launch a Hugging Face GGUF on a selected Colab GPU",
		inlineHint: "[--gpu T4|L4|A100|H100|G4] <Hugging Face model id or GGUF URL>",
		allowArgs: true,
		handle: async (command, runtime) => handleColabModelSlashCommand(command.args, runtime),
	},
	{
		name: "model",
		aliases: ["models"],
		description: "Switch model for this session",
		allowArgs: true,
		acpDescription: "Show current model selection",
		handle: handleModelSlashCommand,
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			if (command.args) {
				const result = await handleModelSlashCommand(command, {
					session: ctx.viewSession,
					settings: ctx.settings,
					output: text => ctx.showStatus(text),
				});
				ctx.editor.setText("");
				return result;
			}
			ctx.showModelSelector();
			ctx.editor.setText("");
		},
	},
	{
		name: "subagent",
		description: "Spawn a subagent; the using form preselects model and task, leaving only optional name",
		inlineHint: 'using <alias-or-model> "<prompt>"',
		allowArgs: true,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await handleSubagentSlashCommand(command.args, runtime.ctx);
		},
	},
	{
		name: "delegate",
		description: "Spawn configured lanes or a delegate subagent",
		inlineHint: "[using <alias-or-model> | legacy] [task]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await handleDelegateSlashCommand(command.args, runtime.ctx);
		},
	},
	{
		name: "switch",
		description: "Switch model for this session (same as alt+p)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector({ temporaryOnly: true });
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fast",
		description: "Toggle fast routing (OpenAI priority, Anthropic fast mode, OpenRouter :nitro)",
		acpDescription: "Toggle fast mode",
		acpInputHint: "[on|off|status]",
		getTuiAutocompleteDescription: runtime => `Fast: ${formatFastModeStatus(runtime.ctx.session)}`,
		subcommands: [
			{ name: "on", description: "Enable fast mode" },
			{ name: "off", description: "Disable fast mode" },
			{ name: "status", description: "Show fast mode status" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.session.toggleFastMode();
				await runtime.output(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				return commandConsumed();
			}
			if (arg === "on") {
				runtime.session.setFastMode(true);
				await runtime.output("Fast mode enabled.");
				return commandConsumed();
			}
			if (arg === "off") {
				runtime.session.setFastMode(false);
				await runtime.output("Fast mode disabled.");
				return commandConsumed();
			}
			if (arg === "status") {
				await runtime.output(`Fast mode is ${formatFastModeStatus(runtime.session)}.`);
				return commandConsumed();
			}
			return usage("Usage: /fast [on|off|status]", runtime);
		},
		handleTui: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.ctx.session.toggleFastMode();
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on") {
				runtime.ctx.session.setFastMode(true);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("Fast mode enabled.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setFastMode(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("Fast mode disabled.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				runtime.ctx.showStatus(`Fast mode is ${formatFastModeStatus(runtime.ctx.session)}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /fast [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fusion",
		description: "Fusion cost mode: menu, toggle, model assignments, and routing pool",
		acpDescription: "Manage Fusion cost mode (toggle, models, routing pool)",
		acpInputHint: "[on|off|status|mode <m>|routing <on|off>|sidekick <model>|strong <model>|compact <model>|pool …]",
		subcommands: [
			{ name: "on", description: "Enable fusion (spawns the sidekick)" },
			{ name: "off", description: "Disable fusion" },
			{ name: "status", description: "Show fusion status and assignments" },
			{ name: "mode", description: "Set fusion mode", usage: "<off|delegate|escalate>" },
			{ name: "routing", description: "Toggle dynamic routing", usage: "<on|off>" },
			{ name: "sidekick", description: "Assign the sidekick model", usage: "<model-or-alias>" },
			{ name: "strong", description: "Assign the strong sidekick model", usage: "<model-or-alias|clear>" },
			{ name: "compact", description: "Assign the compaction downgrade model", usage: "<model-or-alias|clear>" },
			{ name: "pool", description: "Manage the routing pool", usage: "[list|set <1-5> <model>|remove <1-5>|clear]" },
		],
		allowArgs: true,
		handle: handleFusionCommand,
		handleTui: async (command, runtime) => {
			if (!command.args.trim()) {
				await showFusionMenu(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			return handleFusionCommandTui(command, runtime.ctx);
		},
	},
	{
		name: "fusion-pool",
		description: "Manage the Fusion routing pool (alias of /fusion pool)",
		acpDescription: "Manage the Fusion model routing pool (alias of /fusion pool)",
		acpInputHint: "[list|set <1-5> <model>|remove <1-5>|clear]",
		subcommands: [
			{ name: "list", description: "Show the current tier assignments" },
			{ name: "set", description: "Assign a model to a tier", usage: "<1-5> <model-or-alias>" },
			{ name: "remove", description: "Unassign a tier", usage: "<1-5>" },
			{ name: "clear", description: "Remove all tier assignments" },
		],
		allowArgs: true,
		handle: (command, runtime) => handleFusionPoolArgs(command.args, runtime, "/fusion-pool"),
	},
	{
		name: "advisor",
		description: "Toggle the advisor (a second model that reviews each turn and injects notes)",
		acpDescription: "Toggle advisor",
		acpInputHint: "[on|off|status|dump [raw]]",
		subcommands: [
			{ name: "on", description: "Enable the advisor" },
			{ name: "off", description: "Disable the advisor" },
			{ name: "status", description: "Show advisor status" },
			{ name: "dump", description: "Copy the advisor's transcript to clipboard", usage: "[raw]" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.session.toggleAdvisorEnabled();
				const configured = runtime.session.isAdvisorEnabled();
				if (active) {
					await runtime.output("Advisor enabled.");
				} else if (configured) {
					await runtime.output("Advisor setting enabled, but no model is assigned to the 'advisor' role.");
				} else {
					await runtime.output("Advisor disabled.");
				}
				return commandConsumed();
			}
			if (verb === "on") {
				const active = runtime.session.setAdvisorEnabled(true);
				await runtime.output(
					active ? "Advisor enabled." : "Advisor setting enabled, but no model is assigned to the 'advisor' role.",
				);
				return commandConsumed();
			}
			if (verb === "off") {
				runtime.session.setAdvisorEnabled(false);
				await runtime.output("Advisor disabled.");
				return commandConsumed();
			}
			if (verb === "status") {
				await runtime.output(runtime.session.formatAdvisorStatus());
				return commandConsumed();
			}
			if (verb === "dump") {
				const isRaw = rest.toLowerCase() === "raw";
				const text = runtime.session.formatAdvisorHistoryAsText({ compact: !isRaw });
				await runtime.output(text ?? "Advisor is not active for this session.");
				return commandConsumed();
			}
			return usage("Usage: /advisor [on|off|status|dump [raw]]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.ctx.session.toggleAdvisorEnabled();
				const configured = runtime.ctx.session.isAdvisorEnabled();
				if (active) {
					runtime.ctx.showStatus("Advisor enabled.");
				} else if (configured) {
					runtime.ctx.showStatus("Advisor setting enabled, but no model is assigned to the 'advisor' role.");
				} else {
					runtime.ctx.showStatus("Advisor disabled.");
				}
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "on") {
				const active = runtime.ctx.session.setAdvisorEnabled(true);
				runtime.ctx.showStatus(
					active ? "Advisor enabled." : "Advisor setting enabled, but no model is assigned to the 'advisor' role.",
				);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "off") {
				runtime.ctx.session.setAdvisorEnabled(false);
				runtime.ctx.showStatus("Advisor disabled.");
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "status") {
				await runtime.ctx.handleAdvisorStatusCommand();
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "dump") {
				const isRaw = rest.toLowerCase() === "raw";
				runtime.ctx.handleAdvisorDumpCommand(isRaw);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /advisor [on|off|status|dump [raw]]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "export",
		description: "Export session to HTML file",
		inlineHint: "[path]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.trim();
			// Match the interactive `/export` behavior: clipboard aliases are not a
			// valid export target. Without this, the literal value (`copy`,
			// `--copy`, `clipboard`) is passed to `exportToHtml` and becomes the
			// output filename.
			if (arg === "--copy" || arg === "clipboard" || arg === "copy") {
				return usage("Use /dump to copy the session to clipboard.", runtime);
			}
			try {
				const filePath = await runtime.session.exportToHtml(arg || undefined);
				await runtime.output(`Session exported to: ${filePath}`);
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to export session: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleExportCommand(command.text);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "dump",
		description: "Copy session transcript to clipboard",
		acpDescription: "Return full transcript as plain text",
		allowArgs: true,
		handle: async (_command, runtime) => {
			const text = runtime.session.formatSessionAsText();
			if (!text) {
				await runtime.output("No messages to dump yet.");
				return commandConsumed();
			}
			// Best-effort LLM request JSON sidecar; the transcript is still
			// useful without it, so failures just omit the pointer.
			let sidecarPath: string | undefined;
			try {
				sidecarPath = await runtime.session.dumpLlmRequestToTmpDir();
			} catch {
				sidecarPath = undefined;
			}
			const output = sidecarPath
				? `${text}\n\n---\nLLM request JSON: ${sidecarPath}\nThis file persists on disk and may contain raw context/secrets — treat accordingly.`
				: text;
			await runtime.output(output);
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleDumpCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "share",
		description: "Share session via an encrypted link (secret gist or share server)",
		handle: async (_command, runtime) => {
			try {
				const result = await shareSession(runtime.sessionManager, {
					serverUrl: runtime.settings.get("share.serverUrl"),
					state: runtime.session.state,
					obfuscator: runtime.settings.get("share.redactSecrets") ? runtime.session.obfuscator : undefined,
				});
				const lines = [`Share URL: ${result.url}`];
				if (result.gistUrl) lines.push(`Gist: ${result.gistUrl}`);
				if (result.truncated) lines.push("Note: large content was trimmed to fit the share size limit.");
				await runtime.output(lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to share session: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleShareCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "hub",
		description: "Cloud-durable encrypted session handoff between your devices",
		inlineHint:
			"[provision [name] | login | publish | new | list | resume <link> | devices <hubId> | revoke [hubId]]",
		allowArgs: true,
		persistInHistory: false,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args.trim());
			const hub = new HubService({
				baseUrl: runtime.settings.get("hub.relayUrl"),
				token: runtime.settings.get("hub.token") || undefined,
				deviceId: runtime.settings.get("hub.deviceId") || undefined,
			});
			try {
				if (verb === "provision") {
					const adminToken = Bun.env.OMP_HUB_ADMIN_TOKEN;
					if (!adminToken)
						return usage("Set OMP_HUB_ADMIN_TOKEN, then run /hub provision [device group name].", runtime);
					const result = await hub.provision(adminToken, rest || os.userInfo().username);
					runtime.settings.set("hub.token", result.token);
					await runtime.output(
						`Hub access provisioned for ${result.displayName}. Copy hub.token to each device you want to hand off between.`,
					);
					return commandConsumed();
				}
				if (verb === "login") {
					const token = Bun.env.OMP_HUB_TOKEN;
					if (!token)
						return usage(
							"Set OMP_HUB_TOKEN locally, then run /hub login. Do not paste tokens into session history.",
							runtime,
						);
					runtime.settings.set("hub.token", token);
					await runtime.output("Hub access token saved for this device.");
					return commandConsumed();
				}
				if (verb === "publish" || verb === "new") {
					const activeId = runtime.settings.get("hub.activeId");
					const activeKey = runtime.settings.get("hub.activeKey");
					const target =
						rest.length > 0
							? parseHubLink(rest)
							: verb === "publish" && activeId && activeKey
								? { hubId: activeId, keyText: activeKey }
								: undefined;
					const result = await hub.publish(runtime.sessionManager, {
						hubId: target?.hubId,
						keyText: target?.keyText,
					});
					runtime.settings.set("hub.deviceId", result.deviceId);
					runtime.settings.set("hub.activeId", result.hubId);
					runtime.settings.set("hub.activeKey", result.keyText);
					await runtime.output(
						[
							`Hub link: ${result.url}`,
							`Saved ${result.devices} device snapshot(s). Paste the full link into /hub resume on the next device.`,
						].join("\n"),
					);
					return commandConsumed();
				}
				if (verb === "list") {
					const entries = await hub.list();
					if (entries.length === 0) {
						await runtime.output("No hub sessions are available to this account.");
						return commandConsumed();
					}
					await runtime.output(
						entries
							.map(
								entry =>
									`${entry.hubId}  ${entry.title}  ${entry.devices} devices  ${entry.entryCount} entries`,
							)
							.join("\n"),
					);
					return commandConsumed();
				}
				if (verb === "resume") {
					if (!rest) return usage("Usage: /hub resume <full hub link>", runtime);
					const link = parseHubLink(rest);
					const result = await hub.resume(link);
					const imported = await SessionManager.forkFromSnapshot(result.snapshot, runtime.cwd);
					const sessionPath = imported.getSessionFile();
					if (!sessionPath) throw new HubError("hub import did not create a local session file");
					await imported.close();
					if (!(await runtime.session.switchSession(sessionPath))) return commandConsumed();
					if (result.snapshot.leafId === null) runtime.sessionManager.resetLeaf();
					else runtime.sessionManager.branch(result.snapshot.leafId);
					runtime.settings.set("hub.activeId", link.hubId);
					runtime.settings.set("hub.activeKey", link.keyText);
					await runtime.output(
						`Resumed ${result.entryCount} hub entries from ${result.devices.length} device(s) into a local session fork.`,
					);
					return commandConsumed();
				}
				if (verb === "devices") {
					const hubId = rest.startsWith("http") ? parseHubLink(rest).hubId : rest;
					if (!hubId) return usage("Usage: /hub devices <hubId or hub link>", runtime);
					const devices = await hub.devices(hubId);
					await runtime.output(
						devices.length > 0
							? devices
									.map(device => `${device.deviceId}  ${device.displayName}  ${device.entryCount} entries`)
									.join("\n")
							: "(no device snapshots yet)",
					);
					return commandConsumed();
				}
				if (verb === "revoke") {
					const hubId = rest.startsWith("http")
						? parseHubLink(rest).hubId
						: rest || runtime.settings.get("hub.activeId");
					if (!hubId) return usage("Usage: /hub revoke <hubId or hub link>", runtime);
					await hub.revoke(hubId);
					await runtime.output(`Removed this device's snapshot from hub ${hubId}.`);
					return commandConsumed();
				}
				return usage("Usage: /hub [provision|login|publish|new|list|resume|devices|revoke] [args]", runtime);
			} catch (err) {
				const message = err instanceof HubError ? err.message : `hub error: ${errorMessage(err)}`;
				return usage(message, runtime);
			}
		},
	},
	{
		name: "collab",
		description: "Share this session live via a relay",
		inlineHint: "[start|view|stop|status] [relayUrl]",
		subcommands: [
			{ name: "view", description: "Share a read-only link (guests can watch, not prompt)" },
			{ name: "status", description: "Show link + participants" },
			{ name: "stop", description: "Stop sharing" },
		],
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const args = command.args.trim();
			const { verb, rest } = parseSubcommand(args);
			if (verb === "stop") {
				if (!ctx.collabHost) {
					ctx.showStatus("Not hosting a collab session");
					return;
				}
				await ctx.collabHost.stop("host stopped");
				ctx.showStatus("Collab stopped");
				return;
			}
			if (verb === "status") {
				if (ctx.collabHost) {
					const names = ctx.collabHost.participants.map(p =>
						p.role === "host" ? `${p.name} (host)` : p.readOnly ? `${p.name} (view-only)` : p.name,
					);
					ctx.showStatus(`Collab: ${names.join(", ")} — ${collabWebLinkClickable(ctx.collabHost.webLink)}`);
				} else if (ctx.collabGuest) {
					ctx.showStatus(
						ctx.collabGuest.readOnly
							? "In a collab session as a read-only guest (/leave to exit)"
							: "In a collab session as a guest (/leave to exit)",
					);
				} else {
					ctx.showStatus("Not in a collab session");
				}
				return;
			}
			const knownStartVerb = verb === "start" || verb === "view";
			const view = verb === "view";
			const explicitUrl = knownStartVerb ? rest : args;
			await startCollabShare(ctx, {
				relayInput: explicitUrl,
				view,
				missingRelayUsage:
					"No relay configured. Set collab.relayUrl in /settings or pass one: /collab relay.example.com",
				startedHeading: "Collab session started!",
				activeHeading: view ? "Read-only collab session active" : "Collab session active",
				errorPrefix: "Failed to start collab session",
			});
		},
	},
	{
		name: "remote-control",
		description: "Control this session from a phone, browser, or Kanban",
		inlineHint: "[start|view|status|stop|kanban] [relayUrl]",
		subcommands: [
			{ name: "start", description: "Share a writable remote-control link" },
			{ name: "view", description: "Share a read-only watch link" },
			{ name: "status", description: "Show link, participants, and capabilities" },
			{ name: "stop", description: "Stop remote control" },
			{ name: "kanban", description: "Open this repository in pk-kanban" },
		],
		allowArgs: true,
		handle: async (_command, runtime) => {
			await runtime.output(
				"Remote control requires the interactive TUI. Start `oh-my-pk` in a terminal, then run `/remote-control`.",
			);
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const args = command.args.trim();
			const { verb, rest } = parseSubcommand(args);
			if (verb === "stop") {
				if (!ctx.collabHost) {
					ctx.showStatus("Remote control is not running");
					return;
				}
				await ctx.collabHost.stop("remote control stopped");
				ctx.showStatus("Remote control stopped");
				return;
			}
			if (verb === "status") {
				ctx.showStatus(formatRemoteControlStatus(ctx));
				return;
			}
			if (verb === "kanban") {
				openKanbanForRemoteControl(ctx);
				return;
			}
			const knownStartVerb = verb === "start" || verb === "view";
			const view = verb === "view";
			const explicitUrl = knownStartVerb ? rest : args;
			await startCollabShare(ctx, {
				relayInput: explicitUrl,
				view,
				missingRelayUsage:
					"No relay configured. Set collab.relayUrl in /settings or pass one: /remote-control relay.example.com",
				startedHeading: view ? "Read-only remote control started!" : "Remote control started!",
				activeHeading: view ? "Read-only remote control active" : "Remote control active",
				errorPrefix: "Failed to start remote control",
			});
		},
	},
	{
		name: "join",
		description: "Join a shared collab session",
		inlineHint: "<link>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const link = command.args.trim();
			if (!link) {
				ctx.showError("Usage: /join <link>");
				return;
			}
			if (ctx.collabHost) {
				ctx.showError("Stop hosting first (/collab stop)");
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError("Already in a collab session (/leave first)");
				return;
			}
			try {
				await new CollabGuestLink(ctx).join(link);
			} catch (err) {
				ctx.showError(`Failed to join collab session: ${errorMessage(err)}`);
			}
		},
	},
	{
		name: "leave",
		description: "Leave the collab session",
		handleTui: async (_command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			if (ctx.collabGuest) {
				await ctx.collabGuest.leave("left");
				return;
			}
			if (ctx.collabHost) {
				await ctx.collabHost.stop("host stopped");
				ctx.showStatus("Collab stopped");
				return;
			}
			ctx.showStatus("Not in a collab session");
		},
	},
	{
		name: "browser",
		description: "Toggle browser headless vs visible mode",
		acpInputHint: "[headless|visible]",
		subcommands: [
			{ name: "headless", description: "Switch to headless mode" },
			{ name: "visible", description: "Switch to visible mode" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const enabled = runtime.settings.get("browser.enabled" as SettingPath) as boolean;
			if (!enabled) return usage("Browser tool is disabled (enable in settings).", runtime);
			const current = runtime.settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!arg) next = !current;
			else if (arg === "headless" || arg === "hidden") next = true;
			else if (arg === "visible" || arg === "show" || arg === "headful") next = false;
			else return usage("Usage: /browser [headless|visible]", runtime);
			runtime.settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (err) {
					// Setting was already mutated; surface the restart failure so the
					// user knows the browser is in an inconsistent state.
					await runtime.output(
						`Browser mode set to ${next ? "headless" : "visible"}, but restart failed: ${errorMessage(err)}`,
					);
					return commandConsumed();
				}
			}
			await runtime.output(`Browser mode: ${next ? "headless" : "visible"}`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const current = settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!(settings.get("browser.enabled" as SettingPath) as boolean)) {
				runtime.ctx.showWarning("Browser tool is disabled (enable in settings)");
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg) {
				next = !current;
			} else if (arg === "headless" || arg === "hidden") {
				next = true;
			} else if (arg === "visible" || arg === "show" || arg === "headful") {
				next = false;
			} else {
				runtime.ctx.showStatus("Usage: /browser [headless|visible]");
				runtime.ctx.editor.setText("");
				return;
			}
			settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.ctx.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (error) {
					runtime.ctx.showWarning(`Failed to restart browser: ${errorMessage(error)}`);
					runtime.ctx.editor.setText("");
					return;
				}
			}
			runtime.ctx.showStatus(`Browser mode: ${next ? "headless" : "visible"}`);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "copy",
		description: "Pick text or code from the conversation to copy",
		handleTui: (_command, runtime) => {
			runtime.ctx.showCopySelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "todo",
		description: "View or modify the agent's todo list",
		acpDescription: "Manage todos",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "show", description: "Show the sticky todo panel (TUI only)" },
			{ name: "hide", description: "Hide the sticky todo panel (TUI only)" },
			{ name: "toggle", description: "Toggle the sticky todo panel (TUI only)" },
			{ name: "edit", description: "Open todos in $EDITOR (Markdown round-trip)" },
			{ name: "copy", description: "Copy todos as Markdown to clipboard" },
			{ name: "export", description: "Write todos as Markdown to a file (default: TODO.md)", usage: "[<path>]" },
			{ name: "import", description: "Replace todos from a Markdown file (default: TODO.md)", usage: "[<path>]" },
			{
				name: "append",
				description: "Append a task; phase fuzzy-matched or auto-created",
				usage: "[<phase>] <task...>",
			},
			{ name: "start", description: "Mark task in_progress (fuzzy-matched)", usage: "<task>" },
			{ name: "done", description: "Mark task/phase/all completed (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "drop", description: "Mark task/phase/all abandoned (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "rm", description: "Remove task/phase/all (fuzzy-matched)", usage: "[<task|phase>]" },
		],
		allowArgs: true,
		handle: handleTodoAcp,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleTodoCommand(command.args);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "session",
		description: "Session management commands",
		acpDescription: "Show session information",
		acpInputHint: "info|delete",
		subcommands: [
			{ name: "info", description: "Show session info and stats" },
			{ name: "delete", description: "Delete current session and return to selector" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			if (!command.args || command.args === "info") {
				await runtime.output(
					[
						`Session: ${runtime.session.sessionId}`,
						`Title: ${runtime.session.sessionName}`,
						`CWD: ${runtime.cwd}`,
					].join("\n"),
				);
				return commandConsumed();
			}
			if (command.args === "delete") {
				if (runtime.session.isStreaming) return usage("Cannot delete the session while streaming.", runtime);
				const sessionFile = runtime.sessionManager.getSessionFile();
				if (!sessionFile) return usage("No session file to delete (in-memory session).", runtime);
				// Route through the active SessionManager so the persist writer is
				// closed before the file is deleted. Constructing a fresh
				// FileSessionStorage and calling deleteSessionWithArtifacts leaves
				// the active writer attached to the now-deleted path, so the next
				// prompt would silently resurrect or corrupt the "deleted" file.
				try {
					await runtime.sessionManager.dropSession(sessionFile);
				} catch (err) {
					return usage(`Failed to delete session: ${errorMessage(err)}`, runtime);
				}
				await runtime.output(
					`Session deleted: ${sessionFile}. Use ACP \`session/load\` to switch to another session.`,
				);
				return commandConsumed();
			}
			return usage("Usage: /session [info|delete]", runtime);
		},
		handleTui: async (command, runtime) => {
			const sub = command.args.trim().toLowerCase() || "info";
			if (sub === "delete") {
				runtime.ctx.editor.setText("");
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}
			// Default: show session info
			await runtime.ctx.handleSessionCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "jobs",
		description: "Show async background jobs status",
		acpDescription: "Show background jobs",
		handle: async (_command, runtime) => {
			const snapshot = runtime.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) {
				await runtime.output(
					"No background jobs running. (Background jobs run async tools — e.g. long-running bash, debug, or task subagents that would otherwise tie up a turn. They appear here while alive and for ~5 minutes after.)",
				);
				return commandConsumed();
			}
			const now = Date.now();
			const lines: string[] = ["Background Jobs", `Running: ${snapshot.running.length}`];
			if (snapshot.running.length > 0) {
				lines.push("", "Running Jobs");
				for (const job of snapshot.running) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			if (snapshot.recent.length > 0) {
				lines.push("", "Recent Jobs");
				for (const job of snapshot.recent) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleJobsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "background",
		description: "Save this session as a named background agent and open the Agent Hub",
		inlineHint: "[name]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const name = command.args.trim() || runtime.ctx.session.sessionManager.getSessionName() || "Background agent";
			const ok = await runtime.ctx.session.backgroundCurrentSession(name);
			runtime.ctx.editor.setText("");
			if (!ok) {
				runtime.ctx.showWarning("Could not background session: name is empty after sanitization.");
				return;
			}
			const displayName = runtime.ctx.session.sessionManager.getSessionName() ?? name;
			runtime.ctx.showStatus(`Backgrounded session as ${displayName}`);
			runtime.ctx.showAgentHub();
		},
	},
	{
		name: "backgrounds",
		description: "Open the Agent Hub (background sessions and subagents)",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			runtime.ctx.showAgentHub();
		},
	},
	{
		name: "usage",
		description: "Show provider usage and limits",
		acpDescription: "Show token usage",
		acpInputHint: "[show|reset [account|active]]",
		subcommands: [
			{ name: "show", description: "Show provider usage and limits" },
			{ name: "reset", description: "Spend a saved Codex rate-limit reset", usage: "[account|active]" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.output(await buildUsageReportText(runtime));
				return commandConsumed();
			}
			if (verb === "reset") {
				await handleUsageResetCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage("Usage: /usage [show|reset [account|active]]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.ctx.handleUsageCommand();
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "reset") {
				if (rest) {
					await handleUsageResetCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
				} else {
					await runtime.ctx.showResetUsageSelector();
				}
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /usage [show|reset [account|active]]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "9router",
		description: "Route model roles through the local 9router gateway",
		subcommands: [
			{ name: "route", description: "Route all roles using the 9router model list" },
			{ name: "probe", description: "Route all roles using a small chat probe" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			if (verb === "route" || !verb) {
				await runNineRouterSlashCommand(runtime.settings, "list", runtime.output);
				return commandConsumed();
			}
			if (verb === "probe") {
				await runNineRouterSlashCommand(runtime.settings, "probe", runtime.output);
				return commandConsumed();
			}
			return usage("Usage: /9router [route|probe]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			if (verb === "route" || !verb) {
				await runNineRouterSlashCommand(runtime.ctx.settings, "list", text => runtime.ctx.showStatus(text));
			} else if (verb === "probe") {
				await runNineRouterSlashCommand(runtime.ctx.settings, "probe", text => runtime.ctx.showStatus(text));
			} else {
				runtime.ctx.showStatus("Usage: /9router [route|probe]");
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "stats",
		description: "Launch the local stats dashboard",
		inlineHint: "[--port <port>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const parsed = parseStatsDashboardArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);

			await runtime.output("Syncing session files...");
			try {
				const result = await launchStatsDashboard(parsed);
				await runtime.output(result.message);
			} catch (error) {
				await runtime.output(`Stats dashboard failed: ${errorMessage(error)}`);
			}
			return commandConsumed();
		},
	},
	{
		name: "changelog",
		description: "Show changelog entries",
		acpDescription: "Show changelog",
		acpInputHint: "[full]",
		subcommands: [{ name: "full", description: "Show complete changelog" }],
		allowArgs: true,
		handle: async (command, runtime) => {
			const changelogPath = getChangelogPath();
			const allEntries = await parseChangelog(changelogPath);
			const showFull = command.args.trim().toLowerCase() === "full";
			const entriesToShow = showFull ? allEntries : allEntries.slice(0, 3);
			if (entriesToShow.length === 0) {
				await runtime.output("No changelog entries found.");
				return commandConsumed();
			}
			await runtime.output(
				[...entriesToShow]
					.reverse()
					.map(entry => entry.content)
					.join("\n\n"),
			);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const showFull = command.args.split(/\s+/).filter(Boolean).includes("full");
			await runtime.ctx.handleChangelogCommand(showFull);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "okf",
		description: "Inspect and validate the OKF (Open Knowledge Format) knowledge bundle",
		acpDescription: "Inspect the OKF knowledge bundle",
		acpInputHint: "[list|show <id>|lint]",
		subcommands: [
			{ name: "list", description: "List every discovered concept" },
			{ name: "show", description: "Show one concept's frontmatter and body", usage: "<id>" },
			{ name: "lint", description: "Validate concepts against OKF v0.1 conformance rules" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			await handleOkfSlashCommand(command.args, runtime);
			return commandConsumed();
		},
	},
	{
		name: "hotkeys",
		description: "Show all keyboard shortcuts",
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "tools",
		description: "Show tools currently visible to the agent",
		acpDescription: "Show available tools",
		handle: async (_command, runtime) => {
			const active = runtime.session.getActiveToolNames();
			const all = runtime.session.getAllToolNames();
			if (all.length === 0) {
				await runtime.output("No tools are available.");
				return commandConsumed();
			}
			await runtime.output(all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`).join("\n"));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "context",
		description: "Show estimated context usage breakdown",
		acpDescription: "Show context usage",
		handle: async (_command, runtime) => {
			await runtime.output(buildContextReportText(runtime));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleContextCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "extensions",
		aliases: ["status"],
		description: "Open Extension Control Center dashboard",
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "agents",
		description: "Open Agent Control Center dashboard",
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "branch",
		description: "Create a new branch from a previous message",
		handleTui: (_command, runtime) => {
			if (settings.get("doubleEscapeAction") === "tree") {
				runtime.ctx.showTreeSelector();
			} else {
				runtime.ctx.showUserMessageSelector();
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fork",
		description: "Create a new fork from a previous message",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleForkCommand();
		},
	},
	{
		name: "tree",
		description: "Navigate session tree (switch branches)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "login",
		description: "Login with OAuth provider",
		inlineHint: "[provider|redirect URL]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			if (args.length > 0) {
				const matchedProvider = resolveOAuthProvider(args);
				if (matchedProvider) {
					if (manualInput.hasPending()) {
						const pendingProvider = manualInput.pendingProviderId;
						const message = pendingProvider
							? `OAuth login already in progress for ${pendingProvider}. Paste the redirect URL with /login <url>.`
							: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
						runtime.ctx.showWarning(message);
						runtime.ctx.editor.setText("");
						return;
					}
					void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
					runtime.ctx.editor.setText("");
					return;
				}
				const submitted = manualInput.submit(args);
				if (submitted) {
					runtime.ctx.showStatus("OAuth callback received; completing login…");
				} else {
					runtime.ctx.showWarning("No OAuth login is waiting for a manual callback.");
				}
				runtime.ctx.editor.setText("");
				return;
			}

			if (manualInput.hasPending()) {
				const provider = manualInput.pendingProviderId;
				const message = provider
					? `OAuth login already in progress for ${provider}. Paste the redirect URL with /login <url>.`
					: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
				runtime.ctx.showWarning(message);
				runtime.ctx.editor.setText("");
				return;
			}

			void runtime.ctx.showOAuthSelector("login");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "logout",
		description: "Logout from OAuth provider",
		inlineHint: "[provider]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const providerId = command.args.trim();
			if (providerId) {
				const matchedProvider = resolveOAuthProvider(providerId);
				if (!matchedProvider) {
					runtime.ctx.showWarning(`Unknown OAuth provider: ${providerId}`);
					runtime.ctx.editor.setText("");
					return;
				}
				void runtime.ctx.showOAuthSelector("logout", matchedProvider.id);
				runtime.ctx.editor.setText("");
				return;
			}
			void runtime.ctx.showOAuthSelector("logout");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "mcp",
		description: "Manage MCP servers (add, list, remove, test)",
		acpDescription: "Manage MCP servers",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add a new MCP server",
				usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]",
			},
			{ name: "list", description: "List all configured MCP servers" },
			{ name: "remove", description: "Remove an MCP server", usage: "<name> [--scope project|user]" },
			{ name: "test", description: "Test connection to a server", usage: "<name>" },
			{ name: "reauth", description: "Reauthorize OAuth for a server", usage: "<name>" },
			{ name: "unauth", description: "Remove OAuth auth from a server", usage: "<name>" },
			{ name: "enable", description: "Enable an MCP server", usage: "<name>" },
			{ name: "disable", description: "Disable an MCP server", usage: "<name>" },
			{
				name: "smithery-search",
				description: "Search Smithery registry and deploy an MCP server",
				usage: "<keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			},
			{ name: "smithery-login", description: "Login to Smithery and cache API key" },
			{ name: "smithery-logout", description: "Remove cached Smithery API key" },
			{ name: "reconnect", description: "Reconnect to a specific MCP server", usage: "<name>" },
			{ name: "reload", description: "Force reload MCP runtime tools" },
			{ name: "resources", description: "List available resources from connected servers" },
			{ name: "prompts", description: "List available prompts from connected servers" },
			{ name: "notifications", description: "Show notification capabilities and subscriptions" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: handleMcpAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMCPCommand(command.text);
		},
	},
	{
		name: "ssh",
		description: "Manage SSH hosts (add, list, remove)",
		acpDescription: "Manage SSH connections",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add an SSH host",
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>]",
			},
			{ name: "list", description: "List all configured SSH hosts" },
			{ name: "remove", description: "Remove an SSH host", usage: "<name> [--scope project|user]" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: handleSshAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleSSHCommand(command.text);
		},
	},
	{
		name: "new",
		description: "Start a new session",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleClearCommand();
		},
	},
	{
		name: "fresh",
		description: "Reset provider stream state without changing the local transcript",
		handle: async (_command, runtime) => {
			const result = runtime.session.freshSession();
			if (!result) {
				await runtime.output(
					"Wait for the current response to finish or abort it before refreshing provider state.",
				);
				return commandConsumed();
			}
			await runtime.output(formatFreshSessionResult(result));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleFreshCommand();
		},
	},
	{
		name: "drop",
		description: "Delete the current session and start a new one",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleDropCommand();
		},
	},
	{
		name: "compact",
		description: "Manually compact the session context",
		acpDescription: "Compact the conversation",
		subcommands: COMPACT_MODES.map(mode => ({
			name: mode.name,
			description: mode.description,
			usage: "[focus]",
		})),
		acpInputHint: `[${COMPACT_MODES.map(mode => mode.name).join("|")}] [focus]`,
		allowArgs: true,
		handle: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);
			const before = runtime.session.getContextUsage?.();
			const beforeTokens = before?.tokens;
			try {
				await runtime.session.compact(parsed.instructions, parsed.mode ? { mode: parsed.mode } : undefined);
			} catch (err) {
				// Compaction precondition failures (no model, already compacted, too
				// small) and provider errors propagate as plain Errors; surface them
				// via runtime.output so they don't fail the ACP prompt turn.
				return usage(`Compaction failed: ${errorMessage(err)}`, runtime);
			}
			const after = runtime.session.getContextUsage?.();
			const afterTokens = after?.tokens;
			if (beforeTokens != null && afterTokens != null) {
				const saved = beforeTokens - afterTokens;
				await runtime.output(`Compaction complete. Tokens: ${beforeTokens} -> ${afterTokens} (saved ${saved}).`);
			} else {
				await runtime.output("Compaction complete.");
			}
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			runtime.ctx.editor.setText("");
			if ("error" in parsed) {
				runtime.ctx.showWarning(parsed.error);
				return;
			}
			await runtime.ctx.handleCompactCommand(parsed.instructions, parsed.mode);
		},
	},
	{
		name: "prune",
		description: "Prune stale tool results from context",
		acpDescription: "Prune stale tool results",
		handle: async (_command, runtime) => {
			const result = await runtime.session.prune();
			if (result.prunedCount === 0) {
				await runtime.output("Prune complete. No stale tool results found.");
				return commandConsumed();
			}
			const noun = result.prunedCount === 1 ? "tool result" : "tool results";
			await runtime.output(
				`Prune complete. Pruned ${result.prunedCount} ${noun}, saved ${result.tokensSaved} tokens.`,
			);
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			const result = await runtime.ctx.session.prune();
			if (result.prunedCount > 0) {
				runtime.ctx.rebuildChatFromMessages();
			}
			const message =
				result.prunedCount === 0
					? "Prune complete. No stale tool results found."
					: `Prune complete. Pruned ${result.prunedCount} ${
							result.prunedCount === 1 ? "tool result" : "tool results"
						}, saved ${result.tokensSaved} tokens.`;
			runtime.ctx.showStatus(message);
			refreshStatusLine(runtime.ctx);
		},
	},
	{
		name: "shake",
		description: "Drop heavy content from context (tool results, large blocks)",
		acpDescription: "Shake heavy content out of the conversation context",
		subcommands: [
			{ name: "elide", description: "Strip tool results + large blocks (default)" },
			{ name: "images", description: "Strip image blocks" },
		],
		acpInputHint: "[elide|images]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") return usage(mode.error, runtime);
			const result = await runtime.session.shake(mode);
			await runtime.output(formatShakeSummary(result));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") {
				runtime.ctx.showWarning(mode.error);
				return;
			}
			await runtime.ctx.handleShakeCommand(mode);
		},
	},
	{
		name: "handoff",
		description: "Hand off session context to a new session",
		inlineHint: "[focus instructions]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const customInstructions = command.args || undefined;
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleHandoffCommand(customInstructions);
		},
	},
	{
		name: "resume",
		description: "Resume a different session",
		inlineHint: "[session-id]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const sessionArg = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			if (!sessionArg) {
				runtime.ctx.showSessionSelector();
				return;
			}
			// Direct resume by id/filename prefix: the active session directory is
			// checked first, then every cwd bucket (matching `omp --resume <id>`).
			const match = await resolveResumableSession(
				sessionArg,
				runtime.ctx.sessionManager.getCwd(),
				runtime.ctx.sessionManager.getSessionDir(),
				{ allowGlobalFallback: true },
			);
			if (!match) {
				runtime.ctx.showError(`Session "${sessionArg}" not found`);
				return;
			}
			await runtime.ctx.handleResumeSession(match.session.path);
		},
	},
	{
		name: "btw",
		description: "Ask an ephemeral side question using the current session context",
		inlineHint: "<question>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const question = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleBtwCommand(question);
		},
	},
	{
		name: "tan",
		description: "Run a full background agent on tangential work",
		inlineHint: "[--cwd <path>] <work>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const args = command.text.slice(`/${command.name}`.length).trim();

			let cwdOverride: string | undefined;
			let work = args;

			if (args.startsWith("--cwd")) {
				const cwdMatch =
					args.match(/^--cwd\s+"([^"]+)"\s+(.+)$/s) ||
					args.match(/^--cwd\s+'([^']+)'\s+(.+)$/s) ||
					args.match(/^--cwd\s+(\S+)\s+(.+)$/s);
				if (!cwdMatch) {
					runtime.ctx.showStatus("Usage: /tan [--cwd <path>] <work>");
					return;
				}
				cwdOverride = path.resolve(runtime.ctx.sessionManager.getCwd(), cwdMatch[1]);
				work = cwdMatch[2].trim();
				const stat = await fs.stat(cwdOverride).catch(() => null);
				if (!stat?.isDirectory()) {
					runtime.ctx.showError(`CWD does not exist or is not a directory: ${cwdOverride}`);
					return;
				}
			}

			runtime.ctx.editor.setText("");
			await runtime.ctx.handleTanCommand(work, cwdOverride);
		},
	},
	{
		name: "omfg",
		description: "Forge a TTSR rule from a complaint to stop a recurring behavior",
		inlineHint: "<complaint>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const complaint = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleOmfgCommand(complaint);
		},
	},
	{
		name: "retry",
		description: "Retry the last failed agent turn",
		handleTui: async (_command, runtime) => {
			const didRetry = await runtime.ctx.session.retry();
			if (!didRetry) {
				runtime.ctx.showStatus("Nothing to retry");
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "debug",
		description: "Open debug tools selector",
		allowArgs: true,
		subcommands: [
			{
				name: "dump-next-request",
				description: "Dump the next AI provider HTTP request as JSON",
				usage: "<path>",
			},
		],
		handle: async (command, runtime) =>
			handleDebugSubcommand(command.args, runtime.cwd, text => runtime.output(text)),
		handleTui: async (command, runtime) => {
			const args = command.args.trim();
			if (args.length === 0) {
				runtime.ctx.showDebugSelector();
			} else {
				await handleDebugSubcommand(args, runtime.ctx.sessionManager.getCwd(), text =>
					runtime.ctx.showStatus(text),
				);
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "memory",
		description: "Inspect and operate memory maintenance",
		acpDescription: "Manage memory",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "view", description: "Show current memory injection payload" },
			{ name: "stats", description: "Show memory backend statistics" },
			{ name: "diagnose", description: "Run memory backend diagnostics" },
			{ name: "clear", description: "Clear persisted memory data and artifacts" },
			{ name: "reset", description: "Alias for clear" },
			{ name: "enqueue", description: "Enqueue memory consolidation maintenance" },
			{ name: "rebuild", description: "Alias for enqueue" },
			{ name: "mm list", description: "List mental models on the active bank" },
			{ name: "mm show", description: "Show one mental model (id required)" },
			{
				name: "mm refresh",
				description: "Refresh auto-refresh models bank-wide, or one model by id",
			},
			{ name: "mm history", description: "Diff the change history of a mental model" },
			{ name: "mm seed", description: "Create any built-in mental models that are missing" },
			{ name: "mm delete", description: "Delete a mental model from the bank (id required)" },
			{ name: "mm reload", description: "Re-pull the cached <mental_models> block" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const verb = (command.args.trim().split(/\s+/)[0] ?? "").toLowerCase() || "view";
			const backend = await resolveMemoryBackend(runtime.settings);
			switch (verb) {
				case "view": {
					const payload = await backend.buildDeveloperInstructions(
						runtime.settings.getAgentDir(),
						runtime.settings,
						runtime.session,
					);
					await runtime.output(payload || "Memory payload is empty.");
					return commandConsumed();
				}
				case "clear":
				case "reset": {
					await backend.clear(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.session.refreshBaseSystemPrompt();
					await runtime.output("Memory cleared.");
					return commandConsumed();
				}
				case "enqueue":
				case "rebuild": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output("Memory consolidation enqueued.");
					return commandConsumed();
				}
				case "stats":
				case "diagnose": {
					const hook = verb === "stats" ? backend.stats : backend.diagnose;
					const payload = await hook?.(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(payload ?? `Memory ${verb} is not available for the ${backend.id} backend.`);
					return commandConsumed();
				}
				case "mm":
					return usage(
						"Mental-model maintenance via /memory mm is unsupported in ACP mode; use the hindsight HTTP API directly.",
						runtime,
					);
				default:
					return usage("Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild>", runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMemoryCommand(command.text);
		},
	},
	{
		name: "rename",
		description: "Rename the current session",
		inlineHint: "<title>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (!command.args) return usage("Usage: /rename <title>", runtime);
			const ok = await runtime.sessionManager.setSessionName(command.args, "user");
			if (!ok) {
				await runtime.output("Session name not changed (a user-set name takes precedence).");
				return commandConsumed();
			}
			await runtime.notifyTitleChanged?.();
			await runtime.output(`Session renamed to ${command.args}.`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const title = command.args.trim();
			if (!title) {
				runtime.ctx.showError("Usage: /rename <title>");
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleRenameCommand(title);
		},
	},
	{
		name: "move",
		description: "Move session to a different working directory",
		acpDescription: "Move the current session file",
		inlineHint: "<path>",
		allowArgs: true,
		getArgumentCompletions: completeMoveDirectories,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("Cannot move while streaming.", runtime);
			if (!command.args) return usage("Usage: /move <path>", runtime);
			const resolvedPath = path.resolve(runtime.cwd, command.args);
			let isDirectory: boolean;
			try {
				isDirectory = (await fs.stat(resolvedPath)).isDirectory();
			} catch {
				return usage(`Directory does not exist or is not a directory: ${resolvedPath}`, runtime);
			}
			if (!isDirectory) return usage(`Directory does not exist or is not a directory: ${resolvedPath}`, runtime);
			try {
				await runtime.sessionManager.flush();
				await runtime.sessionManager.moveTo(resolvedPath);
			} catch (err) {
				return usage(`Move failed: ${errorMessage(err)}`, runtime);
			}
			setProjectDir(resolvedPath);
			// Reload plugin/capability caches so the next prompt sees commands and
			// capabilities scoped to the new cwd.
			await runtime.reloadPlugins();
			await runtime.notifyTitleChanged?.();
			await runtime.output(`Session moved to ${runtime.sessionManager.getCwd()}.`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMoveCommand(command.args.trim() || undefined);
		},
	},
	{
		name: "exit",
		description: "Exit the application",
		handleTui: shutdownHandlerTui,
	},
	{
		name: "marketplace",
		description: "Manage marketplace plugin sources and installed plugins",
		acpDescription: "Manage plugins from marketplaces",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "add", description: "Add a marketplace source", usage: "<source>" },
			{ name: "remove", description: "Remove a marketplace source", usage: "<name>" },
			{ name: "update", description: "Update marketplace catalog(s)", usage: "[name]" },
			{ name: "list", description: "List configured marketplaces" },
			{ name: "discover", description: "Browse available plugins", usage: "[marketplace]" },
			{
				name: "install",
				description: "Install a plugin (interactive browser if no args)",
				usage: "[--force] [name@marketplace]",
			},
			{ name: "uninstall", description: "Uninstall a plugin (selector if no args)", usage: "[name@marketplace]" },
			{ name: "installed", description: "List installed marketplace plugins" },
			{ name: "upgrade", description: "Upgrade outdated plugins", usage: "[name@marketplace]" },
			{ name: "help", description: "Show usage guide" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb) {
				try {
					const manager = await createMarketplaceManager(runtime);
					const marketplaces = await manager.listMarketplaces();
					if (marketplaces.length === 0) {
						await runtime.output(
							"No marketplaces configured.\n\nGet started:\n  /marketplace add anthropics/claude-plugins-official\n\nThen browse with /marketplace discover",
						);
					} else {
						const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
						await runtime.output(
							`Marketplaces:\n${lines.join("\n")}\n\nUse /marketplace discover to browse plugins, or /marketplace help for all commands`,
						);
					}
					return commandConsumed();
				} catch (err) {
					return usage(`Marketplace error: ${errorMessage(err)}`, runtime);
				}
			}
			if (verb === "help") {
				await runtime.output(
					[
						"Marketplace commands:",
						"  /marketplace                              List configured marketplaces",
						"  /marketplace add <source>                  Add a marketplace (e.g. owner/repo)",
						"  /marketplace remove <name>                 Remove a marketplace",
						"  /marketplace update [name]                 Re-fetch catalog(s)",
						"  /marketplace list                          List configured marketplaces",
						"  /marketplace discover [marketplace]        Browse available plugins",
						"  /marketplace install <name@marketplace>    Install a plugin",
						"  /marketplace uninstall <name@marketplace>  Uninstall a plugin",
						"  /marketplace installed                     List installed plugins",
						"  /marketplace upgrade [name@marketplace]    Upgrade plugin(s)",
						"",
						"Quick start:",
						"  /marketplace add anthropics/claude-plugins-official",
					].join("\n"),
				);
				return commandConsumed();
			}
			if ((verb === "install" || verb === "uninstall") && !rest) {
				return usage(
					"Interactive plugin pickers are TUI-only. Pass an explicit name@marketplace argument.",
					runtime,
				);
			}
			try {
				const manager = await createMarketplaceManager(runtime);
				switch (verb) {
					case "add": {
						if (!rest) return usage("Usage: /marketplace add <source>", runtime);
						const entry = await manager.addMarketplace(rest);
						await runtime.output(`Added marketplace: ${entry.name}`);
						return commandConsumed();
					}
					case "remove":
					case "rm": {
						if (!rest) return usage("Usage: /marketplace remove <name>", runtime);
						await manager.removeMarketplace(rest);
						await runtime.output(`Removed marketplace: ${rest}`);
						return commandConsumed();
					}
					case "update": {
						if (rest) {
							await manager.updateMarketplace(rest);
							await runtime.output(`Updated marketplace: ${rest}`);
						} else {
							const results = await manager.updateAllMarketplaces();
							await runtime.output(`Updated ${results.length} marketplace(s)`);
						}
						return commandConsumed();
					}
					case "list": {
						const marketplaces = await manager.listMarketplaces();
						if (marketplaces.length === 0) {
							await runtime.output("No marketplaces configured.");
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							await runtime.output(`Marketplaces:\n${lines.join("\n")}`);
						}
						return commandConsumed();
					}
					case "discover": {
						const plugins = await manager.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await manager.listMarketplaces();
							await runtime.output(
								marketplaces.length === 0
									? "No marketplaces configured. Try:\n  /marketplace add anthropics/claude-plugins-official"
									: "No plugins available in configured marketplaces",
							);
							return commandConsumed();
						}
						const lines = ["Available plugins:"];
						for (const plugin of plugins) {
							lines.push(`  - ${plugin.name}${plugin.version ? `@${plugin.version}` : ""}`);
							if (plugin.description) lines.push(`      ${plugin.description}`);
						}
						await runtime.output(lines.join("\n"));
						return commandConsumed();
					}
					case "install": {
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) return usage(parsed.error, runtime);
						const atIndex = parsed.installSpec.lastIndexOf("@");
						const pluginName = parsed.installSpec.slice(0, atIndex);
						const marketplace = parsed.installSpec.slice(atIndex + 1);
						await manager.installPlugin(pluginName, marketplace, { force: parsed.force, scope: parsed.scope });
						await runtime.reloadPlugins();
						await runtime.output(`Installed ${pluginName} from ${marketplace}`);
						return commandConsumed();
					}
					case "uninstall": {
						const parsed = parsePluginScopeArgs(
							rest,
							"Usage: /marketplace uninstall [--scope user|project] <name@marketplace>",
						);
						if ("error" in parsed) return usage(parsed.error, runtime);
						await manager.uninstallPlugin(parsed.pluginId, parsed.scope);
						await runtime.reloadPlugins();
						await runtime.output(`Uninstalled ${parsed.pluginId}`);
						return commandConsumed();
					}
					case "installed": {
						const installed = await manager.listInstalledPlugins();
						if (installed.length === 0) {
							await runtime.output("No marketplace plugins installed");
						} else {
							const lines = installed.map(
								p => `  ${p.id} [${p.scope}]${p.shadowedBy ? " [shadowed]" : ""} (${p.entries.length} entry)`,
							);
							await runtime.output(`Installed plugins:\n${lines.join("\n")}`);
						}
						return commandConsumed();
					}
					case "upgrade": {
						if (rest) {
							const parsed = parsePluginScopeArgs(
								rest,
								"Usage: /marketplace upgrade [--scope user|project] <name@marketplace>",
							);
							if ("error" in parsed) return usage(parsed.error, runtime);
							const result = await manager.upgradePlugin(parsed.pluginId, parsed.scope);
							await runtime.reloadPlugins();
							await runtime.output(`Upgraded ${parsed.pluginId} to ${result.version}`);
							return commandConsumed();
						}
						const results = await manager.upgradeAllPlugins();
						if (results.length === 0) {
							await runtime.output("All marketplace plugins are up to date");
						} else {
							await runtime.reloadPlugins();
							const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
							await runtime.output(`Upgraded ${results.length} plugin(s):\n${lines.join("\n")}`);
						}
						return commandConsumed();
					}
					default:
						return usage(
							`Unknown /marketplace subcommand: ${verb}. Use /marketplace help for available commands.`,
							runtime,
						);
				}
			} catch (err) {
				return usage(`Marketplace error: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "install";
			const rest = args.slice(1).join(" ").trim();

			// /marketplace (no args) or /marketplace install (no args) → interactive browser
			if ((sub === "install" && !rest) || (!args[0] && !command.args.trim())) {
				try {
					runtime.ctx.showPluginSelector("install");
				} catch (err) {
					runtime.ctx.showStatus(`Marketplace error: ${err}`);
				}
				return;
			}

			const mgr = new MarketplaceManager({
				marketplacesRegistryPath: getMarketplacesRegistryPath(),
				installedRegistryPath: getInstalledPluginsRegistryPath(),
				projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
					runtime.ctx.sessionManager.getCwd(),
				),
				marketplacesCacheDir: getMarketplacesCacheDir(),
				pluginsCacheDir: getPluginsCacheDir(),
				clearPluginRootsCache: clearPluginRootsAndCaches,
			});

			try {
				switch (sub) {
					case "add": {
						if (!rest) {
							runtime.ctx.showStatus("Usage: /marketplace add <source>");
							return;
						}
						const entry = await mgr.addMarketplace(rest);
						runtime.ctx.showStatus(`Added marketplace: ${entry.name}`);
						break;
					}
					case "remove":
					case "rm": {
						if (!rest) {
							runtime.ctx.showStatus("Usage: /marketplace remove <name>");
							return;
						}
						await mgr.removeMarketplace(rest);
						runtime.ctx.showStatus(`Removed marketplace: ${rest}`);
						break;
					}
					case "update": {
						if (rest) {
							await mgr.updateMarketplace(rest);
							runtime.ctx.showStatus(`Updated marketplace: ${rest}`);
						} else {
							const results = await mgr.updateAllMarketplaces();
							runtime.ctx.showStatus(`Updated ${results.length} marketplace(s)`);
						}
						break;
					}
					case "discover": {
						const plugins = await mgr.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await mgr.listMarketplaces();
							if (marketplaces.length === 0) {
								runtime.ctx.showStatus(
									"No marketplaces configured. Try:\n  /marketplace add anthropics/claude-plugins-official",
								);
							} else {
								runtime.ctx.showStatus("No plugins available in configured marketplaces");
							}
						} else {
							const lines = plugins.map(
								p =>
									`  ${p.name}${p.version ? `@${p.version}` : ""}${p.description ? ` - ${p.description}` : ""}`,
							);
							runtime.ctx.showStatus(`Available plugins:\n${lines.join("\n")}`);
						}
						break;
					}
					case "install": {
						// Parse: /marketplace install [--force] [--scope user|project] name@marketplace
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const atIdx = parsed.installSpec.lastIndexOf("@");
						const name = parsed.installSpec.slice(0, atIdx);
						const marketplace = parsed.installSpec.slice(atIdx + 1);
						await mgr.installPlugin(name, marketplace, { force: parsed.force, scope: parsed.scope });
						runtime.ctx.showStatus(`Installed ${name} from ${marketplace}`);
						break;
					}
					case "uninstall": {
						if (!rest) {
							// No args → open interactive uninstall selector
							runtime.ctx.showPluginSelector("uninstall");
							return;
						}
						const uninstArgs = parsePluginScopeArgs(
							rest,
							"Usage: /marketplace uninstall [--scope user|project] <name@marketplace>",
						);
						if ("error" in uninstArgs) {
							runtime.ctx.showStatus(uninstArgs.error);
							return;
						}
						await mgr.uninstallPlugin(uninstArgs.pluginId, uninstArgs.scope);
						runtime.ctx.showStatus(`Uninstalled ${uninstArgs.pluginId}`);
						break;
					}
					case "installed": {
						const installed = await mgr.listInstalledPlugins();
						if (installed.length === 0) {
							runtime.ctx.showStatus("No marketplace plugins installed");
						} else {
							const lines = installed.map(
								p => `  ${p.id} [${p.scope}]${p.shadowedBy ? " [shadowed]" : ""} (${p.entries.length} entry)`,
							);
							runtime.ctx.showStatus(`Installed plugins:\n${lines.join("\n")}`);
						}
						break;
					}
					case "upgrade": {
						if (rest) {
							const upArgs = parsePluginScopeArgs(
								rest,
								"Usage: /marketplace upgrade [--scope user|project] <name@marketplace>",
							);
							if ("error" in upArgs) {
								runtime.ctx.showStatus(upArgs.error);
								return;
							}
							const result = await mgr.upgradePlugin(upArgs.pluginId, upArgs.scope);
							runtime.ctx.showStatus(`Upgraded ${upArgs.pluginId} to ${result.version}`);
						} else {
							const results = await mgr.upgradeAllPlugins();
							if (results.length === 0) {
								runtime.ctx.showStatus("All marketplace plugins are up to date");
							} else {
								const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
								runtime.ctx.showStatus(`Upgraded ${results.length} plugin(s):\n${lines.join("\n")}`);
							}
						}
						break;
					}
					case "help": {
						runtime.ctx.showStatus(
							[
								"Marketplace commands:",
								"  /marketplace                              Browse and install plugins",
								"  /marketplace add <source>                  Add a marketplace (e.g. owner/repo)",
								"  /marketplace remove <name>                 Remove a marketplace",
								"  /marketplace update [name]                 Re-fetch catalog(s)",
								"  /marketplace list                          List configured marketplaces",
								"  /marketplace discover [marketplace]        Browse available plugins",
								"  /marketplace install <name@marketplace>    Install a plugin",
								"  /marketplace uninstall <name@marketplace>  Uninstall a plugin",
								"  /marketplace installed                     List installed plugins",
								"  /marketplace upgrade [name@marketplace]    Upgrade plugin(s)",
								"",
								"Quick start:",
								"  /marketplace add anthropics/claude-plugins-official",
								"  /marketplace                               (opens interactive browser)",
							].join("\n"),
						);
						break;
					}
					default: {
						const marketplaces = await mgr.listMarketplaces();
						if (marketplaces.length === 0) {
							runtime.ctx.showStatus(
								"No marketplaces configured.\n\nGet started:\n  /marketplace add anthropics/claude-plugins-official\n\nThen browse plugins with /marketplace or /marketplace discover",
							);
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							runtime.ctx.showStatus(
								`Marketplaces:\n${lines.join("\n")}\n\nUse /marketplace discover to browse plugins, or /marketplace help for all commands`,
							);
						}
						break;
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				runtime.ctx.showStatus(`Marketplace error: ${msg}`);
			}
		},
	},
	{
		name: "plugins",
		description: "View and manage installed plugins",
		acpDescription: "Manage plugins",
		acpInputHint: "[list|enable|disable]",
		subcommands: [
			{ name: "list", description: "List all installed plugins (npm + marketplace)" },
			{ name: "enable", description: "Enable a marketplace plugin", usage: "<name@marketplace>" },
			{ name: "disable", description: "Disable a marketplace plugin", usage: "<name@marketplace>" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			try {
				if (verb === "enable" || verb === "disable") {
					const parsed = parsePluginScopeArgs(
						rest,
						`Usage: /plugins ${verb} [--scope user|project] <name@marketplace>`,
					);
					if ("error" in parsed) return usage(parsed.error, runtime);
					const manager = await createMarketplaceManager(runtime);
					const isEnable = verb === "enable";
					await manager.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
					await runtime.reloadPlugins();
					await runtime.output(`${isEnable ? "Enabled" : "Disabled"} ${parsed.pluginId}`);
					return commandConsumed();
				}
				// Default: list
				const lines: string[] = [];
				const npmManager = new PluginManager();
				const npmPlugins = await npmManager.list();
				if (npmPlugins.length > 0) {
					lines.push("npm plugins:");
					for (const plugin of npmPlugins) {
						const status = plugin.enabled === false ? " (disabled)" : "";
						lines.push(`  ${plugin.name}@${plugin.version}${status}`);
					}
				}

				const marketplaceManager = await createMarketplaceManager(runtime);
				const marketplacePlugins = await marketplaceManager.listInstalledPlugins();
				if (marketplacePlugins.length > 0) {
					if (lines.length > 0) lines.push("");
					lines.push("marketplace plugins:");
					for (const plugin of marketplacePlugins) {
						const entry = plugin.entries[0];
						const status = entry?.enabled === false ? " (disabled)" : "";
						const shadowed = plugin.shadowedBy ? " [shadowed]" : "";
						lines.push(`  ${plugin.id} v${entry?.version ?? "?"}${status} [${plugin.scope}]${shadowed}`);
					}
				}

				await runtime.output(lines.length === 0 ? "No plugins installed" : lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(`Plugin error: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "list";
			const rest = args.slice(1).join(" ").trim();

			try {
				const mgr = new MarketplaceManager({
					marketplacesRegistryPath: getMarketplacesRegistryPath(),
					installedRegistryPath: getInstalledPluginsRegistryPath(),
					projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
						runtime.ctx.sessionManager.getCwd(),
					),
					marketplacesCacheDir: getMarketplacesCacheDir(),
					pluginsCacheDir: getPluginsCacheDir(),
					clearPluginRootsCache: clearPluginRootsAndCaches,
				});

				switch (sub) {
					case "enable":
					case "disable": {
						const parsed = parsePluginScopeArgs(
							rest ?? "",
							`Usage: /plugins ${sub} [--scope user|project] <name@marketplace>`,
						);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const isEnable = sub === "enable";
						await mgr.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
						runtime.ctx.showStatus(`${isEnable ? "Enabled" : "Disabled"} ${parsed.pluginId}`);
						break;
					}
					default: {
						const lines: string[] = [];

						const npm = new PluginManager();
						const npmPlugins = await npm.list();
						if (npmPlugins.length > 0) {
							lines.push("npm plugins:");
							for (const p of npmPlugins) {
								const status = p.enabled === false ? " (disabled)" : "";
								lines.push(`  ${p.name}@${p.version}${status}`);
							}
						}

						const mktPlugins = await mgr.listInstalledPlugins();
						if (mktPlugins.length > 0) {
							if (lines.length > 0) lines.push("");
							lines.push("marketplace plugins:");
							for (const p of mktPlugins) {
								const entry = p.entries[0];
								const status = entry?.enabled === false ? " (disabled)" : "";
								const shadowed = p.shadowedBy ? " [shadowed]" : "";
								lines.push(`  ${p.id} v${entry?.version ?? "?"}${status} [${p.scope}]${shadowed}`);
							}
						}

						if (lines.length === 0) {
							runtime.ctx.showStatus("No plugins installed");
						} else {
							runtime.ctx.showStatus(lines.join("\n"));
						}
						break;
					}
				}
			} catch (err) {
				runtime.ctx.showStatus(`Plugin error: ${err}`);
			}
		},
	},
	{
		name: "reload-plugins",
		description: "Reload all plugins (skills, commands, hooks, tools, agents, MCP)",
		acpDescription: "Reload all plugins",
		handle: async (_command, runtime) => {
			await runtime.reloadPlugins();
			await runtime.output("Plugins reloaded.");
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			// Invalidate registry fs caches and the plugin roots cache so
			// listClaudePluginRoots re-reads from disk on next access.
			const projectPath = await resolveActiveProjectRegistryPath(runtime.ctx.sessionManager.getCwd());
			clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
			// Skill discovery goes through the capability loader — without this
			// reset, reloadSkills() below would re-read the stale cached skill set.
			resetCapabilities();
			await runtime.ctx.session.reloadSkills();
			await runtime.ctx.refreshSlashCommandState();
			await runtime.ctx.session.refreshSshTool({ activateIfAvailable: true });
			runtime.ctx.showStatus("Plugins reloaded.");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "force",
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("Usage: /force:<tool-name> [prompt]");
				runtime.ctx.editor.setText("");
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.editor.setText("");

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "catgpt-fast",
		description: "Query CatGPT with fast intensity, or switch picker to fast when empty",
		inlineHint: "[prompt]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const prompt = command.args.trim();
			await handleCatGptCommand(prompt, "fast", runtime, false);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const prompt = command.args.trim();
			runtime.ctx.editor.setText("");
			await handleCatGptCommand(prompt, "fast", runtime, true);
		},
	},
	{
		name: "catgpt-pro",
		description: "Query CatGPT with pro/thinking intensity, or switch picker to pro when empty",
		inlineHint: "[prompt]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const prompt = command.args.trim();
			await handleCatGptCommand(prompt, "pro", runtime, false);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const prompt = command.args.trim();
			runtime.ctx.editor.setText("");
			await handleCatGptCommand(prompt, "pro", runtime, true);
		},
	},
	{
		name: "catgpt-normal",
		description: "Query CatGPT with balanced/normal intensity, or switch picker to normal when empty",
		inlineHint: "[prompt]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const prompt = command.args.trim();
			await handleCatGptCommand(prompt, "normal", runtime, false);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const prompt = command.args.trim();
			runtime.ctx.editor.setText("");
			await handleCatGptCommand(prompt, "normal", runtime, true);
		},
	},
	{
		name: "deep-research",
		description: "Run multi-step deep web research and produce a cited report",
		inlineHint: "<question>",
		allowArgs: true,
		handle: async (command, runtime) => {
			const question = command.args.trim();
			if (!question) return usage("Usage: /deep-research <question>", runtime);
			return { prompt: prompt.render(deepResearchCommandTemplate, { question }) };
		},
		handleTui: (command, runtime) => {
			const question = command.args.trim();
			runtime.ctx.editor.setText("");
			if (!question) {
				runtime.ctx.showError("Usage: /deep-research <question>");
				return;
			}
			return { prompt: prompt.render(deepResearchCommandTemplate, { question }) };
		},
	},
	{
		name: "irc",
		description: "Enable, disable, or inspect local IRC discovery",
		subcommands: [
			{ name: "on", description: "Enable IRC" },
			{ name: "off", description: "Disable IRC" },
			{ name: "status", description: "Show IRC status" },
		],
		inlineHint: "[on|off|status]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const action = command.args.trim().toLowerCase() || "status";
			const ipc = IrcIpc.global();
			if (action === "on") {
				await ipc.setEnabled(true);
				await runtime.output("IRC enabled.");
				return commandConsumed();
			}
			if (action === "off") {
				await ipc.setEnabled(false);
				await runtime.output("IRC disabled for this process.");
				return commandConsumed();
			}
			if (action === "status") {
				await runtime.output(ipc.enabled ? "IRC is on." : "IRC is off.");
				return commandConsumed();
			}
			return usage("Usage: /irc [on|off|status]", runtime);
		},
	},
	{
		name: "graphtree",
		aliases: ["gt", "fractal"],
		description: "Fractal-style multi-agent graph/tree node workflows",
		acpDescription: "Fractal multi-agent workflow tree",
		acpInputHint: "[status|list|agents|init|run|stop|steer|revive|merge|prune|help]",
		subcommands: [
			{ name: "status", description: "View active GraphTree node hierarchy (ASCII tree)" },
			{ name: "list", description: "List details of active GraphTree worktree nodes" },
			{ name: "agents", description: "View live recursive agent registry tree with status & activity" },
			{ name: "init", description: "Initialize an isolated GraphTree worktree node", usage: "<name> [branch]" },
			{ name: "run", description: "Launch a Fractal multi-agent tree execution plan", usage: "<objective>" },
			{ name: "stop", description: "Abort and release a subagent", usage: "<agent-id>" },
			{
				name: "steer",
				description: "Send steering guidance to a subagent (revives if parked)",
				usage: "<agent-id> <guidance>",
			},
			{ name: "revive", description: "Revive a parked subagent", usage: "<agent-id>" },
			{ name: "merge", description: "Squash-merge a completed GraphTree node into HEAD", usage: "<name>" },
			{ name: "prune", description: "Clean up finished GraphTree worktree nodes" },
			{ name: "help", description: "Show GraphTree workflow help" },
		],
		allowArgs: true,
		handle: async (command, runtime) => handleGraphtreeCommand(command.args, runtime),
		handleTui: async (command, runtime) => handleGraphtreeCommandTui(command.args, runtime),
	},
	{
		name: "route",
		aliases: ["router", "pool"],
		description: "Configure dynamic multi-provider routing, pools, and fallbacks",
		acpDescription: "Manage dynamic multi-provider model routing and fallbacks",
		inlineHint: "[status|on|off|pool|veto|unpool|reset]",
		subcommands: [
			{ name: "status", description: "View routing status, configured pools, and provider cooldowns" },
			{ name: "on", description: "Enable dynamic multi-provider routing" },
			{ name: "off", description: "Disable dynamic multi-provider routing" },
			{ name: "pool", description: "Link models into a shared pool", usage: "<modelA> <modelB> [poolName]" },
			{ name: "veto", description: "Prevent models from being grouped together", usage: "<modelA> <modelB>" },
			{ name: "unpool", description: "Remove a pool or model from routing", usage: "<pool-id-or-model>" },
			{ name: "reset", description: "Reset active provider cooldowns" },
		],
		allowArgs: true,
		handle: async (command, runtime) => handleRouteSlashCommand(command, runtime),
	},
	{
		name: "quit",
		description: "Quit the application",
		handleTui: shutdownHandlerTui,
	},
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: ReadonlySet<string> = new Set(BUILTIN_SLASH_COMMAND_LOOKUP.keys());

/**
 * Build getArgumentCompletions from declarative subcommand definitions.
 * Returns subcommand names filtered by prefix in the dropdown.
 */
function buildArgumentCompletions(subcommands: SubcommandDef[]): (prefix: string) => AutocompleteItem[] | null {
	return (argumentPrefix: string) => {
		if (argumentPrefix.includes(" ")) return null; // past the subcommand
		const lower = argumentPrefix.toLowerCase();
		const matches = subcommands
			.filter(s => s.name.startsWith(lower))
			.map(s => ({
				value: `${s.name} `,
				label: s.name,
				description: s.description,
				hint: s.usage,
			}));
		return matches.length > 0 ? matches : null;
	};
}

/**
 * Build getInlineHint from declarative subcommand definitions.
 * Shows remaining completion + usage as dim ghost text after cursor.
 */
function buildSubcommandInlineHint(subcommands: SubcommandDef[]): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const trimmed = argumentText.trimStart();
		const spaceIndex = trimmed.indexOf(" ");

		if (spaceIndex === -1) {
			// Still typing subcommand name — show remaining chars + usage
			const prefix = trimmed.toLowerCase();
			if (prefix.length === 0) return null;
			const match = subcommands.find(s => s.name.startsWith(prefix));
			if (!match) return null;
			const remaining = match.name.slice(prefix.length);
			return remaining + (match.usage ? ` ${match.usage}` : "");
		}

		// Subcommand typed — show remaining usage params
		const subName = trimmed.slice(0, spaceIndex).toLowerCase();
		const afterSub = trimmed.slice(spaceIndex + 1);
		const sub = subcommands.find(s => s.name === subName);
		if (!sub?.usage) return null;

		if (afterSub.length > 0) {
			const usageParts = sub.usage.split(" ");
			const inputParts = afterSub.trim().split(/\s+/);
			const remaining = usageParts.slice(inputParts.length);
			return remaining.length > 0 ? remaining.join(" ") : null;
		}

		return sub.usage;
	};
}

/**
 * Build getInlineHint for commands with a simple static hint string.
 * Shows the hint only when no arguments have been typed yet.
 */
function buildStaticInlineHint(hint: string): (argumentText: string) => string | null {
	return (argumentText: string) => (argumentText.trim().length === 0 ? hint : null);
}

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		aliases: command.aliases,
		description: command.description,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		persistInHistory: command.persistInHistory,
		getTuiAutocompleteDescription: command.getTuiAutocompleteDescription,
		getArgumentCompletions: command.getArgumentCompletions,
	}),
);

/**
 * Materialized builtin slash commands with completion functions derived from
 * declarative subcommand/hint definitions.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<
	BuiltinSlashCommand & {
		getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
		getInlineHint?: (argumentText: string) => string | null;
	}
> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd => {
	if (cmd.subcommands) {
		return {
			...cmd,
			getArgumentCompletions: cmd.getArgumentCompletions ?? buildArgumentCompletions(cmd.subcommands),
			getInlineHint: buildSubcommandInlineHint(cmd.subcommands),
		};
	}
	if (cmd.inlineHint) {
		return {
			...cmd,
			getInlineHint: buildStaticInlineHint(cmd.inlineHint),
		};
	}
	return cmd;
});

/**
 * Unified registry exposed for cross-mode tooling. Each spec carries at least
 * one of `handle` / `handleTui`. The TUI dispatcher prefers `handleTui`; the
 * ACP dispatcher requires `handle` and skips TUI-only entries.
 */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;
/** Whether editor prompt history may persist this builtin invocation. */
export function shouldPersistBuiltinSlashCommand(text: string): boolean {
	const parsed = parseSlashCommand(text);
	if (!parsed) return true;
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name)?.persistInHistory !== false;
}

/**
 * Execute a builtin slash command in the interactive TUI.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command
 * consumed the input entirely. Returns a `string` when the command was handled
 * but remaining text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}
	// Collab guests run a read-mostly replica: session-mutating builtins are
	// host-only; the allowlist covers purely local/read-only commands.
	if (runtime.ctx.collabGuest && !COLLAB_GUEST_ALLOWED_COMMANDS[command.name]) {
		runtime.ctx.showStatus(`/${command.name} is host-only during a collab session`);
		runtime.ctx.editor.setText("");
		return true;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		// No TUI-specific override → adapt the ACP/text-mode `handle` to the
		// TUI by routing `runtime.output` through `ctx.showStatus`, clearing
		// the editor after the call, and reusing the active session's plugin
		// reload pipeline. Spec authors get a single body usable from either
		// dispatcher without forcing every TUI test to construct the full
		// `SlashCommandRuntime` shape.
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: async () => {
				const projectPath = await resolveActiveProjectRegistryPath(ctx.sessionManager.getCwd());
				clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
				await ctx.refreshSlashCommandState();
				await ctx.session.refreshSshTool({ activateIfAvailable: true });
			},
		};
		const result = await command.handle(parsed, adapted);
		ctx.editor.setText("");
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };

function renderNineRouterRoutes(result: NineRouterRoutingResult): string {
	const lines = result.routes.map(
		route =>
			`${route.role}: ${route.selected ?? "unrouted"} (${route.available.length}/${route.candidates.length} available, ${route.probed.length} probed)`,
	);
	if (result.errors.length > 0) {
		lines.push(...result.errors.map(error => `error: ${error}`));
	}
	if (result.routes.some(r => r.selected === null)) {
		lines.push("Some roles could not be routed. Check that 9router is running and the combo names are configured.");
	}
	return lines.join("\n");
}

async function runNineRouterSlashCommand(
	settings: Settings,
	mode: "list" | "probe",
	output: (text: string) => void | Promise<void>,
): Promise<void> {
	const result = await applyNineRouterRouting(settings, { mode });
	await output(renderNineRouterRoutes(result));
}

async function handleCatGptCommand(
	promptText: string,
	intensity: string,
	runtime: SlashCommandRuntime | BuiltinSlashCommandRuntime,
	isTui: boolean,
): Promise<void> {
	const gatewayUrl = "http://127.0.0.1:8000";
	const token = "dummy123";

	if (isTui && "ctx" in runtime) {
		runtime.ctx.showStatus(`CatGPT (${intensity}): communicating...`);
	} else if ("output" in runtime) {
		await runtime.output(`CatGPT (${intensity}): communicating...`);
	}

	try {
		if (!promptText) {
			// No prompt, just switch the browser model picker
			const response = await fetch(`${gatewayUrl}/model/select`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					model: "catgpt-browser",
					intensity,
				}),
			});
			if (!response.ok) {
				const errText = await response.text();
				throw new Error(`Gateway returned HTTP ${response.status}: ${errText}`);
			}
			const data = (await response.json()) as { selected?: string };
			const selected = data.selected || "default";
			const msg = `CatGPT intensity switched to: ${intensity} (${selected})`;
			if (isTui && "ctx" in runtime) {
				runtime.ctx.showStatus(msg);
			} else if ("output" in runtime) {
				await runtime.output(msg);
			}
			return;
		}

		// Prompt is present, request completion
		const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				model: "catgpt-browser",
				messages: [{ role: "user", content: promptText }],
				intensity,
			}),
		});

		if (!response.ok) {
			const errText = await response.text();
			throw new Error(`Gateway returned HTTP ${response.status}: ${errText}`);
		}

		const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
		const reply = data.choices?.[0]?.message?.content;
		if (!reply) {
			throw new Error("No response content received from CatGPT.");
		}

		if (isTui && "ctx" in runtime) {
			runtime.ctx.showStatus(`CatGPT (${intensity}) complete.`);
			runtime.ctx.present([new Spacer(1), new Markdown(reply, 1, 0, getMarkdownTheme()), new Spacer(1)]);
		} else if ("output" in runtime) {
			await runtime.output(reply);
		}
	} catch (err: unknown) {
		const errMsg = `CatGPT Error: ${errorMessage(err)}`;
		if (isTui && "ctx" in runtime) {
			runtime.ctx.showError(errMsg);
		} else if ("output" in runtime) {
			await runtime.output(errMsg);
		}
	}
}

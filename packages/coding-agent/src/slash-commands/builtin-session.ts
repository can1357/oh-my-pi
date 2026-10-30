import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { clearSubmittedText } from "./helpers/draft";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { journalJudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import type { AgentSession } from "../session/agent-session";
import type { SessionOAuthAccountList } from "../session/agent-session-types";
import {
	getChangelogPath,
	parseChangelog,
	parseChangelogView,
	renderChangelogEntries,
	selectChangelogEntries,
} from "../utils/changelog";
import { formatTokenCount, refreshStatusLine } from "./builtin-modes";
import { buildContextReportText } from "./helpers/context-report";
import { formatCoarseDuration } from "@oh-my-pi/pi-tui/chrome/format";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { buildJobTree, jobTreeGuide, jobTreeIndent } from "@oh-my-pi/pi-tui/overlays/job-tree";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { handleMcpAcp } from "./helpers/mcp";
import { markdownFenceFor } from "../utils/markdown-fence";
import { openLocalFileInEditor } from "../modes/local-file-editor";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import {
	describeRedeemOutcome,
	formatResetUsageAccountLine,
	oneLine,
	resolveResetUsageTarget,
	toResetUsageAccounts,
} from "./helpers/reset-usage";
import type { ResetUsageAccount } from "@oh-my-pi/pi-tui/overlays/reset-usage-selector";
import { matchSessionPinAccounts, toSessionPinAccounts } from "./helpers/session-pin";
import {
	launchStatsDashboard,
	parseStatsDashboardArgs,
	type StatsDashboardArgs,
	type StatsDashboardLaunchResult,
} from "./helpers/stats-dashboard";
import { StatsNotice } from "@oh-my-pi/pi-tui/overlays/stats-notice";
import { handleTodoAcp } from "./helpers/todo";
import { buildUsageReportText } from "./helpers/usage-report";
import type { SlashCommandRuntime, SlashCommandSpec } from "./types";

async function handleUsageResetCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	let accounts: ResetUsageAccount[];
	try {
		accounts = toResetUsageAccounts(await session.listResetCredits());
	} catch (error) {
		await output(
			__ompTranslate("Could not load saved resets: {0}\u0004usage.reset.status", `${oneLine(errorMessage(error))}`),
		);
		return;
	}
	if (accounts.length === 0) {
		await output(__ompTranslate("No provider accounts found. Use /login to add one.\u0004usage.reset.status"));
		return;
	}
	if (!arg.trim()) {
		const lines = [
			__ompTranslate("Saved rate-limit resets:\u0004usage.reset.saved"),
			...accounts.map(formatResetUsageAccountLine),
		];
		lines.push(
			"",
			__ompTranslate(
				"Spend one with `/usage reset <provider>/<credential id>` or `/usage reset <provider>/active`.",
			),
		);
		await output(lines.join("\n"));
		return;
	}
	const resolved = resolveResetUsageTarget(accounts, arg, "/usage reset");
	if ("error" in resolved) {
		await output(resolved.error);
		return;
	}
	const outcome = await session.redeemResetCredit(resolved.account.target);
	await output(oneLine(describeRedeemOutcome(outcome, resolved.account.label)));
}

/**
 * `/jobs kill <id>|all`: cancel one running background job this session owns,
 * or every running one. Routes through the same owner-scoped
 * `AgentSession.cancelAsyncJob` the jobs sheet's `x`-to-cancel and
 * `proc://<id>/kill` use, so it can only touch jobs `/jobs` lists.
 */
async function handleJobsKillCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	const target = arg.trim();
	if (!target) {
		await output(__ompTranslate("Usage: /jobs kill <id>|all"));
		return;
	}
	const snapshot = session.getAsyncJobSnapshot({ recentLimit: 0 });
	if (!snapshot) {
		await output(__ompTranslate("Async background jobs are unavailable in this session."));
		return;
	}
	if (target === "all") {
		let cancelled = 0;
		for (const job of snapshot.running) {
			if (session.cancelAsyncJob(job.id)) cancelled += 1;
		}
		await output(
			cancelled === 0
				? __ompTranslate("No running background jobs to cancel.")
				: __ompTranslate("Cancelled {0} background job{1}.", `${cancelled}`, `${cancelled === 1 ? "" : "s"}`),
		);
		return;
	}
	const safeTarget = truncateToWidth(sanitizeText(target).replace(/\s+/g, " ").trim(), 60);
	if (!snapshot.running.some(job => job.id === target)) {
		await output(__ompTranslate('No running background job with id "{0}".', `${safeTarget}`));
		return;
	}
	await output(
		session.cancelAsyncJob(target)
			? __ompTranslate("Cancelled background job {0}.", `${safeTarget}`)
			: __ompTranslate("Could not cancel background job {0}.", `${safeTarget}`),
	);
}

async function handleSessionPinCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	if (session.isStreaming) {
		await output(
			__ompTranslate("Cannot pin an account while the session is streaming.\u0004provider.account.pin.status"),
		);
		return;
	}
	let accountList: SessionOAuthAccountList | undefined;
	try {
		accountList = await session.listCurrentProviderOAuthAccounts();
	} catch (error) {
		await output(
			__ompTranslate(
				"Could not load provider accounts: {0}\u0004provider.account.pin.status",
				`${errorMessage(error)}`,
			),
		);
		return;
	}
	if (!accountList) {
		await output(
			__ompTranslate("Select a model before pinning a provider account.\u0004provider.account.pin.status"),
		);
		return;
	}
	const provider = getOAuthProviders().find(candidate => candidate.id === accountList.provider);
	const providerName = provider?.name ?? accountList.provider;
	const accounts = toSessionPinAccounts(accountList.accounts);
	if (accounts.length === 0) {
		const source = session.modelRegistry.authStorage.keys.describe(accountList.provider, session.sessionId);
		await output(
			source
				? __ompTranslate(
						"No stored OAuth accounts for {0}. Current auth comes from {1}.\u0004provider.account.pin.status",
						`${providerName}`,
						`${source}`,
					)
				: __ompTranslate("No stored OAuth accounts for {0}. Use /login to add one.", `${providerName}`),
		);
		return;
	}

	const selector = arg.trim();
	if (!selector) {
		const lines = [__ompTranslate("OAuth accounts for {0}:", `${providerName}`)];
		for (const account of accounts) {
			lines.push(`${account.position + 1}. ${account.label}${account.active ? __ompTranslate(" (active)") : ""}`);
		}
		lines.push("", __ompTranslate("Pin one with `/session pin <number|email|account id>`."));
		await output(lines.join("\n"));
		return;
	}

	const matches = matchSessionPinAccounts(accounts, selector);
	if (matches.length === 0) {
		await output(`No ${providerName} account matches "${selector}".`);
		return;
	}
	if (matches.length > 1) {
		await output(
			__ompTranslate(
				'"{0}" matches multiple {1} accounts: {2}. Use the account number.',
				`${selector}`,
				`${providerName}`,
				`${matches.map(account => `${account.position + 1}. ${account.label}`).join(", ")}`,
			),
		);
		return;
	}
	const account = matches[0];
	if (!account || !session.pinCurrentProviderOAuthAccount(account.credentialId)) {
		await output(__ompTranslate("{0} is no longer available to pin.", `${account?.label ?? selector}`));
		return;
	}
	await output(`Pinned ${account.label} to this session for ${providerName}.`);
}

/**
 * Start (or reuse) the stats dashboard for this session. The Frustration page
 * judges through this session's settings and registry; its cost lands on this
 * session's ledger.
 */
function launchSessionStatsDashboard(
	args: StatsDashboardArgs,
	owner: Pick<SlashCommandRuntime, "settings" | "session" | "sessionManager">,
): Promise<StatsDashboardLaunchResult> {
	const judge = resolveJudge({
		settings: owner.settings,
		registry: owner.session.modelRegistry,
		sessionId: owner.session.sessionId,
		purpose: "stats_frustration",
		onUsage: journalJudgmentUsage(owner.sessionManager),
		telemetry: owner.session.agent.telemetry,
		cache: sharedJudgmentCache(),
	});
	return launchStatsDashboard(args, async () => judge);
}

export const BUILTIN_SESSION_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "todo",
		icon: "todo",
		description: __ompTranslate("View or modify the agent's todo list"),
		acpDescription: __ompTranslate("Manage todos"),
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "edit", description: __ompTranslate("Open todos in $EDITOR (Markdown round-trip)") },
			{ name: "copy", description: __ompTranslate("Copy todos as Markdown to clipboard") },
			{ name: "expand", description: __ompTranslate("Show every phase and task in the HUD") },
			{ name: "collapse", description: __ompTranslate("Restore the bounded HUD preview") },
			{
				name: "export",
				description: __ompTranslate("Write todos as Markdown to a file (default: TODO.md)"),
				usage: "[<path>]",
			},
			{
				name: "import",
				description: __ompTranslate("Replace todos from a Markdown file (default: TODO.md)"),
				usage: "[<path>]",
			},
			{
				name: "append",
				description: __ompTranslate("Append a task; phase fuzzy-matched or auto-created"),
				usage: "[<phase>] <task...>",
			},
			{ name: "start", description: __ompTranslate("Mark task in_progress (fuzzy-matched)"), usage: "<task>" },
			{
				name: "done",
				description: __ompTranslate("Mark task/phase/all completed (fuzzy-matched)"),
				usage: "[<task|phase>]",
			},
			{
				name: "drop",
				description: __ompTranslate("Mark task/phase/all abandoned (fuzzy-matched)"),
				usage: "[<task|phase>]",
			},
			{ name: "rm", description: __ompTranslate("Remove task/phase/all (fuzzy-matched)"), usage: "[<task|phase>]" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const tasks = runtime.ctx.todoPhases.flatMap(phase => phase.tasks);
			if (tasks.length === 0) return "Todos: none";
			const pending = tasks.filter(task => task.status === "pending").length;
			const inProgress = tasks.filter(task => task.status === "in_progress").length;
			const completed = tasks.filter(task => task.status === "completed").length;
			return __ompTranslate(
				"Todos: {0} open ({1} in progress, {2} done)",
				`${pending + inProgress}`,
				`${inProgress}`,
				`${completed}`,
			);
		},
		handle: handleTodoAcp,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleTodoCommand(command.args);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "session",
		icon: "session",
		description: __ompTranslate("Session management commands"),
		acpDescription: __ompTranslate("Show or configure the current session"),
		acpInputHint: "[info|delete|pin [account]]",
		subcommands: [
			{ name: "info", description: __ompTranslate("Show session info and stats") },
			{ name: "delete", description: __ompTranslate("Delete current session and return to selector") },
			{
				name: "pin",
				description: __ompTranslate("Pin a stored OAuth account to the current provider for this session"),
				usage: "[account]",
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "info" && !rest)) {
				await runtime.output(
					[
						`Session: ${runtime.session.sessionId}`,
						`Title: ${runtime.session.sessionName}`,
						`CWD: ${runtime.cwd}`,
					].join("\n"),
				);
				return commandConsumed();
			}
			if (verb === "delete" && !rest) {
				if (runtime.session.isStreaming)
					return usage(__ompTranslate("Cannot delete the session while streaming."), runtime);
				const sessionFile = runtime.sessionManager.getSessionFile();
				if (!sessionFile) return usage(__ompTranslate("No session file to delete (in-memory session)."), runtime);
				// Route through the active SessionManager so the persist writer is
				// closed before the file is deleted. Constructing a fresh
				// FileSessionStorage and calling deleteSessionWithArtifacts leaves
				// the active writer attached to the now-deleted path, so the next
				// prompt would silently resurrect or corrupt the "deleted" file.
				try {
					await runtime.sessionManager.dropSession(sessionFile);
				} catch (err) {
					return usage(__ompTranslate("Failed to delete session: {0}", `${errorMessage(err)}`), runtime);
				}
				await runtime.output(
					__ompTranslate(
						"Session deleted: {0}. Use ACP `session/load` to switch to another session.",
						`${sessionFile}`,
					),
				);
				return commandConsumed();
			}
			if (verb === "pin") {
				await handleSessionPinCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage(__ompTranslate("Usage: /session [info|delete|pin [account]]"), runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "delete" && !rest) {
				clearSubmittedText(runtime);
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}
			if (verb === "pin") {
				if (rest) {
					await handleSessionPinCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
					refreshStatusLine(runtime.ctx);
				} else {
					await runtime.ctx.showSessionPinSelector();
				}
				clearSubmittedText(runtime);
				return;
			}
			if (!verb || (verb === "info" && !rest)) {
				await runtime.ctx.handleSessionCommand();
			} else {
				runtime.ctx.showStatus(__ompTranslate("Usage: /session [info|delete|pin [account]]"));
			}
			clearSubmittedText(runtime);
		},
	},
	{
		name: "jobs",
		icon: "jobs",
		description: __ompTranslate("Show async background jobs status"),
		acpDescription: __ompTranslate("Show background jobs"),
		acpInputHint: "[full|kill <id>|kill all]",
		subcommands: [
			{ name: "full", description: __ompTranslate("Show full, untruncated command lines") },
			{ name: "kill", description: __ompTranslate("Cancel a running background job"), usage: "<id>|all" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const snapshot = runtime.ctx.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) return "Jobs: none";
			return `Jobs: ${snapshot.running.length} running, ${snapshot.recent.length} recent`;
		},
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "kill") {
				await handleJobsKillCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			if (rest || (verb && verb !== "full"))
				return usage(__ompTranslate("Usage: /jobs [full|kill <id>|kill all]"), runtime);
			const full = verb === "full";
			const tree = runtime.session.getAsyncJobTree();
			if (!tree || (tree.running.length === 0 && tree.recent.length === 0)) {
				await runtime.output(
					__ompTranslate(
						"No background jobs running. (Background jobs run async tools — e.g. long-running bash, debug, or task subagents that would otherwise tie up a turn. They appear here while alive and briefly after (until their result is delivered; at most ~5 minutes).)",
					),
				);
				return commandConsumed();
			}
			// One fenced block keeps the tree rails aligned; the fence outgrows any run inside a command.
			const now = Date.now();
			const rows: string[] = [];
			for (const row of buildJobTree([...tree.running, ...tree.recent], tree.agents, tree.rootId)) {
				const guide = jobTreeGuide(row, theme);
				if (row.kind === "agent") {
					rows.push(`${guide}${row.agent.id}`);
					continue;
				}
				const { job } = row;
				// A spawned subagent's task job takes the agent's id as its id and label: name it once.
				const agent = row.agent && row.agent.id !== job.id ? ` ${row.agent.id}` : "";
				rows.push(
					`${guide}[${job.id}] ${job.type} (${job.status}) — ${formatCoarseDuration((job.endTime ?? now) - job.startTime)}${agent}`,
				);
				const text = sanitizeText(full ? (job.command ?? job.label) : job.label);
				if (text === job.id) continue;
				const indent = jobTreeIndent(row, theme);
				for (const line of full ? text.split("\n") : [text]) rows.push(`${indent}${line}`);
			}
			const body = rows.join("\n");
			const fence = markdownFenceFor(body);
			await runtime.output(
				[
					__ompTranslate("Background Jobs"),
					__ompTranslate("Running: {0}", `${tree.running.length}`),
					"",
					`${fence}text`,
					body,
					fence,
				].join("\n"),
			);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "kill") {
				await handleJobsKillCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
			} else if (rest || (verb && verb !== "full")) {
				runtime.ctx.showStatus(__ompTranslate("Usage: /jobs [full|kill <id>|kill all]"));
			} else {
				await runtime.ctx.handleJobsCommand({ full: verb === "full" });
			}
			clearSubmittedText(runtime);
		},
	},
	{
		name: "usage",
		icon: "gauge",
		description: __ompTranslate("Show provider usage and limits"),
		acpDescription: __ompTranslate("Show token usage"),
		acpInputHint: "[show|reset [provider/credential-id|provider/active]]",
		subcommands: [
			{ name: "show", description: __ompTranslate("Show provider usage and limits") },
			{
				name: "reset",
				description: __ompTranslate("Spend a saved provider rate-limit reset"),
				usage: "[provider/credential-id|provider/active]",
			},
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
			return usage(__ompTranslate("Usage: /usage [show|reset [provider/credential-id|provider/active]]"), runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.ctx.handleUsageCommand();
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "reset") {
				if (rest) {
					await handleUsageResetCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
				} else {
					await runtime.ctx.showResetUsageSelector();
				}
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus(__ompTranslate("Usage: /usage [show|reset [provider/credential-id|provider/active]]"));
			clearSubmittedText(runtime);
		},
	},
	{
		name: "stats",
		icon: "stats",
		description: __ompTranslate("Launch the local stats dashboard"),
		inlineHint: "[--port <port>] [--host <host>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const parsed = parseStatsDashboardArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);

			await runtime.output(__ompTranslate("Syncing session files..."));
			try {
				const result = await launchSessionStatsDashboard(parsed, runtime);
				await runtime.output(result.message);
			} catch (error) {
				await runtime.output(__ompTranslate("Stats dashboard failed: {0}", `${errorMessage(error)}`));
				// Mark the failure like `usage()` does, for hosts that report a
				// failed builtin (print mode does not dispatch `/stats`).
				return commandConsumed({ failed: true });
			}
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const parsed = parseStatsDashboardArgs(command.args);
			if ("error" in parsed) {
				ctx.showStatus(parsed.error);
				return;
			}
			try {
				const result = await launchSessionStatsDashboard(parsed, ctx);
				ctx.presentCommandOutput(new StatsNotice(result.message, result.url));
			} catch (error) {
				ctx.showError(__ompTranslate("Stats dashboard failed: {0}", `${errorMessage(error)}`));
			}
		},
	},
	{
		name: "changelog",
		icon: "news",
		description: __ompTranslate("Show changelog entries"),
		acpDescription: __ompTranslate("Show changelog"),
		acpInputHint: "[full|last [N]]",
		subcommands: [
			{ name: "full", description: __ompTranslate("Show complete changelog") },
			{ name: "last", description: __ompTranslate("Show the last N releases (default 1)"), usage: "[N]" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const view = parseChangelogView(command.args);
			if ("error" in view) return usage(view.error, runtime);
			const changelogPath = getChangelogPath();
			const allEntries = await parseChangelog(changelogPath);
			const entriesToShow = selectChangelogEntries(allEntries, view);
			if (entriesToShow.length === 0) {
				await runtime.output(__ompTranslate("No changelog entries found.\u0004session.changelog.empty"));
				return commandConsumed();
			}
			await runtime.output(renderChangelogEntries(entriesToShow).markdown);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleChangelogCommand(command.args);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "hotkeys",
		icon: "keyboard",
		description: __ompTranslate("Show all keyboard shortcuts"),
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "tools",
		icon: "tools",
		description: __ompTranslate("Show tools currently visible to the agent"),
		acpDescription: __ompTranslate("Show available tools"),
		getTuiAutocompleteDescription: runtime => {
			const active = runtime.ctx.session.getActiveToolNames().length;
			const all = runtime.ctx.session.getAllToolNames().length;
			return all === 0
				? __ompTranslate("Tools: none available")
				: __ompTranslate("Tools: {0} active / {1} available", `${active}`, `${all}`);
		},
		handle: async (_command, runtime) => {
			const active = runtime.session.getActiveToolNames();
			const all = runtime.session.getAllToolNames();
			if (all.length === 0) {
				await runtime.output(__ompTranslate("No tools are available."));
				return commandConsumed();
			}
			const lines = all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`);
			for (const mounted of runtime.session.getXdevToolEntries()) {
				lines.push(`~ xd://${mounted.name}`);
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "context",
		icon: "context",
		description: __ompTranslate("Browse context usage and detailed content"),
		acpDescription: __ompTranslate("Show context usage"),
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			if (!usage) return __ompTranslate("Context: unavailable");
			return __ompTranslate(
				"Context: {0}% ({1}/{2})",
				`${Math.round(usage.percent)}`,
				`${formatTokenCount(usage.tokens)}`,
				`${formatTokenCount(usage.contextWindow)}`,
			);
		},
		handle: async (_command, runtime) => {
			await runtime.output(buildContextReportText(runtime));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleContextCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "extensions",
		aliases: ["status"],
		icon: "extension",
		description: __ompTranslate("Open Extension Control Center dashboard"),
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "agents",
		icon: "agents",
		description: __ompTranslate("Open the agents hub (per-agent model, prewalk, and advisor)"),
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "git",
		icon: "branch",
		description: __ompTranslate("Open the git UI (split diff viewer, staging, commit composer)"),
		inlineHint: "[revision]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			runtime.ctx.showGitUi(command.args.trim() || undefined);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "local",
		icon: "pencil",
		description: __ompTranslate("Open a session local:// file in $EDITOR (picker when no name given)"),
		inlineHint: __ompTranslate("[name]"),
		allowArgs: true,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await openLocalFileInEditor(runtime.ctx, command.args);
		},
	},
	{
		name: "hub",
		aliases: ["subagents"],
		icon: "agents",
		description: __ompTranslate("Open the live Agent Hub (subagents, including finished ones)"),
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentHub({ initialSection: "activity" });
			clearSubmittedText(runtime);
		},
	},
	{
		name: "branch",
		aliases: ["rewind"],
		icon: "branch",
		description: __ompTranslate("Rewind to a previous message, keeping the old path as a branch"),
		handleTui: (_command, runtime) => {
			runtime.ctx.showUserMessageSelector();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "fork",
		icon: "branch",
		description: __ompTranslate("Fork this session, or open it in a multiplexer pane or window"),
		subcommands: [
			{ name: "pane", description: __ompTranslate("Open the fork in a new terminal pane") },
			{ name: "window", description: __ompTranslate("Open the fork in a new multiplexer window") },
			{ name: "tab", description: __ompTranslate("Alias for window") },
		],
		subcommandOptional: true,
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const args = command.args.trim();
			let placement: "pane" | "window" | undefined;
			if (args) {
				const [keyword, ...extra] = args.split(/\s+/);
				if (extra.length > 0) {
					clearSubmittedText(runtime);
					runtime.ctx.showError("Usage: /fork [pane|window|tab]");
					return;
				}
				switch (keyword?.toLowerCase()) {
					case "pane":
						placement = "pane";
						break;
					case "window":
					case "tab":
						placement = "window";
						break;
					default:
						clearSubmittedText(runtime);
						runtime.ctx.showError("Usage: /fork [pane|window|tab]");
						return;
				}
			}
			clearSubmittedText(runtime);
			if (placement) await runtime.ctx.handleForkCommand(placement);
			else await runtime.ctx.handleForkCommand();
		},
	},
	{
		name: "tree",
		icon: "tree",
		description: __ompTranslate("Navigate session tree (switch branches)"),
		handleTui: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "login",
		icon: "signIn",
		description: __ompTranslate("Login with OAuth provider"),
		inlineHint: __ompTranslate("[provider|redirect URL]"),
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.oauthManualInput.hasPending()
				? __ompTranslate(
						"Login: waiting for {0} callback",
						`${runtime.ctx.oauthManualInput.pendingProviderId ?? "OAuth"}`,
					)
				: __ompTranslate("Login: choose provider"),
		handleTui: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			if (args.length > 0) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === args);
				if (matchedProvider) {
					if (manualInput.hasPending()) {
						const pendingProvider = manualInput.pendingProviderId;
						const message = pendingProvider
							? __ompTranslate(
									"OAuth login already in progress for {0}. Paste the redirect URL with /login <url>.",
									`${pendingProvider}`,
								)
							: __ompTranslate("OAuth login already in progress. Paste the redirect URL with /login <url>.");
						runtime.ctx.showWarning(message);
						clearSubmittedText(runtime);
						return;
					}
					void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
					clearSubmittedText(runtime);
					return;
				}
				const submitted = manualInput.submit(args);
				if (submitted) {
					runtime.ctx.showStatus(__ompTranslate("OAuth callback received; completing login…"));
				} else {
					runtime.ctx.showWarning(__ompTranslate("No OAuth login is waiting for a manual callback."));
				}
				clearSubmittedText(runtime);
				return;
			}

			if (manualInput.hasPending()) {
				const provider = manualInput.pendingProviderId;
				const message = provider
					? __ompTranslate(
							"OAuth login already in progress for {0}. Paste the redirect URL with /login <url>.",
							`${provider}`,
						)
					: __ompTranslate("OAuth login already in progress. Paste the redirect URL with /login <url>.");
				runtime.ctx.showWarning(message);
				clearSubmittedText(runtime);
				return;
			}

			void runtime.ctx.showOAuthSelector("login");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "logout",
		icon: "signOut",
		description: __ompTranslate("Logout from OAuth provider"),
		inlineHint: "[provider]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const providerId = command.args.trim();
			if (providerId) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === providerId);
				if (!matchedProvider) {
					runtime.ctx.showWarning(__ompTranslate("Unknown OAuth provider: {0}", `${providerId}`));
					clearSubmittedText(runtime);
					return;
				}
				void runtime.ctx.showOAuthSelector("logout", matchedProvider.id);
				clearSubmittedText(runtime);
				return;
			}
			void runtime.ctx.showOAuthSelector("logout");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "mcp",
		icon: "mcp",
		description: __ompTranslate("Manage MCP servers (add, list, remove, test)"),
		acpDescription: __ompTranslate("Manage MCP servers"),
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: __ompTranslate("Add a new MCP server"),
				usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]",
			},
			{ name: "list", description: __ompTranslate("List all configured MCP servers") },
			{
				name: "remove",
				description: __ompTranslate("Remove an MCP server"),
				usage: "<name> [--scope project|user]",
			},
			{ name: "test", description: __ompTranslate("Test connection to a server"), usage: "<name>" },
			{ name: "reauth", description: __ompTranslate("Reauthorize OAuth for a server"), usage: "<name>" },
			{ name: "unauth", description: __ompTranslate("Remove OAuth auth from a server"), usage: "<name>" },
			{ name: "enable", description: __ompTranslate("Enable an MCP server"), usage: "<name>" },
			{ name: "disable", description: __ompTranslate("Disable an MCP server"), usage: "<name>" },
			{
				name: "smithery-search",
				description: __ompTranslate("Search Smithery registry and deploy an MCP server"),
				usage: "<keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			},
			{ name: "smithery-login", description: __ompTranslate("Login to Smithery and cache API key") },
			{ name: "smithery-logout", description: __ompTranslate("Remove cached Smithery API key") },
			{ name: "reconnect", description: __ompTranslate("Reconnect to a specific MCP server"), usage: "<name>" },
			{ name: "reload", description: __ompTranslate("Force reload MCP runtime tools") },
			{ name: "resources", description: __ompTranslate("List available resources from connected servers") },
			{ name: "prompts", description: __ompTranslate("List available prompts from connected servers") },
			{ name: "notifications", description: __ompTranslate("Show notification capabilities and subscriptions") },
			{ name: "help", description: __ompTranslate("Show help message") },
		],
		allowArgs: true,
		handle: handleMcpAcp,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleMCPCommand(command.text);
		},
	},
];

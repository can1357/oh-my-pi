import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { clearSubmittedText } from "./helpers/draft";
import { Spacer } from "@oh-my-pi/pi-tui";
import { APP_NAME, formatAge } from "@oh-my-pi/pi-utils";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { CollabGuestLink } from "../collab/guest";
import type { CollabHost } from "../collab/host";
import { type CollabHostSnapshot, listCollabHosts } from "../collab/registry";
import { settings } from "../config/settings";
import { parseExportArgs } from "../export/html/args";
import { shareSession } from "../export/share";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "../modes/types";
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { extractLastCodeBlock, extractLastCommand, extractLastLink } from "@oh-my-pi/pi-tui/overlays/copy-targets";
import { restartBrowserForModeChange } from "../tools/browser";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { openPath } from "../utils/open";
import { copyToClipboard } from "../utils/clipboard";
import { refreshStatusLine } from "./builtin-modes";
import { CollabQrCodeComponent, collabBrowserLink } from "@oh-my-pi/pi-tui/chrome/collab-qrcode";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import { formatDumpArchiveReport } from "../session/session-dump-format";
import type { SlashCommandSpec } from "./types";

import { cfgBrowserEnabled, cfgBrowserHeadless } from "../tools/browser/settings";
import { cfgShareRedactSecrets, cfgShareServerUrl, cfgShareStore } from "../commands/settings";

/** Join hint printed by /collab: compact terminal link + clickable browser deep link. */
function collabLinkHint(host: CollabHost, heading: string, view = false): string {
	const bullet = theme.fg("accent", theme.format.bullet);
	const link = view ? host.viewLink : host.link;
	const webLink = view ? host.webViewLink : host.webLink;
	return [
		// Keep the URL on the first row: under transcript pressure the status
		// block is clipped to rendered[0], which used to drop the join link.
		`${collabBrowserLink(webLink, __ompTranslate("Join in browser"))}  ${theme.fg("success", heading)}`,
		` ${bullet} ${theme.fg("muted", view ? __ompTranslate("Watch from another terminal:") : __ompTranslate("Join from another terminal:"))} ${APP_NAME} join "${link}"`,
		` ${bullet} ${theme.fg("muted", __ompTranslate("or any web browser:"))} ${collabBrowserLink(webLink)}`,
		theme.fg(
			"dim",
			view
				? __ompTranslate("Anyone with this link can watch the session but cannot prompt the agent.")
				: __ompTranslate(
						"Anyone with the link can read the session and prompt the agent. Read-only link: /collab view",
					),
		),
	].join("\n");
}

function showCollabQrCode(ctx: InteractiveModeContext, webLink: string): void {
	try {
		ctx.present([new Spacer(1), new CollabQrCodeComponent(webLink)]);
	} catch (err) {
		ctx.showError(__ompTranslate("Failed to render collab QR code: {0}", `${errorMessage(err)}`));
	}
}

function showCollabLink(ctx: InteractiveModeContext, host: CollabHost, heading: string, view = false): void {
	ctx.showStatus(collabLinkHint(host, heading, view), { dim: false });
	showCollabQrCode(ctx, view ? host.webViewLink : host.webLink);
}

export const BUILTIN_COLLABORATION_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "advisor",
		icon: "advisor",
		description: __ompTranslate("Toggle the advisor (a second model that reviews each turn and injects notes)"),
		acpDescription: __ompTranslate("Toggle advisor"),
		acpInputHint: "[on|off|status|dump [raw]|configure]",
		subcommands: [
			{ name: "on", description: __ompTranslate("Enable the advisor") },
			{ name: "off", description: __ompTranslate("Disable the advisor") },
			{ name: "status", description: __ompTranslate("Show advisor status") },
			{ name: "dump", description: __ompTranslate("Copy the advisor's transcript to clipboard"), usage: "[raw]" },
			{ name: "configure", description: __ompTranslate("Open the advisor configuration editor (TUI)") },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const stats = runtime.ctx.session.getAdvisorStats();
			if (stats.active && stats.advisors.length > 1)
				return __ompTranslate("Advisor: on ({0} advisors)", `${stats.advisors.length}`);
			if (stats.active && stats.model)
				return __ompTranslate("Advisor: on ({0}/{1})", `${stats.model.provider}`, `${stats.model.id}`);
			if (stats.configured) return __ompTranslate("Advisor: configured, no model");
			return __ompTranslate("Advisor: off");
		},
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.session.toggleAdvisorEnabled();
				const configured = runtime.session.isAdvisorEnabled();
				if (active) {
					await runtime.output(__ompTranslate("Advisor enabled."));
				} else if (configured) {
					await runtime.output(
						__ompTranslate("Advisor setting enabled, but no model is assigned to the 'advisor' role."),
					);
				} else {
					await runtime.output("Advisor disabled.");
				}
				return commandConsumed();
			}
			if (verb === "on") {
				const active = runtime.session.setAdvisorEnabled(true);
				await runtime.output(
					active
						? __ompTranslate("Advisor enabled.")
						: __ompTranslate("Advisor setting enabled, but no model is assigned to the 'advisor' role."),
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
				await runtime.output(
					text ?? __ompTranslate("Advisor is not active for this session.\u0004collaboration.command.status"),
				);
				return commandConsumed();
			}
			if (verb === "configure") {
				await runtime.output(
					__ompTranslate(
						"/advisor configure opens an interactive editor and is only available in the interactive TUI.",
					),
				);
				return commandConsumed();
			}
			return usage(__ompTranslate("Usage: /advisor [on|off|status|dump [raw]|configure]"), runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.ctx.session.toggleAdvisorEnabled();
				const configured = runtime.ctx.session.isAdvisorEnabled();
				if (active) {
					runtime.ctx.showStatus(__ompTranslate("Advisor enabled."));
				} else if (configured) {
					runtime.ctx.showStatus(
						__ompTranslate("Advisor setting enabled, but no model is assigned to the 'advisor' role."),
					);
				} else {
					runtime.ctx.showStatus("Advisor disabled.");
				}
				refreshStatusLine(runtime.ctx);
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "on") {
				const active = runtime.ctx.session.setAdvisorEnabled(true);
				runtime.ctx.showStatus(
					active
						? __ompTranslate("Advisor enabled.")
						: __ompTranslate("Advisor setting enabled, but no model is assigned to the 'advisor' role."),
				);
				refreshStatusLine(runtime.ctx);
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "off") {
				runtime.ctx.session.setAdvisorEnabled(false);
				runtime.ctx.showStatus("Advisor disabled.");
				refreshStatusLine(runtime.ctx);
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "status") {
				await runtime.ctx.handleAdvisorStatusCommand();
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "dump") {
				const isRaw = rest.toLowerCase() === "raw";
				runtime.ctx.handleAdvisorDumpCommand(isRaw);
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "configure") {
				runtime.ctx.showAdvisorConfigure();
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus(__ompTranslate("Usage: /advisor [on|off|status|dump [raw]|configure]"));
			clearSubmittedText(runtime);
		},
	},
	{
		name: "export",
		icon: "export",
		description: __ompTranslate("Export session to HTML file"),
		inlineHint: "[--themes] [path]",
		allowArgs: true,
		handle: async (command, runtime) => {
			try {
				const { outputPath, useUserThemes } = parseExportArgs(command.args);
				if (outputPath === "--copy" || outputPath === "clipboard" || outputPath === "copy") {
					return usage(__ompTranslate("Use /dump to copy the session to clipboard."), runtime);
				}
				const filePath = await runtime.session.exportToHtml(outputPath, useUserThemes);
				await runtime.output(__ompTranslate("Session exported to: {0}", `${filePath}`));
				return commandConsumed();
			} catch (err) {
				return usage(
					__ompTranslate(
						"Failed to export session: {0}\u0004collaboration.command.status",
						`${errorMessage(err)}`,
					),
					runtime,
				);
			}
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleExportCommand(command.text);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "trace",
		icon: "stats",
		description: __ompTranslate("Open this session's trace in the stats dashboard"),
		handle: async (_command, runtime) => {
			const sessionFile = runtime.session.sessionFile;
			if (!sessionFile) {
				await runtime.output(__ompTranslate("No session file yet — send a message first."));
				return commandConsumed();
			}
			try {
				// Lazy: the stats dashboard (server + sqlite) loads on demand only,
				// matching src/cli/stats-cli.ts, to keep CLI startup fast.
				const { formatStatsDashboardUrl, startServer } = await import("@oh-my-pi/omp-stats");
				const { hostname, port } = await startServer();
				const url = `${formatStatsDashboardUrl(hostname, port)}/#/traces?s=${encodeURIComponent(sessionFile)}`;
				await runtime.output(url);
				return commandConsumed();
			} catch (err) {
				return usage(
					__ompTranslate("Failed to open trace: {0}\u0004collaboration.command.status", `${errorMessage(err)}`),
					runtime,
				);
			}
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleTraceCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "dump",
		icon: "clipboard",
		description: __ompTranslate("Copy session transcript to clipboard (and write LLM request JSON to tmp)"),
		acpDescription: __ompTranslate("Return full transcript as plain text, with LLM request JSON path"),
		acpInputHint: "[all|anon]",
		subcommands: [
			{
				name: "all",
				description: __ompTranslate(
					"Write a zip with the main transcript, LLM request JSON, and one file per subagent",
				),
			},
			{
				name: "anon",
				description: __ompTranslate(
					"Write a zip of anonymized session JSONL (contents redacted, metadata kept) plus subagents",
				),
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			if (verb === "all" || verb === "anon") {
				const archive =
					verb === "all"
						? await runtime.session.dumpSessionArchiveToTmpDir()
						: await runtime.session.dumpAnonymizedArchiveToTmpDir();
				if (!archive) {
					await runtime.output("No messages to dump yet.");
					return commandConsumed();
				}
				await runtime.output(formatDumpArchiveReport(archive).join("\n"));
				return commandConsumed();
			}
			if (verb) return usage(__ompTranslate("Usage: /dump [all|anon]"), runtime);
			const text = runtime.session.formatSessionAsText();
			if (!text) {
				await runtime.output("No messages to dump yet.");
				return commandConsumed();
			}
			let sidecarPath: string | undefined;
			try {
				sidecarPath = await runtime.session.dumpLlmRequestToTmpDir();
			} catch {
				// Sidecar is best-effort; the transcript is still output below.
			}
			const lines = [text];
			if (sidecarPath)
				lines.push(
					"",
					__ompTranslate("LLM request JSON: {0}", `${sidecarPath}`),
					__ompTranslate("This file persists on disk and may contain raw context/secrets — treat accordingly."),
				);
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			if (verb === "all") await runtime.ctx.handleDumpAllCommand();
			else if (verb === "anon") await runtime.ctx.handleDumpAnonCommand();
			else if (verb) runtime.ctx.showStatus(__ompTranslate("Usage: /dump [all|anon]"));
			else await runtime.ctx.handleDumpCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "share",
		icon: "share",
		description: __ompTranslate("Share session via an encrypted link (share server or secret gist)"),
		handle: async (_command, runtime) => {
			try {
				const result = await shareSession(runtime.sessionManager, {
					serverUrl: cfgShareServerUrl.get(runtime.settings),
					store: cfgShareStore.get(runtime.settings),
					state: runtime.session.state,
					obfuscator: cfgShareRedactSecrets.get(runtime.settings) ? runtime.session.obfuscator : undefined,
				});
				const lines = [__ompTranslate("Share URL: {0}", `${result.url}`)];
				if (result.gistUrl) lines.push(`Gist: ${result.gistUrl}`);
				if (result.truncated)
					lines.push(
						__ompTranslate(
							"Note: large content was trimmed to fit the share size limit.\u0004collaboration.command.status",
						),
					);
				await runtime.output(lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(
					__ompTranslate("Failed to share session: {0}\u0004collaboration.command.status", `${errorMessage(err)}`),
					runtime,
				);
			}
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleShareCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "collab",
		icon: "broadcast",
		description: __ompTranslate("Share this session live via a relay"),
		inlineHint: "[start|view|list|stop|status] [relayUrl]",
		subcommands: [
			{ name: "view", description: __ompTranslate("Share a read-only link (guests can watch, not prompt)") },
			{
				name: "list",
				description: __ompTranslate("List active local Collab hosts (no links; use `omp collab link`)"),
			},
			{ name: "status", description: __ompTranslate("Show link + participants") },
			{ name: "stop", description: __ompTranslate("Stop sharing") },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const host = runtime.ctx.collabController.host;
			if (host) {
				return __ompTranslate("Collab: hosting ({0} guests)", `${Math.max(0, host.participants.length - 1)}`);
			}
			if (runtime.ctx.collabGuest?.readOnly) return __ompTranslate("Collab: read-only guest");
			if (runtime.ctx.collabGuest) return __ompTranslate("Collab: guest");
			return __ompTranslate("Collab: off");
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			clearSubmittedText(runtime);
			const args = command.args.trim();
			const { verb, rest } = parseSubcommand(args);
			if (verb === "stop") {
				await ctx.collabController.stop("host stopped");
				ctx.showStatus("Collab stopped");
				return;
			}
			if (verb === "status") {
				const host = ctx.collabController.host;
				if (host) {
					const names = host.participants.map(p =>
						p.role === "host"
							? __ompTranslate("{0} (host)", `${p.name}`)
							: p.readOnly
								? __ompTranslate("{0} (view-only)", `${p.name}`)
								: p.name,
					);
					const link = host.access === "view" ? host.webViewLink : host.webLink;
					ctx.showStatus(`Collab: ${names.join(", ")} — ${collabBrowserLink(link)}`);
				} else if (ctx.collabGuest) {
					ctx.showStatus(
						ctx.collabGuest.readOnly
							? __ompTranslate("In a collab session as a read-only guest (/leave to exit)")
							: __ompTranslate("In a collab session as a guest (/leave to exit)"),
					);
				} else {
					ctx.showStatus("Not in a collab session");
				}
				return;
			}
			if (verb === "list") {
				// Same registry as `omp collab list`: metadata only, never a link. A
				// link is a deliberate per-host act (`omp collab link <id> [--view]`),
				// so a listing can be shown or logged without granting anything.
				if (rest.trim()) {
					ctx.showError(
						__ompTranslate("Usage: /collab list — for links or JSON use `{0} collab link|list`", `${APP_NAME}`),
					);
					return;
				}
				let hosts: CollabHostSnapshot[];
				try {
					hosts = await listCollabHosts();
				} catch (err) {
					ctx.showError(
						truncateToWidth(
							sanitizeDisplayLine(__ompTranslate("Failed to list collab hosts: {0}", `${errorMessage(err)}`)),
							TRUNCATE_LENGTHS.LINE,
						),
					);
					return;
				}
				if (hosts.length === 0) {
					ctx.showStatus(__ompTranslate("No active Collab hosts"));
					return;
				}
				const bullet = theme.fg("accent", theme.format.bullet);
				const plural = hosts.length === 1 ? "" : "s";
				const lines = [theme.fg("success", `${hosts.length} active local Collab host${plural}`)];
				for (const host of hosts) {
					// Registry strings come from other processes: strip controls,
					// collapse newlines, and bound the width before they hit the TUI.
					const name = host.sessionName ? sanitizeDisplayLine(host.sessionName) : "";
					const sessionId = sanitizeDisplayLine(host.sessionId);
					const session = truncateToWidth(name ? `${name} (${sessionId})` : sessionId, TRUNCATE_LENGTHS.LONG);
					const guests = host.participants - 1;
					const room = [
						__ompTranslate("gen {0}", `${host.generation}`),
						host.model
							? sanitizeDisplayLine(`${host.model.provider}/${host.model.id}`)
							: __ompTranslate("no model"),
						__ompTranslate(
							"started {0}",
							`${formatAge(Math.round((Date.now() - host.startedAt) / 1000)) || __ompTranslate("just now")}`,
						),
					].join(", ");
					const detail = [
						`pid ${host.pid}`,
						__ompTranslate("{0} guest{1}", `${guests}`, `${guests === 1 ? "" : "s"}`),
						host.access,
						host.relayConnected ? __ompTranslate("relay connected") : __ompTranslate("relay reconnecting"),
						...(host.inputRequired ? [__ompTranslate("input required")] : []),
						...(host.busy === null
							? []
							: [host.busy ? __ompTranslate("working") : __ompTranslate("idle\u0004collaboration.state")]),
						truncateToWidth(sanitizeDisplayLine(shortenPath(host.cwd)), TRUNCATE_LENGTHS.TITLE),
					].join(", ");
					lines.push(
						// Fields are bounded above; each composed row is bounded too so the
						// fixed details can never push it past one transcript line.
						truncateToWidth(` ${bullet} ${session} ${theme.fg("muted", `— ${room}`)}`, TRUNCATE_LENGTHS.LINE),
						truncateToWidth(`   ${theme.fg("muted", detail)}`, TRUNCATE_LENGTHS.LINE),
						`   ${theme.fg("dim", `${APP_NAME} collab link ${host.instanceId}${host.access === "view" ? " --view" : ""}`)}`,
					);
				}
				ctx.showStatus(lines.join("\n"), { dim: false });
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError(__ompTranslate("Already in a collab session as a guest (/leave first)"));
				return;
			}
			const knownStartVerb = verb === "start" || verb === "view";
			const view = verb === "view";
			const access = view ? "view" : "control";
			const existing = ctx.collabController.host;
			let host: CollabHost;
			try {
				host = await ctx.collabController.start({ access, relay: knownStartVerb ? rest : args });
			} catch (err) {
				ctx.showError(__ompTranslate("Failed to start collab session: {0}", `${errorMessage(err)}`));
				return;
			}
			let heading = existing
				? __ompTranslate("Collab session restarted with control access")
				: __ompTranslate("Collab session started!");
			if (host === existing)
				heading = view
					? __ompTranslate("Read-only collab session active")
					: __ompTranslate("Collab session active");
			showCollabLink(ctx, host, heading, view);
		},
	},
	{
		name: "join",
		icon: "signIn",
		description: __ompTranslate("Join a shared collab session"),
		inlineHint: "<link>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			clearSubmittedText(runtime);
			const link = command.args.trim();
			if (!link) {
				ctx.showError(__ompTranslate("Usage: /join <link>"));
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError(
					__ompTranslate("Already in a collab session (/leave first)\u0004collaboration.session.already-joined"),
				);
				return;
			}
			try {
				// Stop stale/ending ownership and cancel pending starts, not a live room.
				if (!ctx.collabController.host) await ctx.collabController.stop("joining another session");
				// Recheck after teardown: a concurrent manual start may have won.
				if (ctx.collabController.host) {
					ctx.showError(__ompTranslate("Stop hosting first (/collab stop)"));
					return;
				}
				await new CollabGuestLink(ctx).join(link);
			} catch (err) {
				ctx.showError(__ompTranslate("Failed to join collab session: {0}", `${errorMessage(err)}`));
			}
		},
	},
	{
		name: "leave",
		icon: "signOut",
		description: __ompTranslate("Leave the collab session"),
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.collabController.host) return __ompTranslate("Leave collab: hosting");
			if (runtime.ctx.collabGuest) return __ompTranslate("Leave collab: guest");
			return __ompTranslate("Leave collab: not in collab");
		},
		handleTui: async (_command, runtime) => {
			const ctx = runtime.ctx;
			clearSubmittedText(runtime);
			if (ctx.collabGuest) {
				await ctx.collabGuest.leave("left");
				return;
			}
			const wasHosting = ctx.collabHost !== undefined;
			await ctx.collabController.stop("host stopped");
			if (wasHosting) {
				ctx.showStatus("Collab stopped");
				return;
			}
			ctx.showStatus("Not in a collab session");
		},
	},
	{
		name: "browser",
		icon: "globe",
		description: __ompTranslate("Toggle browser eval-prelude headless vs visible mode"),
		acpInputHint: "[headless|visible]",
		subcommands: [
			{ name: "headless", description: __ompTranslate("Switch to headless mode") },
			{ name: "visible", description: __ompTranslate("Switch to visible mode") },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!cfgBrowserEnabled.get(runtime.ctx.settings)) return __ompTranslate("Browser: disabled");
			return cfgBrowserHeadless.get(runtime.ctx.settings)
				? __ompTranslate("Browser: headless")
				: __ompTranslate("Browser: visible");
		},
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const enabled = cfgBrowserEnabled.get(runtime.settings);
			if (!enabled) return usage(__ompTranslate("Browser capability is disabled (enable in settings)."), runtime);
			const current = cfgBrowserHeadless.get(runtime.settings);
			let next = current;
			if (!arg) next = !current;
			else if (arg === "headless" || arg === "hidden") next = true;
			else if (arg === "visible" || arg === "show" || arg === "headful") next = false;
			else return usage(__ompTranslate("Usage: /browser [headless|visible]"), runtime);
			cfgBrowserHeadless.set(runtime.settings, next);
			try {
				await restartBrowserForModeChange();
			} catch (err) {
				// Setting was already mutated; surface the restart failure so the
				// user knows the browser is in an inconsistent state.
				await runtime.output(
					__ompTranslate(
						"Browser mode set to {0}, but restart failed: {1}",
						`${next ? "headless" : "visible"}`,
						`${errorMessage(err)}`,
					),
				);
				return commandConsumed();
			}
			await runtime.output(__ompTranslate("Browser mode: {0}", `${next ? "headless" : "visible"}`));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const current = cfgBrowserHeadless.get(settings);
			let next = current;
			if (!cfgBrowserEnabled.get(settings)) {
				runtime.ctx.showWarning(__ompTranslate("Browser capability is disabled (enable in settings)"));
				clearSubmittedText(runtime);
				return;
			}
			if (!arg) {
				next = !current;
			} else if (arg === "headless" || arg === "hidden") {
				next = true;
			} else if (arg === "visible" || arg === "show" || arg === "headful") {
				next = false;
			} else {
				runtime.ctx.showStatus(__ompTranslate("Usage: /browser [headless|visible]"));
				clearSubmittedText(runtime);
				return;
			}
			cfgBrowserHeadless.set(settings, next);
			try {
				await restartBrowserForModeChange();
			} catch (error) {
				runtime.ctx.showWarning(__ompTranslate("Failed to restart browser: {0}", `${errorMessage(error)}`));
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus(__ompTranslate("Browser mode: {0}", `${next ? "headless" : "visible"}`));
			clearSubmittedText(runtime);
		},
	},
	{
		name: "copy",
		icon: "copy",
		description: __ompTranslate("Pick text or code from the conversation to copy"),
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg) {
				runtime.ctx.showCopySelector();
				clearSubmittedText(runtime);
				return;
			}
			if (arg === "code") {
				const block = extractLastCodeBlock(runtime.ctx.session.messages);
				if (!block) {
					runtime.ctx.showStatus(__ompTranslate("No code block to copy."));
					clearSubmittedText(runtime);
					return;
				}
				await copyToClipboard(block.code);
				runtime.ctx.showStatus(__ompTranslate("Copied code block to clipboard"));
				clearSubmittedText(runtime);
				return;
			}
			if (arg === "cmd" || arg === "command") {
				const lastCommand = extractLastCommand(runtime.ctx.session.messages);
				if (!lastCommand) {
					runtime.ctx.showStatus(__ompTranslate("No command to copy."));
					clearSubmittedText(runtime);
					return;
				}
				await copyToClipboard(lastCommand.code);
				runtime.ctx.showStatus(
					__ompTranslate(
						"Copied {0} to clipboard",
						`${lastCommand.kind === "bash" ? __ompTranslate("bash command") : __ompTranslate("eval code")}`,
					),
				);
				clearSubmittedText(runtime);
				return;
			}
			if (arg === "link" || arg === "url") {
				const link = extractLastLink(runtime.ctx.session.messages);
				if (!link) {
					runtime.ctx.showStatus(__ompTranslate("No link to copy."));
					clearSubmittedText(runtime);
					return;
				}
				await copyToClipboard(link.href);
				runtime.ctx.showStatus(__ompTranslate("Copied link to clipboard"));
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus(__ompTranslate("Usage: /copy [code|cmd|link]"));
			clearSubmittedText(runtime);
		},
	},
	{
		name: "open",
		icon: "globe",
		description: __ompTranslate("Open the last link from the conversation in your browser (or pick one with /copy)"),
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg && arg !== "link" && arg !== "url") {
				runtime.ctx.showStatus(
					__ompTranslate(
						"Usage: /open [link]  (pick a specific link: /copy, {0} blocks, {1})",
						`${formatKeyHint("right")}`,
						`${formatKeyHint("o")}`,
					),
				);
				clearSubmittedText(runtime);
				return;
			}
			const link = extractLastLink(runtime.ctx.session.messages);
			if (!link) {
				runtime.ctx.showStatus(__ompTranslate("No link to open."));
				clearSubmittedText(runtime);
				return;
			}
			openPath(link.href);
			runtime.ctx.showStatus(__ompTranslate("Opening {0}", `${link.href}`));
			clearSubmittedText(runtime);
		},
	},
];

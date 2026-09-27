/**
 * `/telegram` — the interactive surface of the native Telegram bridge.
 *
 * `handleTui` only: the bridge needs the TUI process's session and dialog
 * hosts, so there is no text/ACP counterpart (like `/collab`). Bare
 * `/telegram` renders status plus the one next step towards a running host.
 */
import type { InteractiveModeContext } from "../modes/types";
import { errorMessage, parseSubcommand } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

const USAGE = "Usage: /telegram [start|stop|status|pair|unpair]";

function renderStatus(ctx: InteractiveModeContext, note?: string): void {
	const status = ctx.telegramController.status();
	const lines: string[] = [];
	if (note) lines.push(note);
	if (status.state === "running") {
		const bot = status.botUsername === null ? "" : ` as @${status.botUsername}`;
		lines.push(
			`Telegram: running${bot} — ${status.topics} topic(s), ${status.liveSessions} live session(s), ` +
				`${status.mirrors} mirror(s)`,
		);
	} else if (status.pairing) {
		lines.push(`Telegram: pairing${status.pairingCode === null ? "" : ` (code ${status.pairingCode})`}`);
	} else if (status.state === "starting") {
		lines.push("Telegram: starting…");
	} else if (status.state === "failed") {
		lines.push(`Telegram: failed — ${status.error ?? "unknown error"}`);
	} else if (!status.configured) {
		lines.push("Telegram: not configured — set telegram.botToken in /settings (or PI_TELEGRAM_BOT_TOKEN)");
	} else if (!status.paired) {
		lines.push("Telegram: not paired — run /telegram pair and send the code to your bot");
	} else {
		lines.push("Telegram: off");
	}
	if (status.state === "off") {
		if (status.configured && status.paired) lines.push("Next: /telegram start");
	} else if (status.state === "running") {
		lines.push(status.autoStart ? "Auto-start is on." : "Auto-start is off (telegram.autoStart).");
	}
	ctx.showStatus(lines.join("\n"));
}

export const BUILTIN_TELEGRAM_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "telegram",
		icon: "globe",
		description: "Drive omp sessions from a Telegram bot (one topic per session)",
		inlineHint: "[start|stop|status|pair|unpair]",
		subcommands: [
			{ name: "start", description: "Start the bridge for the paired bot" },
			{ name: "stop", description: "Stop the bridge (sessions stay in the registry)" },
			{ name: "status", description: "Show bridge state, paired chat, and live topics" },
			{ name: "pair", description: "Pair a chat: show a one-time code to send to the bot" },
			{ name: "unpair", description: "Forget the paired chat and allowed users, and stop the bridge" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const status = runtime.ctx.telegramController.status();
			if (status.state === "running") {
				return `Telegram: on${status.botUsername === null ? "" : ` (@${status.botUsername})`}`;
			}
			if (status.pairing) return "Telegram: pairing";
			if (!status.configured) return "Telegram: not configured";
			if (!status.paired) return "Telegram: not paired";
			return "Telegram: off";
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const { verb } = parseSubcommand(command.args);
			try {
				if (verb === "start") {
					await ctx.telegramController.start();
					renderStatus(ctx);
					return;
				}
				if (verb === "stop") {
					await ctx.telegramController.stop("host stopped");
					ctx.showStatus("Telegram stopped");
					return;
				}
				if (verb === "pair") {
					await ctx.telegramController.pair();
					return;
				}
				if (verb === "unpair") {
					await ctx.telegramController.unpair();
					return;
				}
				if (verb === "status" || verb === "") {
					renderStatus(ctx);
					return;
				}
			} catch (error) {
				ctx.showError(`Telegram: ${errorMessage(error)}`);
				return;
			}
			ctx.showError(`Unknown /telegram subcommand: ${verb}. ${USAGE}`);
		},
	},
];

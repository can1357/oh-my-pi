/**
 * Settings declared by the Telegram bridge domain (`telegram.*`, tab
 * `interaction`, group `Telegram`). `config/all-settings.ts` registers the
 * domain; the settings panel lists the rows under Interaction → Telegram.
 *
 * The bridge reads them through {@link readTelegramBridgeConfig}, which turns a
 * partially configured domain into one named refusal with an actionable
 * message instead of letting a half-configured host start.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { register } from "../config/registry";
import type { Settings } from "../config/settings";
import { botIdOf } from "./api";
import type { TelegramBridgeConfig } from "./types";

/** `telegram.botToken` — BotFather token; also settable via `PI_TELEGRAM_BOT_TOKEN`. */
export const cfgTelegramBotToken = register({
	id: "telegram.botToken",
	type: "string",
	default: "",
	credential: true,
	env: "PI_TELEGRAM_BOT_TOKEN",
	ui: {
		tab: "interaction",
		group: "Telegram",
		label: "Bot Token",
		description: "BotFather bot token; the environment variable PI_TELEGRAM_BOT_TOKEN takes precedence",
		secret: true,
	},
});

/** `telegram.chatId` — paired chat; empty until `/telegram pair` runs. */
export const cfgTelegramChatId = register({
	id: "telegram.chatId",
	type: "string",
	default: "",
	validate: value => {
		const text = typeof value === "string" ? value.trim() : "";
		if (text === "") return;
		if (!/^-?\d+$/u.test(text) || Number(text) === 0) {
			throw new Error("telegram.chatId must be an integer id (negative for a group or supergroup)");
		}
	},
	ui: {
		tab: "interaction",
		group: "Telegram",
		label: "Chat ID",
		description: "Paired chat id; negative for a group or supergroup. Set by /telegram pair",
	},
});

/** `telegram.allowedUserIds` — users allowed to drive sessions from the chat. */
export const cfgTelegramAllowedUserIds = register({
	id: "telegram.allowedUserIds",
	type: "array",
	default: [] as readonly (number | string)[],
	validate: value => {
		if (!Array.isArray(value)) return;
		for (const entry of value) {
			const text = typeof entry === "number" ? String(entry) : typeof entry === "string" ? entry.trim() : "";
			if (!/^-?\d+$/u.test(text) || Number(text) === 0) {
				throw new Error(`telegram.allowedUserIds entries must be integer user ids (got ${JSON.stringify(entry)})`);
			}
		}
	},
	ui: {
		tab: "interaction",
		group: "Telegram",
		label: "Allowed User IDs",
		description: "Telegram user ids allowed to prompt and command sessions; all other senders are ignored",
	},
});

/** `telegram.defaultCwd` — directory for `/new` and adopted topics; empty → the host process cwd. */
export const cfgTelegramDefaultCwd = register({
	id: "telegram.defaultCwd",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Telegram",
		label: "Default Directory",
		description: "Directory for sessions created from Telegram; empty uses the omp process directory",
	},
});

/** `telegram.model` — model selector for new topic sessions; empty → the settings default model. */
export const cfgTelegramModel = register({
	id: "telegram.model",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Telegram",
		label: "Model",
		description: "Model for new Telegram sessions (provider/model); empty uses the default model",
	},
});

/** `telegram.autoStart` — host the bridge whenever an interactive session starts. */
export const cfgTelegramAutoStart = register({
	id: "telegram.autoStart",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Telegram",
		label: "Auto Start",
		description: "Start the Telegram bridge automatically in interactive sessions once a bot is paired",
	},
});

/** Reason a `telegram.*` configuration cannot drive a host. */
export type TelegramConfigRefusalReason =
	| "no_token"
	| "malformed_token"
	| "not_paired"
	| "no_allowed_users"
	| "cwd_missing";

/** The validated, host-ready subset that pairing needs (token alone is enough). */
export interface TelegramTokenConfig {
	token: string;
	botId: string;
	defaultCwd: string;
	model: string | null;
}

export type TelegramConfigRefusal = {
	ok: false;
	reason: TelegramConfigRefusalReason;
	message: string;
};

export type TelegramTokenConfigResult = { ok: true; config: TelegramTokenConfig } | TelegramConfigRefusal;

export type TelegramBridgeConfigResult = { ok: true; config: TelegramBridgeConfig } | TelegramConfigRefusal;

/** Numeric entries of `telegram.allowedUserIds`, dropping anything the setting validation let through as text. */
function normalizeUserIds(value: readonly (number | string)[]): number[] {
	const ids: number[] = [];
	for (const entry of value) {
		const numeric = typeof entry === "number" ? entry : Number(String(entry).trim());
		if (Number.isInteger(numeric) && numeric !== 0) ids.push(numeric);
	}
	return ids;
}

/** Whether `telegram.chatId` and `telegram.allowedUserIds` describe a paired chat. */
export function isTelegramPaired(settings: Settings): boolean {
	const chatId = cfgTelegramChatId.get(settings).trim();
	if (!/^-?\d+$/u.test(chatId) || Number(chatId) === 0) return false;
	return normalizeUserIds(cfgTelegramAllowedUserIds.get(settings)).length > 0;
}

/**
 * Validate everything a bot identity and a working directory need, without
 * requiring a paired chat: pairing itself starts from a token alone.
 */
export function readTelegramTokenConfig(settings: Settings, cwd: string): TelegramTokenConfigResult {
	const token = cfgTelegramBotToken.get(settings).trim();
	if (token === "") {
		return {
			ok: false,
			reason: "no_token",
			message:
				"No Telegram bot token. Set telegram.botToken in /settings or the PI_TELEGRAM_BOT_TOKEN variable " +
				"to the token @BotFather gave you.",
		};
	}
	const botId = botIdOf(token);
	if (botId === null) {
		return {
			ok: false,
			reason: "malformed_token",
			message: "telegram.botToken is not a BotFather token: expected <digits>:<secret>. Re-copy it from @BotFather.",
		};
	}
	const named = cfgTelegramDefaultCwd.get(settings).trim();
	const home = Bun.env.HOME ?? "~";
	const expanded = named === "~" ? home : named.startsWith("~/") ? path.join(home, named.slice(2)) : named;
	const defaultCwd = path.resolve(cwd, expanded);
	let isDirectory = false;
	try {
		isDirectory = fs.statSync(defaultCwd).isDirectory();
	} catch {
		isDirectory = false;
	}
	if (!isDirectory) {
		return {
			ok: false,
			reason: "cwd_missing",
			message:
				`telegram.defaultCwd (${defaultCwd}) is not an existing directory. Fix the path or leave it empty ` +
				"to use the omp process directory.",
		};
	}
	const model = cfgTelegramModel.get(settings).trim();
	return { ok: true, config: { token, botId, defaultCwd, model: model === "" ? null : model } };
}

/**
 * Full bridge configuration. Every refusal names one missing piece and how to
 * fix it; nothing here touches the network.
 */
export function readTelegramBridgeConfig(settings: Settings, cwd: string): TelegramBridgeConfigResult {
	const base = readTelegramTokenConfig(settings, cwd);
	if (!base.ok) return base;
	const chatIdText = cfgTelegramChatId.get(settings).trim();
	const chatId = chatIdText === "" ? Number.NaN : Number(chatIdText);
	if (!Number.isInteger(chatId) || chatId === 0) {
		return {
			ok: false,
			reason: "not_paired",
			message:
				"Telegram is not paired with a chat yet. Run /telegram pair in the omp TUI, then send the shown " +
				"code to the bot.",
		};
	}
	const allowedUserIds = normalizeUserIds(cfgTelegramAllowedUserIds.get(settings));
	if (allowedUserIds.length === 0) {
		return {
			ok: false,
			reason: "no_allowed_users",
			message:
				"telegram.allowedUserIds is empty, so nobody may drive sessions. Run /telegram pair to add your " +
				"user id, or list ids you trust.",
		};
	}
	return { ok: true, config: { ...base.config, chatId, allowedUserIds } };
}

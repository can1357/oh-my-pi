/**
 * `omp telegram` — the bridge as a foreground process — and the `omp telegram
 * status` report.
 *
 * Unlike the interactive controller there is no TUI and no session factory of
 * its own to build: `main.ts` passes a `createHost` closure (bound to the
 * process-level session factory) and this module owns the lifecycle — read the
 * config, refuse with the holder pid when another host owns the bot, run until
 * SIGINT/SIGTERM, stop cleanly. The token is never printed; anything that may
 * embed it goes through `redactToken`.
 */
import { logger } from "@oh-my-pi/pi-utils";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import type { Settings } from "../config/settings";
import { redactToken, TelegramBotApi } from "./api";
import { acquireTelegramHostLock, readTelegramLockHolder, type TelegramLockResult, telegramHostDir } from "./lock";
import { readTelegramBridgeConfig, readTelegramTokenConfig } from "./settings";
import type { TelegramApi, TelegramChat, TelegramHost, TelegramHostOptions, TelegramSessionFactory } from "./types";

export interface TelegramHeadlessOptions {
	settings: Settings;
	/** Working directory used to resolve `telegram.defaultCwd`. */
	cwd: string;
	sessionFactory: TelegramSessionFactory;
	/** Builds the host from a validated config; injected so this module stays free of host internals. */
	createHost(options: TelegramHostOptions): TelegramHost;
}

/** Exit-code-carrying report of `omp telegram status`. */
export interface TelegramStatusReport {
	lines: string[];
	code: number;
}

export interface TelegramStatusOptions {
	settings: Settings;
	cwd: string;
	/** Test seam; defaults to a real client built from the configured token. */
	api?: TelegramApi;
	/** Base directory of the bot state dirs; defaults to `getTelegramDir()`. */
	baseDir?: string;
}

/**
 * Run the bridge in the foreground until a signal arrives. Writes refusals to
 * stderr and records the exit code; never throws at the caller.
 */
export async function runTelegramHeadless(options: TelegramHeadlessOptions): Promise<void> {
	const read = readTelegramBridgeConfig(options.settings, options.cwd);
	if (!read.ok) {
		process.stderr.write(`Telegram: ${read.message}\n`);
		process.exitCode = 1;
		return;
	}
	const config = read.config;
	let lock: TelegramLockResult;
	try {
		lock = await acquireTelegramHostLock(config.botId);
	} catch (error) {
		process.stderr.write(`Telegram: state directory could not be created: ${describe(error, config.token)}\n`);
		process.exitCode = 2;
		return;
	}
	if (!lock.ok) {
		const who = lock.holderPid === null ? "" : ` (pid ${lock.holderPid})`;
		process.stderr.write(
			`Telegram bridge for this bot is already running${who}. Stop that host before starting another.\n`,
		);
		process.exitCode = 1;
		return;
	}
	const host = options.createHost({
		config,
		api: new TelegramBotApi({ token: config.token }),
		sessionFactory: options.sessionFactory,
		stateDir: telegramHostDir(config.botId),
	});
	const shutdown = async (): Promise<void> => {
		await host.stop().catch(error => logger.warn("Telegram host stop failed", { error: String(error) }));
		await lock.lease.release().catch(error => logger.warn("Telegram lock release failed", { error: String(error) }));
	};
	// The process-wide signal handler exits once cleanups settle: stopping here
	// finishes owned sessions and frees the lock before Ctrl+C/SIGTERM exits.
	const cancelCleanup = postmortem.register("telegram-host", shutdown);
	let announced = false;
	const unsubscribe = host.onStatusChange(status => {
		if (announced || status.state !== "running") return;
		announced = true;
		const bot = status.botUsername === null ? "" : ` as @${status.botUsername}`;
		process.stderr.write(`Telegram bridge running${bot}. Press Ctrl+C to stop.\n`);
	});
	try {
		await host.run();
	} catch (error) {
		process.stderr.write(`Telegram bridge failed: ${describe(error, config.token)}\n`);
		process.exitCode = 1;
	} finally {
		unsubscribe();
		cancelCleanup();
		await shutdown();
	}
}

/**
 * Config sanity without exposing the token: bot identity, whether topics are
 * available, the paired chat, the allow-list, the default directory, and who
 * holds the host lock.
 */
export async function telegramStatusReport(options: TelegramStatusOptions): Promise<TelegramStatusReport> {
	const base = readTelegramTokenConfig(options.settings, options.cwd);
	if (!base.ok) return { code: 1, lines: [base.message] };
	const { token, botId, defaultCwd, model } = base.config;
	const api = options.api ?? new TelegramBotApi({ token });
	const lines = [`default directory: ${defaultCwd}`, `model: ${model ?? "(settings default)"}`];

	let me;
	try {
		me = await api.getMe();
	} catch (error) {
		return {
			code: 2,
			lines: [
				...lines,
				`Telegram did not answer: ${describe(error, token)}`,
				...(await lockLines(botId, options.baseDir)),
			],
		};
	}
	lines.unshift(`bot: ${me.username === undefined ? me.first_name : `@${me.username}`}`);
	lines.push(`topics enabled: ${me.has_topics_enabled === true ? "yes" : "no"}`);

	const paired = readTelegramBridgeConfig(options.settings, options.cwd);
	if (!paired.ok) {
		lines.push(`not paired: ${paired.message}`);
		lines.push(...(await lockLines(botId, options.baseDir)));
		return { code: 1, lines };
	}
	const { chatId, allowedUserIds } = paired.config;
	let chat: TelegramChat | null = null;
	try {
		chat = await api.getChat({ chatId });
	} catch (error) {
		lines.push(`chat ${chatId}: could not be read (${describe(error, token)})`);
	}
	if (chat) {
		lines.push(`chat: ${chat.title ?? chat.username ?? chatId} (${chat.type})`);
		lines.push(`allowed users: ${allowedUserIds.join(", ")}`);
		if (chat.type === "private" && me.has_topics_enabled !== true) {
			lines.push(
				"",
				"Refusal: a session takes a topic, and topics are off for this bot. " +
					"Enable Threaded Mode in the @BotFather mini app (menu button left of the message box → your bot → " +
					"Bot Settings → Threaded Mode), then retry.",
			);
			lines.push(...(await lockLines(botId, options.baseDir)));
			return { code: 1, lines };
		}
		if (chat.type !== "private" && chat.is_forum !== true) {
			lines.push(
				"",
				"Refusal: a non-private chat must be a forum supergroup with Topics enabled. " +
					"Turn on Topics in the group settings and make the bot an administrator with the Manage Topics right, " +
					"or pair a private chat instead.",
			);
			lines.push(...(await lockLines(botId, options.baseDir)));
			return { code: 1, lines };
		}
	}
	lines.push(...(await lockLines(botId, options.baseDir)));
	lines.push("", "Configuration is usable: start the bridge with `omp telegram`.");
	return { code: 0, lines };
}

async function lockLines(botId: string, baseDir: string | undefined): Promise<string[]> {
	const holder = await readTelegramLockHolder(botId, baseDir);
	return [holder === null ? "bridge: not running" : `bridge: running (pid ${holder})`];
}

/** Message text that never embeds the bot token. */
function describe(error: unknown, token: string): string {
	return redactToken(error instanceof Error ? error.message : String(error), token);
}

/**
 * `getUpdates` long-poll loop.
 *
 * Registers the command menu once, then polls for updates, backing off after
 * transient failures and handing every update to the caller sequentially. A
 * handler failure for one update is logged and does not end the loop. Fatal
 * refusals — an unauthorized token or a second `getUpdates` consumer — reject
 * `run()` with a message naming the cause.
 */

import { logger, sleepLong } from "@oh-my-pi/pi-utils";
import type { TelegramApi, TelegramBotCommand, TelegramPoller, TelegramUpdate } from "./types";

/** Update kinds the bridge subscribes to; `stopped_message_generation` powers private-chat drafts. */
export const ALLOWED_UPDATES: readonly string[] = ["message", "callback_query", "stopped_message_generation"];

const POLL_TIMEOUT_SECONDS = 30;
const POLL_BACKOFF_MS = 1_000;
const POLL_BACKOFF_MAX_MS = 30_000;

const errorText = (error: unknown): string => String((error as { message?: unknown } | null)?.message ?? error);

const codeOf = (error: unknown): unknown =>
	typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

const backoffMs = (failures: number): number =>
	Math.min(POLL_BACKOFF_MS * 2 ** Math.max(0, failures - 1), POLL_BACKOFF_MAX_MS);

/** The cause of a refusal that must end the loop, or null when it is transient. */
function fatalRefusal(error: unknown): string | null {
	const code = codeOf(error);
	const text = errorText(error);
	if (code === 401 || /unauthorized/iu.test(text)) {
		return "Telegram refused the bot token (401 Unauthorized); check telegram.botToken.";
	}
	if (code === 409 || /terminated by other getUpdates|conflict/iu.test(text)) {
		return "Another process is polling this bot with getUpdates (409 Conflict); only one Telegram bridge may run per bot token.";
	}
	return null;
}

/** Backoff pause that ends early, without rejecting, when the poller stops. */
async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	try {
		await sleepLong(ms, signal);
	} catch {
		// Aborted by stop(): the loop re-checks its signal and exits.
	}
}

/** Long-poll loop over one Bot API client. */
export function createPoller(deps: {
	api: TelegramApi;
	handleUpdate(update: TelegramUpdate): Promise<unknown>;
	commands: readonly TelegramBotCommand[];
	sleep?(ms: number, signal: AbortSignal): Promise<void>;
}): TelegramPoller {
	const { api, handleUpdate, commands, sleep = defaultSleep } = deps;
	let stopped = false;
	let controller: AbortController | null = null;

	async function handOver(update: TelegramUpdate): Promise<void> {
		try {
			await handleUpdate(update);
		} catch (error) {
			logger.debug("telegram: update.failed", { updateId: update?.update_id ?? null, error: errorText(error) });
		}
	}

	async function run(): Promise<void> {
		const own = controller ?? new AbortController();
		controller = own;
		const { signal } = own;
		try {
			await api.setMyCommands(commands);
			logger.debug("telegram: bot.commands_set", { count: commands.length });
		} catch (error) {
			logger.warn("telegram: bot.commands_failed", { error: errorText(error) });
		}
		let offset = 0;
		let failures = 0;
		while (!stopped && !signal.aborted) {
			try {
				const updates = await api.getUpdates(
					{ offset, timeout: POLL_TIMEOUT_SECONDS, allowedUpdates: ALLOWED_UPDATES },
					signal,
				);
				failures = 0;
				for (const update of updates ?? []) {
					offset = Math.max(offset, Number(update?.update_id ?? 0) + 1);
					await handOver(update);
				}
			} catch (error) {
				if (stopped || signal.aborted) break;
				const fatal = fatalRefusal(error);
				if (fatal !== null) {
					controller = null;
					throw new Error(fatal, { cause: error });
				}
				failures += 1;
				const pauseMs = backoffMs(failures);
				logger.debug("telegram: poll.failed", { attempt: failures, pauseMs, error: errorText(error) });
				await sleep(pauseMs, signal);
			}
		}
		controller = null;
	}

	function stop(): void {
		stopped = true;
		controller?.abort();
	}

	return { run, stop };
}

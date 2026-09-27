/**
 * One-time pairing of a bot with a chat.
 *
 * `/telegram pair` shows a code in the TUI; the first `/pair <code>` (or the
 * `/start <code>` deep link `https://t.me/<bot>?start=<code>`) sent to the bot
 * binds `telegram.chatId` to that chat and appends its sender to
 * `telegram.allowedUserIds`. Pairing polls `getUpdates` directly, so it holds
 * the same one-host-per-token lock the running bridge does; the controller
 * stops its own host and refuses when another process holds the lock.
 *
 * The chat must be able to host topics (a session is a topic): a forum
 * supergroup (`is_forum`), or a private chat whose bot has Threaded Mode
 * enabled (`has_topics_enabled`). Anything else is refused with the fix.
 */
import type { TelegramApi, TelegramUpdate, TelegramUser } from "./types";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Pause after an empty long-poll result so a mock/test transport cannot spin. */
const DEFAULT_POLL_PAUSE_MS = 250;

export type PairingOutcome =
	| { kind: "paired"; chatId: number; userId: number; chatTitle: string }
	| { kind: "refused"; message: string }
	| { kind: "timeout" }
	| { kind: "cancelled" };

export interface PairingRun {
	/** The code the user must send. */
	readonly code: string;
	/** Settles exactly once, with the first matching message, a refusal, the timeout, or cancellation. */
	readonly outcome: Promise<PairingOutcome>;
	cancel(): void;
}

export interface PairingDeps {
	api: TelegramApi;
	code: string;
	/** Called once, after `getMe` answers, so the TUI can show the deep link. */
	onReady?(info: { botUsername: string | null }): void;
	/** Cooperative scheduling seam; defaults to a `Bun.sleep` that respects the signal. */
	sleep?(ms: number, signal: AbortSignal): Promise<void>;
	timeoutMs?: number;
}

/** Fix instructions shown when a chat cannot host topics. */
const THREADED_MODE_FIX =
	"Enable Threaded Mode in the @BotFather mini app: open the chat with @BotFather, tap the menu button " +
	"left of the message box, pick your bot, then Bot Settings → Threaded Mode. Then pair again.";

const FORUM_FIX =
	"Topics are off for this supergroup: open the group's settings, enable Topics, make the bot an " +
	"administrator with the Manage Topics right, then pair again.";

/** Split `/pair <code>` / `/start <code>` / command@bot forms; returns the code argument or null. */
function parsePairArgument(text: string): { command: string; code: string } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const firstSpace = trimmed.search(/\s/u);
	const head = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
	const at = head.indexOf("@");
	const command = (at === -1 ? head : head.slice(0, at)).toLowerCase();
	return { command, code: rest };
}

/**
 * Decide what one incoming update means for pairing. Pure: `null` means the
 * update is unrelated (wrong code, no sender, not a pairing command) and the
 * poll continues.
 */
export function classifyPairingUpdate(update: TelegramUpdate, code: string, me: TelegramUser): PairingOutcome | null {
	const message = update.message;
	if (!message) return null;
	const sender = message.from;
	if (!sender || sender.is_bot === true) return null;
	const text = message.text ?? message.caption;
	if (!text) return null;
	const parsed = parsePairArgument(text);
	if (!parsed || (parsed.command !== "pair" && parsed.command !== "start")) return null;
	if (parsed.code.toLowerCase() !== code.toLowerCase()) return null;

	const chat = message.chat;
	if (chat.type === "private") {
		if (me.has_topics_enabled !== true) return { kind: "refused", message: THREADED_MODE_FIX };
	} else if (chat.type === "group" || chat.type === "supergroup") {
		if (chat.is_forum !== true) return { kind: "refused", message: FORUM_FIX };
	} else {
		return {
			kind: "refused",
			message: `A ${chat.type} cannot host sessions: pair a private chat with Threaded Mode or a forum supergroup.`,
		};
	}
	return {
		kind: "paired",
		chatId: chat.id,
		userId: sender.id,
		chatTitle: chat.title ?? chat.username ?? chat.first_name ?? String(chat.id),
	};
}

/**
 * Start polling for the pairing code. The returned run resolves its `outcome`
 * once and only once; `cancel()` aborts the in-flight long poll.
 */
export function startTelegramPairing(deps: PairingDeps): PairingRun {
	const controller = new AbortController();
	const signal = controller.signal;
	const { promise, resolve } = Promise.withResolvers<PairingOutcome>();
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const sleep =
		deps.sleep ??
		(async (ms: number, abort: AbortSignal) => {
			const timer = Promise.withResolvers<void>();
			const onAbort = () => {
				clearTimeout(handle);
				timer.resolve();
			};
			const handle = setTimeout(() => {
				abort.removeEventListener("abort", onAbort);
				timer.resolve();
			}, ms);
			abort.addEventListener("abort", onAbort, { once: true });
			await timer.promise;
		});
	let settled = false;
	const settle = (outcome: PairingOutcome) => {
		if (settled) return;
		settled = true;
		resolve(outcome);
	};

	const run = async () => {
		let me: TelegramUser;
		try {
			me = await deps.api.getMe(signal);
		} catch (error) {
			if (signal.aborted) {
				settle({ kind: "cancelled" });
				return;
			}
			settle({
				kind: "refused",
				message: `Telegram did not answer: ${error instanceof Error ? error.message : String(error)}`,
			});
			return;
		}
		if (signal.aborted) {
			settle({ kind: "cancelled" });
			return;
		}
		deps.onReady?.({ botUsername: me.username ?? null });
		const deadline = Date.now() + timeoutMs;
		let offset: number | undefined;
		while (!signal.aborted) {
			if (Date.now() >= deadline) {
				settle({ kind: "timeout" });
				return;
			}
			let updates: TelegramUpdate[];
			try {
				updates = await deps.api.getUpdates({ offset, timeout: 25 }, signal);
			} catch (error) {
				if (signal.aborted) break;
				settle({
					kind: "refused",
					message: `Telegram did not answer: ${error instanceof Error ? error.message : String(error)}`,
				});
				return;
			}
			for (const update of updates) {
				offset = Math.max(offset ?? 0, update.update_id + 1);
				const outcome = classifyPairingUpdate(update, deps.code, me);
				if (outcome) {
					// Confirm the pairing message: left unconfirmed, the bridge's own
					// poller would receive it again and answer `/pair` in the topic.
					try {
						await deps.api.getUpdates({ offset, timeout: 0 }, signal);
					} catch {
						// Best effort: a replayed `/pair` is only noise.
					}
					settle(outcome);
					return;
				}
			}
			if (updates.length === 0) await sleep(DEFAULT_POLL_PAUSE_MS, signal);
		}
		settle({ kind: "cancelled" });
	};

	void run().catch(error => {
		settle({
			kind: "refused",
			message: `Pairing failed: ${error instanceof Error ? error.message : String(error)}`,
		});
	});

	return {
		code: deps.code,
		outcome: promise,
		cancel: () => controller.abort(),
	};
}

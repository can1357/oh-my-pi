/**
 * Owns the Telegram bridge inside one interactive process: manual
 * `/telegram start|stop|status|pair|unpair`, the opt-in `telegram.autoStart`
 * policy, and re-attaching the TUI session when its identity changes.
 *
 * Everything that touches the host, the lock, or the settings runs on one
 * serialized operations chain with a stop epoch: a session switch, a stop, or
 * shutdown invalidates a queued start instead of interleaving with it. Failures
 * are reported dimmed through `ctx.showStatus` and never thrown at the TUI.
 *
 * Pattern: `collab/controller.ts`.
 */
import { randomBytes } from "node:crypto";
import { logger } from "@oh-my-pi/pi-utils";
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import type { InteractiveModeContext } from "../modes/types";
import { redactToken, TelegramBotApi } from "./api";
import { acquireTelegramHostLock, type TelegramHostLease, type TelegramLockResult, telegramHostDir } from "./lock";
import { type PairingRun, startTelegramPairing } from "./pairing";
import {
	cfgTelegramAllowedUserIds,
	cfgTelegramAutoStart,
	cfgTelegramChatId,
	isTelegramPaired,
	readTelegramBridgeConfig,
	readTelegramTokenConfig,
} from "./settings";
import type { AttachedSessionBinding, TelegramBridgeConfig, TelegramHost, TelegramSessionFactory } from "./types";

/** Hook-status key driving the status-line indicator. */
const HOOK_KEY = "telegram";

export type TelegramControllerState = "off" | "starting" | "running" | "stopping" | "failed";

/** Snapshot rendered by `/telegram status` and `omp telegram status`. */
export interface TelegramControllerStatus {
	state: TelegramControllerState;
	botUsername: string | null;
	topics: number;
	liveSessions: number;
	mirrors: number;
	attachedThreadId: number | null;
	error: string | null;
	/** A well-formed bot token and a valid default directory are configured. */
	configured: boolean;
	/** `telegram.chatId` and `telegram.allowedUserIds` describe a usable chat. */
	paired: boolean;
	autoStart: boolean;
	/** A pairing poll is in flight. */
	pairing: boolean;
	pairingCode: string | null;
}

interface ActivePairing {
	run: PairingRun;
	lease: TelegramHostLease;
	code: string;
}

export class TelegramController {
	#ctx: InteractiveModeContext;
	#factory: TelegramSessionFactory | undefined;
	#host: TelegramHost | undefined;
	#lease: TelegramHostLease | undefined;
	#state: TelegramControllerState = "off";
	/** Serializes start/stop/attach sequences so a switch never interleaves with a stop. */
	#ops: Promise<void> = Promise.resolve();
	/** Explicit stop invalidates queued launches and in-flight pairings. */
	#stopEpoch = 0;
	#shutdown = false;
	#pairing: ActivePairing | undefined;
	#lastError: string | null = null;
	#botUsername: string | null = null;
	#unsubscribeStatus: (() => void) | undefined;
	#unsubscribeSessionChange: (() => void) | undefined;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
	}

	/** The live host of this process, if any. */
	get host(): TelegramHost | undefined {
		return this.#host;
	}

	/** Installed by `main.ts` after the interactive mode's own construction. */
	setSessionFactory(factory: TelegramSessionFactory): void {
		this.#factory = factory;
	}

	/**
	 * Interactive startup finished: apply `telegram.autoStart`. An unpaired or
	 * unconfigured bot is skipped silently — auto-start must not nag on every
	 * launch of a process that never uses Telegram.
	 */
	startupComplete(): void {
		if (this.#shutdown) return;
		this.#observeSessionChanges();
		if (!cfgTelegramAutoStart.get(this.#ctx.settings)) return;
		const read = readTelegramBridgeConfig(this.#ctx.settings, this.#sessionCwd());
		if (!read.ok) {
			logger.debug("Telegram auto-start skipped", { reason: read.reason });
			return;
		}
		void this.start();
	}

	/** Start (or reuse) the bridge for the configured bot. Never throws. */
	async start(): Promise<TelegramControllerStatus> {
		if (this.#shutdown) {
			this.#notice("The Telegram bridge is shut down for this process.");
			return this.status();
		}
		this.#observeSessionChanges();
		const stopEpoch = this.#stopEpoch;
		const run = this.#ops.then(() => this.#startLocked(stopEpoch));
		this.#ops = run.then(
			() => {},
			() => {},
		);
		await run;
		return this.status();
	}

	async #startLocked(stopEpoch: number): Promise<void> {
		// A stop or shutdown requested after this start was queued wins over it.
		if (this.#shutdown || this.#host || stopEpoch !== this.#stopEpoch) return;
		if (this.#pairing) {
			this.#notice("Telegram pairing is in progress; finish or cancel it before starting the bridge.");
			return;
		}
		const factory = this.#factory;
		if (!factory) {
			this.#notice("The Telegram session factory is not installed yet; retry in a moment.");
			return;
		}
		const read = readTelegramBridgeConfig(this.#ctx.settings, this.#sessionCwd());
		if (!read.ok) {
			this.#notice(read.message);
			return;
		}
		let lock: TelegramLockResult;
		try {
			lock = await acquireTelegramHostLock(read.config.botId);
		} catch (error) {
			this.#notice(`Telegram state directory could not be created: ${describe(error, read.config.token)}`);
			return;
		}
		if (!lock.ok) {
			this.#notice(
				`A Telegram bridge for this bot is already running${lock.holderPid === null ? "" : ` (pid ${lock.holderPid})`}. ` +
					"Stop that host first, or use /telegram status.",
			);
			return;
		}
		await this.#install(read.config, lock.lease, factory);
	}

	async #install(
		config: TelegramBridgeConfig,
		lease: TelegramHostLease,
		factory: TelegramSessionFactory,
	): Promise<void> {
		// Lazy, and the only deliberate exception to static imports here: a static
		// `./host` import would pull the whole bridge graph (topic sessions,
		// mirrors, dialog desk, api) into every TUI startup, including users who
		// never configure a bot — the same reason `main.ts` keeps the headless
		// host out of normal startup.
		const { createTelegramHost } = await import("./host");
		const host = createTelegramHost({
			config,
			api: new TelegramBotApi({ token: config.token }),
			sessionFactory: factory,
			stateDir: telegramHostDir(config.botId),
		});
		this.#host = host;
		this.#lease = lease;
		this.#lastError = null;
		this.#state = "starting";
		this.#unsubscribeStatus = host.onStatusChange(() => {
			this.#botUsername = host.status().botUsername;
			this.#updateIndicator();
		});
		this.#updateIndicator();
		try {
			await this.#attachCurrent();
		} catch (error) {
			await this.#teardownHost(host);
			this.#notice(`Telegram could not attach this session: ${describe(error, config.token)}`);
			return;
		}
		this.#state = "running";
		this.#updateIndicator();
		void host.run().then(
			() => {},
			error => {
				const message = `Telegram bridge failed: ${describe(error, config.token)}`;
				const cleanup = this.#ops.then(() => this.#teardownHost(host));
				this.#ops = cleanup.then(
					() => {},
					() => {},
				);
				void cleanup.finally(() => this.#fail(message));
			},
		);
	}

	/** Stop the bridge; queued launches are cancelled. Never throws. */
	async stop(reason: string): Promise<void> {
		this.#stopEpoch++;
		this.#cancelPairing();
		const host = this.#host;
		if (!host) {
			this.#updateIndicator();
			return;
		}
		const run = this.#ops.then(() => this.#teardownHost(host, reason));
		this.#ops = run.then(
			() => {},
			() => {},
		);
		await run;
	}

	/** Stop for good; no further hosts are started for this process. */
	async shutdown(reason: string): Promise<void> {
		this.#shutdown = true;
		this.#unsubscribeSessionChange?.();
		this.#unsubscribeSessionChange = undefined;
		await this.stop(reason);
		await this.#ops;
		this.#ctx.setHookStatus(HOOK_KEY, undefined);
	}

	/** Point the bridge at the current session, detaching the previous one. */
	async #attachCurrent(): Promise<void> {
		const host = this.#host;
		if (!host) return;
		const binding: AttachedSessionBinding = {
			session: this.#ctx.session,
			addDialogHost: remote => this.#ctx.remoteDialogHosts.add(remote),
			fallbackTopicName: "terminal",
		};
		await host.attach(binding);
	}

	async #teardownHost(host: TelegramHost, reason = "stopped"): Promise<void> {
		if (this.#host !== host) return;
		this.#state = "stopping";
		this.#updateIndicator();
		try {
			await host.stop();
		} catch (error) {
			logger.warn("Telegram host stop failed", { error: String(error), reason });
		} finally {
			if (this.#host === host) this.#host = undefined;
			this.#unsubscribeStatus?.();
			this.#unsubscribeStatus = undefined;
			this.#botUsername = null;
			const lease = this.#lease;
			this.#lease = undefined;
			if (lease)
				await lease.release().catch(error => logger.warn("Telegram lock release failed", { error: String(error) }));
			this.#state = "off";
			this.#updateIndicator();
		}
	}

	status(): TelegramControllerStatus {
		const hostStatus = this.#host?.status();
		return {
			state: this.#state,
			botUsername: hostStatus?.botUsername ?? this.#botUsername,
			topics: hostStatus?.topics ?? 0,
			liveSessions: hostStatus?.liveSessions ?? 0,
			mirrors: hostStatus?.mirrors ?? 0,
			attachedThreadId: hostStatus?.attachedThreadId ?? null,
			error: this.#lastError,
			configured: readTelegramTokenConfig(this.#ctx.settings, this.#sessionCwd()).ok,
			paired: isTelegramPaired(this.#ctx.settings),
			autoStart: cfgTelegramAutoStart.get(this.#ctx.settings),
			pairing: this.#pairing !== undefined,
			pairingCode: this.#pairing?.code ?? null,
		};
	}

	/**
	 * Bind the bot to a chat: show a one-time code, stop this process's host
	 * (its poller would fight ours for the offset), refuse when another process
	 * holds the lock, and let the first matching message pair and start the host.
	 */
	async pair(): Promise<TelegramControllerStatus> {
		if (this.#shutdown) {
			this.#notice("The Telegram bridge is shut down for this process.");
			return this.status();
		}
		if (this.#pairing) {
			this.#notice("Telegram pairing is already in progress.");
			return this.status();
		}
		const base = readTelegramTokenConfig(this.#ctx.settings, this.#sessionCwd());
		if (!base.ok) {
			this.#notice(base.message);
			return this.status();
		}
		await this.stop("pairing");
		let lock: TelegramLockResult;
		try {
			lock = await acquireTelegramHostLock(base.config.botId);
		} catch (error) {
			this.#notice(`Telegram state directory could not be created: ${describe(error, base.config.token)}`);
			return this.status();
		}
		if (!lock.ok) {
			this.#notice(
				`A Telegram host for this bot is already running${lock.holderPid === null ? "" : ` (pid ${lock.holderPid})`}. ` +
					"Stop it before pairing.",
			);
			return this.status();
		}
		const code = randomBytes(4).toString("hex");
		const api = new TelegramBotApi({ token: base.config.token });
		const run = startTelegramPairing({
			api,
			code,
			onReady: info => this.#showPairingCode(info.botUsername, code),
		});
		this.#pairing = { run, lease: lock.lease, code };
		this.#updateIndicator();
		this.#showPairingCode(null, code);
		void this.#awaitPairing(run, lock.lease, api);
		return this.status();
	}

	#showPairingCode(botUsername: string | null, code: string): void {
		const link = botUsername === null ? null : `https://t.me/${botUsername}?start=${code}`;
		this.#ctx.showStatus(
			[
				`Telegram pairing code: ${code}`,
				link === null ? `Send /pair ${code} to your bot.` : `Open ${link} or send /pair ${code} to your bot.`,
				"Waiting up to 10 minutes; /telegram stop cancels.",
			].join("\n"),
		);
	}

	async #awaitPairing(run: PairingRun, lease: TelegramHostLease, api: TelegramBotApi): Promise<void> {
		const outcome = await run.outcome;
		if (this.#pairing?.run === run) this.#pairing = undefined;
		await lease
			.release()
			.catch(error => logger.warn("Telegram pairing lock release failed", { error: String(error) }));
		// Shutdown already cleared the indicator and stopped the host; report nothing.
		if (this.#shutdown) return;
		this.#updateIndicator();
		if (outcome.kind === "paired") {
			cfgTelegramChatId.set(this.#ctx.settings, String(outcome.chatId));
			const ids = new Set<number>();
			for (const entry of cfgTelegramAllowedUserIds.get(this.#ctx.settings)) {
				const numeric = typeof entry === "number" ? entry : Number(String(entry).trim());
				if (Number.isInteger(numeric) && numeric !== 0) ids.add(numeric);
			}
			ids.add(outcome.userId);
			cfgTelegramAllowedUserIds.set(this.#ctx.settings, [...ids]);
			this.#ctx.showStatus(
				`Telegram paired with ${outcome.chatTitle} (chat ${outcome.chatId}). Starting the bridge…`,
			);
			try {
				await api.sendMessage({
					chatId: outcome.chatId,
					text: "Paired. This chat now drives omp sessions; send /help for the command list.",
				});
			} catch (error) {
				logger.warn("Telegram pairing reply failed", { error: String(error) });
			}
			await this.start();
			return;
		}
		if (outcome.kind === "timeout") {
			this.#ctx.showStatus("Telegram pairing timed out. Run /telegram pair to try again.");
			return;
		}
		if (outcome.kind === "cancelled") {
			this.#ctx.showStatus("Telegram pairing cancelled.");
			return;
		}
		this.#notice(outcome.message);
	}

	/** Forget the paired chat and allowed users, and stop the bridge. */
	async unpair(): Promise<void> {
		this.#cancelPairing();
		cfgTelegramChatId.set(this.#ctx.settings, "");
		cfgTelegramAllowedUserIds.set(this.#ctx.settings, []);
		await this.stop("unpaired");
		this.#lastError = null;
		this.#ctx.showStatus("Telegram unpaired: chat and allowed users cleared.");
	}

	#cancelPairing(): void {
		const pairing = this.#pairing;
		if (!pairing) return;
		this.#pairing = undefined;
		pairing.run.cancel();
		void pairing.lease
			.release()
			.catch(error => logger.warn("Telegram pairing lock release failed", { error: String(error) }));
	}

	#observeSessionChanges(): void {
		this.#unsubscribeSessionChange ??= this.#ctx.session.registerSessionChangeCallback(() =>
			this.#onSessionChanged(),
		);
	}

	#onSessionChanged(): void {
		if (this.#shutdown || !this.#host) return;
		const run = this.#ops.then(async () => {
			if (this.#shutdown || !this.#host) return;
			const session = this.#ctx.session;
			if (session.isSessionTransitioning) {
				try {
					await session.waitForSessionTransition();
				} catch {
					// A rolled-back transition leaves the previous session in place; the host stays attached to it.
					return;
				}
			}
			if (this.#shutdown || !this.#host) return;
			try {
				await this.#host.detach();
				await this.#attachCurrent();
			} catch (error) {
				this.#notice(`Telegram could not switch to the new session: ${describe(error, null)}`);
			}
		});
		this.#ops = run.then(
			() => {},
			() => {},
		);
	}

	/** Status-line indicator: `telegram: on (@bot)` while hosting, cleared when off. */
	#updateIndicator(): void {
		let text: string | undefined;
		if (this.#pairing) text = "telegram: pairing";
		else if (this.#state === "running")
			text = this.#botUsername === null ? "telegram: on" : `telegram: on (@${this.#botUsername})`;
		else if (this.#state === "starting") text = "telegram: starting";
		else if (this.#state === "stopping") text = "telegram: stopping";
		else if (this.#state === "failed") text = "telegram: failed";
		this.#ctx.setHookStatus(HOOK_KEY, text);
	}

	/** Report an expected refusal: dim status line, no state change, never thrown. */
	#notice(message: string): void {
		const clean = sanitizeDisplayLine(message);
		this.#lastError = clean;
		this.#ctx.showStatus(truncateToWidth(`Telegram: ${clean}`, TRUNCATE_LENGTHS.LINE), { dim: true });
	}

	/** Report a host that died: state failed, dim status line. */
	#fail(message: string): void {
		this.#notice(message);
		this.#state = "failed";
		this.#updateIndicator();
	}

	#sessionCwd(): string {
		return this.#ctx.sessionManager.getCwd();
	}
}

/** Message text that never embeds the bot token. */
function describe(error: unknown, token: string | null): string {
	const text = error instanceof Error ? error.message : String(error);
	return token === null ? text : redactToken(text, token);
}

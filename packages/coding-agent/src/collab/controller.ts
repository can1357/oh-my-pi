/**
 * Owns collaboration hosting for one interactive process: manual `/collab`,
 * the opt-in `collab.autoStart` policy, and room rotation when the active
 * session changes.
 *
 * Every room this process hosts shares one random `instanceId` and gets the
 * next `generation`, which is what the local registry keys capabilities by.
 * A session change stops the current room — withdrawing its registry entry
 * and telling guests goodbye — before a replacement room for the new session
 * is started, so a card that names generation N can never reach session N+1.
 */
import { randomBytes } from "node:crypto";
import { logger } from "@oh-my-pi/pi-utils";
import { sanitizeDisplayLine } from "../modes/components/extensions/display-text";
import type { InteractiveModeContext } from "../modes/types";
import { TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import { CollabHost, CollabHostStoppedError } from "./host";
import type { CollabAccess } from "./registry";

export type CollabAutoStart = "off" | CollabAccess;

export interface CollabStartOptions {
	/** Highest access the registry may hand out for the new room. */
	access: CollabAccess;
	/** Relay override (`host[:port]` or a full URL); defaults to `collab.relayUrl`. */
	relay?: string;
}

export class CollabController {
	readonly instanceId: string;
	#ctx: InteractiveModeContext;
	#generation = 0;
	#host: CollabHost | undefined;
	/** Serializes stop/start sequences so a rotation never interleaves with another. */
	#ops: Promise<void> = Promise.resolve();
	/** Installed when the first room starts; a process that never hosts never subscribes. */
	#unsubscribeSessionChange: (() => void) | undefined;
	/** Guests may drive the session only once interactive startup has finished. */
	#startupComplete = false;
	#shutdown = false;
	#shutdownWake: PromiseWithResolvers<void> | undefined;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
		// 64 random bits: unique per process on one machine, short enough for `omp collab link <id>` and socket paths.
		this.instanceId = randomBytes(8).toString("hex");
	}

	/** The live room, if any; a room that is ending or ended is reported as absent. */
	get host(): CollabHost | undefined {
		const host = this.#host;
		return host && !host.ending ? host : undefined;
	}

	/** Registry generation of the most recently started room; 0 before the first. */
	get generation(): number {
		return this.#generation;
	}

	get autoStartMode(): CollabAutoStart {
		return this.#ctx.settings.get("collab.autoStart");
	}

	/**
	 * Apply `collab.autoStart` for the current session. The room object is
	 * installed synchronously so dialogs raised before the relay connects are
	 * retained for the first writer; the connection itself proceeds in the
	 * background and a failure is reported without disturbing the session.
	 * Until {@link startupComplete} is called, guests can join and answer
	 * dialogs but cannot prompt, interrupt, or command agents.
	 */
	autoStart(): void {
		// Observe session changes from now on even when auto-start is currently
		// off: the setting is read live, so enabling it later applies to the
		// next `/new`, `/resume`, or branch without restarting omp.
		this.#observeSessionChanges();
		const access = this.autoStartMode;
		if (access === "off" || this.#shutdown || this.host) return;
		const started = this.#launchReporting(access);
		this.#ops = this.#ops.then(() => started);
	}

	/**
	 * Interactive startup (extension hooks, mode reconciliation) has finished:
	 * from now on guests in any room of this process may drive the session.
	 */
	startupComplete(): void {
		this.#startupComplete = true;
	}

	#observeSessionChanges(): void {
		this.#unsubscribeSessionChange ??= this.#ctx.session.registerSessionChangeCallback(() =>
			this.#onSessionChanged(),
		);
	}

	/**
	 * Start (or reuse) a room for `/collab`. A live room already granting at
	 * least the requested access is reused; a view-only room is replaced when
	 * control is requested.
	 */
	async start(options: CollabStartOptions): Promise<CollabHost> {
		const existing = this.host;
		if (existing && (existing.access === "control" || options.access === "view")) return existing;
		if (existing) await existing.stop("restarting with control access");
		return this.#launch(options.access, options.relay);
	}

	/** Stop the current room; also awaits a stop that is already in flight. */
	async stop(reason: string): Promise<void> {
		await this.#host?.stop(reason);
	}

	/** Resolves once no stop/start sequence is in flight. */
	idle(): Promise<void> {
		return this.#ops;
	}

	/** Stop hosting for good; no further rooms are started for this process. */
	async shutdown(reason: string): Promise<void> {
		this.#shutdown = true;
		this.#shutdownWake?.resolve();
		this.#unsubscribeSessionChange?.();
		this.#unsubscribeSessionChange = undefined;
		// Stop before draining the chain: a room still connecting is aborted at
		// once instead of holding shutdown for the relay connect timeout.
		await this.stop(reason);
		await this.#ops;
	}

	#resolveRelayUrl(relay?: string): string {
		const input = relay?.trim() || this.#ctx.settings.get("collab.relayUrl") || "";
		if (!input) {
			throw new Error(
				"No relay configured. Set collab.relayUrl in /settings or pass one: /collab relay.example.com",
			);
		}
		// Scheme-less relay args default to wss (ws:// must be spelled out for localhost).
		return input.includes("://") ? input : `wss://${input}`;
	}

	/**
	 * Install the next room synchronously at ordinary startup so early dialogs
	 * can be retained. During a session transition, wait for its final identity
	 * and state first. Connect only after the previous room is fully gone.
	 */
	async #launch(access: CollabAccess, relay?: string): Promise<CollabHost> {
		if (this.#shutdown) throw new CollabHostStoppedError("collab controller shut down");
		// Identity cleanup callbacks can precede awaited hooks and message replacement.
		// Pin and expose only the session left after commit or rollback.
		if (this.#ctx.session.isSessionTransitioning) {
			const shutdown = (this.#shutdownWake ??= Promise.withResolvers<void>()).promise;
			await Promise.race([this.#ctx.session.waitForSessionTransition(), shutdown]);
		}
		// Manual upgrades may reach this after awaiting the old room's stop.
		// Shutdown is terminal even if it overtook that await.
		if (this.#shutdown) throw new CollabHostStoppedError("collab controller shut down");
		const relayUrl = this.#resolveRelayUrl(relay);
		const webUrl = this.#ctx.settings.get("collab.webUrl") || "";
		this.#observeSessionChanges();
		const previous = this.#host;
		const host = new CollabHost(this.#ctx, {
			instanceId: this.instanceId,
			generation: ++this.#generation,
			access,
			guestActionsReady: () => this.#startupComplete && !this.#ctx.session.isSessionTransitioning,
		});
		this.#host = host;
		this.#ctx.collabHost = host;
		try {
			// A previous room may still be withdrawing subscriptions and registry
			// state after a fatal close. Finish that before installing new taps.
			await previous?.stop("replaced");
			await host.start(relayUrl, webUrl);
		} catch (err) {
			if (this.#host === host) this.#host = undefined;
			if (this.#ctx.collabHost === host) this.#ctx.collabHost = undefined;
			throw err;
		}
		return host;
	}

	/**
	 * Background start: a failure is logged and shown, never thrown. A room
	 * that this controller (or `/collab stop`) deliberately stopped while it
	 * was still connecting — session switch, access upgrade, shutdown — is not
	 * a failure; its replacement, if any, is already on its way.
	 */
	async #launchReporting(access: CollabAccess): Promise<void> {
		try {
			await this.#launch(access);
		} catch (err) {
			if (this.#shutdown || err instanceof CollabHostStoppedError) return;
			logger.warn("Collab auto-start failed", { error: String(err) });
			const message = sanitizeDisplayLine(err instanceof Error ? err.message : String(err));
			this.#ctx.showStatus(truncateToWidth(`Collab auto-start failed: ${message}`, TRUNCATE_LENGTHS.LINE), {
				dim: true,
			});
		}
	}

	/**
	 * The session this process drives changed identity (new, resume, fork,
	 * branch). The old room is already inert — the host refuses frames and
	 * queries for a session it never shared — so stop it, then apply the
	 * auto-start policy to the new session.
	 */
	#onSessionChanged(): void {
		const previous = this.host;
		if (previous && previous.sessionId === this.#ctx.sessionManager.getSessionId()) return;
		// Stop synchronously so a room still connecting is aborted now rather than
		// after the queued start settles; the chain then waits for that stop.
		const stopping = previous?.stop("session switched");
		this.#ops = this.#ops.then(async () => {
			await stopping;
			if (this.#shutdown || this.host) return;
			const access = this.autoStartMode;
			if (access !== "off") await this.#launchReporting(access);
		});
	}
}

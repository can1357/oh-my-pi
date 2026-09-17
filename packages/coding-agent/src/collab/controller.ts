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

const SESSION_SWITCH_REASON =
	"session switched; prompts not shown in the conversation were not submitted. Rejoin and resend them";

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
	/** Explicit stop invalidates launch requests, not the saved auto-start policy. */
	#stopEpoch = 0;
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

	/** The live room for the current session; stale or ending rooms are absent. */
	get host(): CollabHost | undefined {
		const host = this.#host;
		return host && !host.ending && host.sessionId === this.#ctx.sessionManager.getSessionId() ? host : undefined;
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
		if (access === "off" || this.#shutdown || this.host || this.#ctx.collabGuest) return;
		const started = this.#launchReporting(access, this.#stopEpoch);
		this.#ops = this.#ops.then(() => started);
	}

	/** Admit hosting only for a restored local identity, preserving later stop/shutdown intent. */
	resumeAfterGuest(restoration: Promise<boolean>): void {
		if (this.#shutdown) return;
		this.#observeSessionChanges();
		const stopEpoch = this.#stopEpoch;
		const shutdown = (this.#shutdownWake ??= Promise.withResolvers<void>()).promise;
		// The guest reports restoration failures to its caller/UI. Observe them
		// here only to prevent hosting; shutdown must not await a stalled hook.
		const restored = Promise.race([restoration.catch(() => false), shutdown]);
		this.#ops = this.#ops.then(async () => {
			if ((await restored) !== true) return;
			if (this.#shutdown || stopEpoch !== this.#stopEpoch || this.host || this.#ctx.collabGuest) return;
			const access = this.autoStartMode;
			if (access !== "off") await this.#launchReporting(access, stopEpoch);
		});
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
		if (this.#shutdown) throw new CollabHostStoppedError("collab controller shut down");
		if (this.#ctx.collabGuest) throw new CollabHostStoppedError("collab guest owns the session");
		const existing = this.host;
		if (existing && (existing.access === "control" || options.access === "view")) return existing;
		const stopEpoch = this.#stopEpoch;
		// Abort an in-flight or stale room before queuing behind its startup.
		const stopping =
			this.#host && this.#stopHost(this.#host, existing ? "restarting with control access" : SESSION_SWITCH_REASON);
		const started = this.#ops.then(async () => {
			await stopping;
			if (this.#shutdown) throw new CollabHostStoppedError("collab controller shut down");
			if (stopEpoch !== this.#stopEpoch) throw new CollabHostStoppedError("collab controller stopped");
			// A preceding manual start or rotation may have installed a room while
			// this request waited. Reuse or upgrade it rather than racing its launch.
			const current = this.host;
			if (current && (current.access === "control" || options.access === "view")) return current;
			if (current) await this.#stopHost(current, "restarting with control access");
			return this.#launch(options.access, stopEpoch, options.relay);
		});
		// Report manual failures to the caller without poisoning later rotations.
		this.#ops = started.then(
			() => {},
			() => {},
		);
		return started;
	}

	/** Cancel pending launches and stop the current room, including a stop already in flight. */
	async stop(reason: string): Promise<void> {
		this.#stopEpoch++;
		if (this.#host) await this.#stopHost(this.#host, reason);
	}

	async #stopHost(host: CollabHost, reason: string): Promise<void> {
		try {
			await host.stop(reason);
		} finally {
			// A completed teardown may reject on its final UI update. Do not
			// make every later operation await that same cached rejection.
			if (host.stopped && this.#host === host) this.#host = undefined;
		}
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
	async #launch(access: CollabAccess, stopEpoch: number, relay?: string): Promise<CollabHost> {
		if (this.#shutdown) throw new CollabHostStoppedError("collab controller shut down");
		if (stopEpoch !== this.#stopEpoch) throw new CollabHostStoppedError("collab controller stopped");
		// Identity cleanup callbacks can precede awaited hooks and message replacement.
		// Pin and expose only the session left after commit or rollback.
		if (this.#ctx.session.isSessionTransitioning) {
			const shutdown = (this.#shutdownWake ??= Promise.withResolvers<void>()).promise;
			await Promise.race([this.#ctx.session.waitForSessionTransition(), shutdown]);
		}
		// Manual upgrades may reach this after awaiting the old room's stop.
		// Shutdown or an explicit stop may have overtaken either wait.
		if (this.#shutdown) throw new CollabHostStoppedError("collab controller shut down");
		if (stopEpoch !== this.#stopEpoch) throw new CollabHostStoppedError("collab controller stopped");
		if (this.#ctx.collabGuest) throw new CollabHostStoppedError("collab guest owns the session");
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
			if (previous) await this.#stopHost(previous, "replaced");
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
	async #launchReporting(access: CollabAccess, stopEpoch: number): Promise<void> {
		try {
			await this.#launch(access, stopEpoch);
		} catch (err) {
			this.#reportFailure(err);
		}
	}

	#reportFailure(err: unknown): void {
		if (this.#shutdown || err instanceof CollabHostStoppedError) return;
		logger.warn("Collab auto-start failed", { error: String(err) });
		const message = sanitizeDisplayLine(err instanceof Error ? err.message : String(err));
		this.#ctx.showStatus(truncateToWidth(`Collab auto-start failed: ${message}`, TRUNCATE_LENGTHS.LINE), {
			dim: true,
		});
	}

	/**
	 * The session this process drives changed identity (new, resume, fork,
	 * branch). The old room is already inert — the host refuses frames and
	 * queries for a session it never shared — so stop it, then apply the
	 * auto-start policy to the new session.
	 */
	#onSessionChanged(): void {
		const previous = this.#host;
		if (this.host) return;
		const stopEpoch = this.#stopEpoch;
		// Stop synchronously so a room still connecting is aborted now rather than
		// after the queued start settles; the chain then waits for that stop.
		const stopping = previous && this.#stopHost(previous, SESSION_SWITCH_REASON);
		this.#ops = this.#ops
			.then(async () => {
				await stopping;
				if (this.#shutdown || stopEpoch !== this.#stopEpoch || this.host || this.#ctx.collabGuest) return;
				const access = this.autoStartMode;
				if (access !== "off") await this.#launchReporting(access, stopEpoch);
			})
			.catch(err => this.#reportFailure(err));
	}
}

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
import { randomUUID } from "node:crypto";
import { logger } from "@oh-my-pi/pi-utils";
import type { InteractiveModeContext } from "../modes/types";
import { CollabHost } from "./host";
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
	#unsubscribeSessionChange: () => void;
	#shutdown = false;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
		this.instanceId = randomUUID();
		this.#unsubscribeSessionChange = ctx.session.registerSessionChangeCallback(() => this.#onSessionChanged());
	}

	/** The live room, if any (a room that ended on its own is reported as absent). */
	get host(): CollabHost | undefined {
		const host = this.#host;
		return host && !host.stopped ? host : undefined;
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
	 */
	autoStart(): void {
		const access = this.autoStartMode;
		if (access === "off" || this.#shutdown || this.host) return;
		const started = this.#launchReporting(access);
		this.#ops = this.#ops.then(() => started);
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

	async stop(reason: string): Promise<void> {
		await this.host?.stop(reason);
	}

	/** Stop hosting for good; no further rooms are started for this process. */
	async shutdown(reason: string): Promise<void> {
		this.#shutdown = true;
		this.#unsubscribeSessionChange();
		await this.#ops;
		await this.stop(reason);
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
	 * Construct the next-generation room synchronously — the body up to the
	 * first await runs before this returns, so `ctx.collabHost` is installed
	 * by the time the caller continues — then connect it.
	 */
	async #launch(access: CollabAccess, relay?: string): Promise<CollabHost> {
		const relayUrl = this.#resolveRelayUrl(relay);
		const webUrl = this.#ctx.settings.get("collab.webUrl") || "";
		const host = new CollabHost(this.#ctx, { instanceId: this.instanceId, generation: ++this.#generation, access });
		this.#host = host;
		this.#ctx.collabHost = host;
		try {
			await host.start(relayUrl, webUrl);
		} catch (err) {
			if (this.#host === host) this.#host = undefined;
			if (this.#ctx.collabHost === host) this.#ctx.collabHost = undefined;
			throw err;
		}
		return host;
	}

	/** Background start: a failure is logged and shown, never thrown. */
	async #launchReporting(access: CollabAccess): Promise<void> {
		try {
			await this.#launch(access);
		} catch (err) {
			if (this.#shutdown) return;
			logger.warn("Collab auto-start failed", { error: String(err) });
			const message = err instanceof Error ? err.message : String(err);
			this.#ctx.showStatus(`Collab auto-start failed: ${message}`, { dim: true });
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
		this.#ops = this.#ops.then(async () => {
			if (previous) await previous.stop("session switched");
			if (this.#shutdown || this.host) return;
			const access = this.autoStartMode;
			if (access !== "off") await this.#launchReporting(access);
		});
	}
}

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
import { sanitizeDisplayLine } from "../modes/components/extensions/display-text";
import type { InteractiveModeContext } from "../modes/types";
import { TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
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
	/** Installed when the first room starts; a process that never hosts never subscribes. */
	#unsubscribeSessionChange: (() => void) | undefined;
	#shutdown = false;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
		this.instanceId = randomUUID();
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

	/** Resolves once no stop/start sequence is in flight. */
	idle(): Promise<void> {
		return this.#ops;
	}

	/** Stop hosting for good; no further rooms are started for this process. */
	async shutdown(reason: string): Promise<void> {
		this.#shutdown = true;
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
	 * Construct the next-generation room synchronously — the body up to the
	 * first await runs before this returns, so `ctx.collabHost` is installed
	 * by the time the caller continues — then connect it once the previous
	 * room is fully gone.
	 */
	async #launch(access: CollabAccess, relay?: string): Promise<CollabHost> {
		const relayUrl = this.#resolveRelayUrl(relay);
		const webUrl = this.#ctx.settings.get("collab.webUrl") || "";
		this.#unsubscribeSessionChange ??= this.#ctx.session.registerSessionChangeCallback(() =>
			this.#onSessionChanged(),
		);
		const previous = this.#host;
		const host = new CollabHost(this.#ctx, { instanceId: this.instanceId, generation: ++this.#generation, access });
		this.#host = host;
		this.#ctx.collabHost = host;
		try {
			// Both rooms publish under this process's instance id. A previous room
			// that ended on its own (fatal relay close) may still be withdrawing
			// its publication; wait for that before this room binds the endpoint.
			await previous?.stop("replaced");
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
			const message = truncateToWidth(
				sanitizeDisplayLine(err instanceof Error ? err.message : String(err)),
				TRUNCATE_LENGTHS.LINE,
			);
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

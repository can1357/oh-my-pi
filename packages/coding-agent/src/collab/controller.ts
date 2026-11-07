/**
 * Owns one local agent endpoint for every ordinary interactive session and,
 * independently, opt-in relay hosting. Session and room changes revoke the
 * previous publication before exposing a new monotonically increasing
 * generation. Stopping a relay room does not disable local agent messaging.
 */
import { randomBytes } from "node:crypto";
import { logger } from "@oh-my-pi/pi-utils";
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import type { InteractiveModeContext } from "../modes/types";
import { TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { CollabHost, CollabHostStoppedError, CollabRelayUnavailableError } from "./host";
import {
	COLLAB_AGENT_MESSAGE_TYPE,
	type CollabAccess,
	type CollabHostPublication,
	type CollabHostRegistrySource,
	type CollabHostSnapshot,
	CollabSendError,
	publishCollabHost,
} from "./registry";

import { cfgCollabAutoStart, cfgCollabRelayUrl, cfgCollabWebUrl } from "./settings";

export type CollabAutoStart = "off" | CollabAccess;

const SESSION_SWITCH_REASON =
	"session switched; prompts not shown in the conversation were not submitted. Rejoin and resend them";
/**
 * First relaunch after a room ends on its own, or after the relay was unavailable
 * for a policy launch, is immediate; repeats back off from this delay.
 */
const RELAUNCH_BACKOFF_BASE_MS = 1_000;
const RELAUNCH_BACKOFF_MAX_MS = 60_000;
/** A relaunch cause this long after the previous one counts as healthy and resets the backoff. */
const RELAUNCH_BACKOFF_RESET_MS = 5 * 60_000;

export interface CollabStartOptions {
	/** Highest access the registry may hand out for the new room. */
	access: CollabAccess;
	/** Relay override (`host[:port]` or a full URL); defaults to `collab.relayUrl`. */
	relay?: string;
}

interface LocalPublicationIdentity {
	generation: number;
	sessionId: string;
	transitionEpoch: number;
	startedAt: number;
	revoked: PromiseWithResolvers<void>;
}

export class CollabController {
	readonly instanceId: string;
	#ctx: InteractiveModeContext;
	#generation = 0;
	#host: CollabHost | undefined;
	/** A retained room outlives local transcript capabilities; only stopping it cancels startup. */
	#hostStartRevocation: PromiseWithResolvers<void> | undefined;
	#localIdentity: LocalPublicationIdentity | undefined;
	#localPublication: CollabHostPublication | undefined;
	/** Serializes publication/withdrawal, including publications overtaken while awaiting IPC setup. */
	#localOps: Promise<void> = Promise.resolve();
	/** Cleanup can finish without proving the outcome of a previously authorized delivery. */
	#localRevocationFailure: CollabSendError | undefined;
	/** Serializes stop/start sequences so a rotation never interleaves with another. */
	#ops: Promise<void> = Promise.resolve();
	/** Explicit stop invalidates launch requests, not the saved auto-start policy. */
	#stopEpoch = 0;
	/** Observes ordinary local sessions even when relay auto-start is disabled. */
	#unsubscribeSessionChange: (() => void) | undefined;
	#unsubscribeSessionMove: (() => void) | undefined;
	#unsubscribeSessionTransition: (() => void) | undefined;
	/** Preserve a stop made during a transition, including before its identity callback. */
	#transitionStopEpoch: number | undefined;
	/** Guests may drive the session only once interactive startup has finished. */
	#startupComplete = false;
	#shutdown = false;
	#shutdownWake: PromiseWithResolvers<void> | undefined;
	/**
	 * Consecutive relaunch causes — rooms that ended on their own, policy launches
	 * the relay never opened — within {@link RELAUNCH_BACKOFF_RESET_MS} of each other.
	 */
	#relaunchStreak = 0;
	#lastRelaunchCauseAt: number | undefined;
	#relaunchTimer: Timer | undefined;

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

	/** Most recent local/room generation; never reused after publication. */
	get generation(): number {
		return this.#generation;
	}

	get autoStartMode(): CollabAutoStart {
		return cfgCollabAutoStart.get(this.#ctx.settings);
	}

	/**
	 * Apply `collab.autoStart` for the current session. The room object is
	 * installed synchronously so dialogs raised before the relay connects are
	 * retained for the first writer; the connection itself proceeds in the
	 * background and a failure is reported without disturbing the session. A
	 * relay that is unavailable is retried on the relaunch backoff, so hosting
	 * starts once it answers.
	 * Until {@link startupComplete} is called, guests can join and answer
	 * dialogs but cannot prompt, interrupt, or command agents.
	 */
	autoStart(): void {
		// Observe session changes from now on even when auto-start is currently
		// off: the setting is read live, so enabling it later applies to the
		// next `/new`, `/resume`, or branch without restarting omp.
		this.#observeSessionChanges();
		const access = this.autoStartMode;
		if (access === "off" || this.#shutdown || this.host || this.#ctx.collabGuest) {
			this.#ensureLocal();
			return;
		}
		const started = this.#launchReporting(access, this.#stopEpoch);
		this.#ops = this.#ops.then(() => started);
	}

	/** Admit hosting only for a restored local identity, preserving later stop/shutdown intent. */
	resumeAfterGuest(restoration: Promise<boolean>): void {
		if (this.#shutdown) return;
		this.#observeSessionChanges();
		this.#withdrawLocal();
		const stopEpoch = this.#stopEpoch;
		const shutdown = (this.#shutdownWake ??= Promise.withResolvers<void>()).promise;
		// The guest reports restoration failures to its caller/UI. Observe them
		// here only to prevent hosting; shutdown must not await a stalled hook.
		const restored = Promise.race([restoration.catch(() => false), shutdown]);
		this.#ops = this.#ops.then(async () => {
			const didRestoreReplica = await restored;
			if (this.#shutdown || this.#ctx.collabGuest) return;
			await this.#waitForSessionTransition();
			const access = this.autoStartMode;
			if (didRestoreReplica === true && stopEpoch === this.#stopEpoch && !this.host && access !== "off") {
				await this.#launchReporting(access, stopEpoch);
			} else {
				this.#ensureLocal();
			}
		});
	}

	/**
	 * Interactive startup (extension hooks, mode reconciliation) has finished:
	 * from now on guests in any room of this process may drive the session.
	 */
	startupComplete(): void {
		if (this.#shutdown) return;
		this.#startupComplete = true;
		this.#observeSessionChanges();
		this.#ensureLocal();
	}

	#observeSessionChanges(): void {
		this.#unsubscribeSessionChange ??= this.#ctx.session.registerSessionChangeCallback(() =>
			this.#onSessionChanged(),
		);
		if (!this.#unsubscribeSessionTransition) {
			this.#transitionStopEpoch = this.#ctx.session.isSessionTransitioning ? this.#stopEpoch : undefined;
			this.#unsubscribeSessionTransition = this.#ctx.session.registerSessionTransitionCallback(() => {
				if (this.#ctx.session.isSessionTransitioning) {
					this.#transitionStopEpoch ??= this.#stopEpoch;
					this.#withdrawLocal();
				} else {
					this.#transitionStopEpoch = undefined;
					// Transcript settlement only republishes local capabilities. Remote room policy
					// remains tied to committed identity callbacks, not failed or same-ID transitions.
					this.#ops = this.#ops.then(() => this.#ensureLocal()).catch(err => this.#reportFailure(err));
				}
			});
		}
		// A write that finds the session file open in another omp process (or
		// replaced/contested on disk) moves the session to a sibling file under a
		// new id without an AgentSession transition; rotate the room for it too.
		// Moves replayed at subscription predate every room this controller hosts.
		if (this.#unsubscribeSessionMove) return;
		let live = false;
		this.#unsubscribeSessionMove = this.#ctx.sessionManager.onPersistenceNotice(() => {
			if (live) this.#onSessionChanged();
		});
		live = true;
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
		if (this.#host) this.#withdrawLocal();
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
			if (current) {
				this.#withdrawLocal();
				await this.#stopHost(current, "restarting with control access");
			}
			return this.#launch(options.access, stopEpoch, options.relay);
		});
		// Report manual failures to the caller without poisoning later rotations.
		this.#ops = started.then(
			() => {},
			() => this.#ensureLocal(),
		);
		return started;
	}

	/** Cancel pending launches and stop the current room, including a stop already in flight. */
	async stop(reason: string): Promise<void> {
		this.#stopEpoch++;
		const host = this.#host;
		if (host) {
			const stopping = this.#stopHost(host, reason);
			this.#rotateLocal();
			await stopping;
		}
		await this.#localOps;
		if (this.#localRevocationFailure) throw this.#localRevocationFailure;
	}

	async #stopHost(host: CollabHost, reason: string): Promise<void> {
		if (this.#host === host) this.#hostStartRevocation?.resolve();
		try {
			await host.stop(reason);
		} finally {
			// A completed teardown may reject on its final UI update. Do not
			// make every later operation await that same cached rejection.
			if (host.stopped && this.#host === host) this.#host = undefined;
		}
	}

	/** Drain stop/start and publication cleanup, then report any retained delivery uncertainty. */
	async idle(): Promise<void> {
		await this.#ops;
		await this.#localOps;
		if (this.#localRevocationFailure) throw this.#localRevocationFailure;
	}

	/** Stop hosting for good; no further rooms are started for this process. */
	async shutdown(reason: string): Promise<void> {
		this.#shutdown = true;
		this.#withdrawLocal();
		this.#shutdownWake?.resolve();
		clearTimeout(this.#relaunchTimer);
		this.#relaunchTimer = undefined;
		this.#unsubscribeSessionChange?.();
		this.#unsubscribeSessionChange = undefined;
		this.#unsubscribeSessionMove?.();
		this.#unsubscribeSessionMove = undefined;
		this.#unsubscribeSessionTransition?.();
		this.#unsubscribeSessionTransition = undefined;
		// Stop before draining the chain: a room still connecting is aborted at
		// once instead of holding shutdown for the relay connect timeout.
		try {
			await this.stop(reason);
		} finally {
			// A failed acknowledgement must not skip queued publication or room cleanup.
			await this.idle();
		}
	}

	async #waitForSessionTransition(revoked?: Promise<void>): Promise<void> {
		if (!this.#ctx.session.isSessionTransitioning) return;
		const shutdown = (this.#shutdownWake ??= Promise.withResolvers<void>()).promise;
		const transition = this.#ctx.session.waitForSessionTransition();
		await Promise.race(revoked ? [transition, shutdown, revoked] : [transition, shutdown]);
	}

	#isLocalIdentityCurrent(identity: LocalPublicationIdentity): boolean {
		return (
			this.#localIdentity === identity &&
			!this.#shutdown &&
			!this.#ctx.collabGuest &&
			!this.#ctx.session.isSessionTransitioning &&
			identity.transitionEpoch === this.#ctx.session.sessionTransitionEpoch &&
			identity.sessionId === this.#ctx.sessionManager.getSessionId()
		);
	}

	#assertLocalIdentity(identity: LocalPublicationIdentity): void {
		if (!this.#isLocalIdentityCurrent(identity)) throw new Error("local collab session unavailable");
	}

	#remoteHost(identity: LocalPublicationIdentity): CollabHost | undefined {
		const host = this.host;
		// Same-session transitions revoke local capabilities without replacing the remote room.
		return host && host.sessionId === identity.sessionId && host.startedAt > 0 ? host : undefined;
	}

	#localSnapshot(identity: LocalPublicationIdentity): CollabHostSnapshot {
		this.#assertLocalIdentity(identity);
		const host = this.#remoteHost(identity);
		// Preserve early remote dialog discovery, but local agent admission is
		// unavailable until the ordinary interactive startup has fully settled.
		if (!this.#startupComplete && !host) throw new Error("interactive startup in progress");
		const model = this.#ctx.session.model;
		return {
			instanceId: this.instanceId,
			generation: identity.generation,
			pid: process.pid,
			sessionId: identity.sessionId,
			sessionName: this.#ctx.session.sessionName ?? null,
			cwd: this.#ctx.sessionManager.getCwd(),
			model: model ? { provider: model.provider, id: model.id } : null,
			startedAt: host?.startedAt ?? identity.startedAt,
			participants: host?.participants.length ?? 1,
			relayConnected: host?.relayConnected ?? false,
			inputRequired: host?.inputRequired ?? false,
			busy: this.#ctx.session.isStreaming,
			access: host?.access ?? "local",
		};
	}

	#localSource(identity: LocalPublicationIdentity): CollabHostRegistrySource {
		return {
			snapshot: () => this.#localSnapshot(identity),
			link: access => {
				this.#assertLocalIdentity(identity);
				const host = this.#remoteHost(identity);
				if (!host || (access === "control" && host.access !== "control")) return null;
				return access === "view" ? host.webViewLink : host.webLink;
			},
			admitAgentMessage: (text, details) => {
				this.#assertLocalIdentity(identity);
				if (!this.#startupComplete) throw new Error("interactive startup in progress");
				this.#ctx.session.admitAgentMessage(
					{ customType: COLLAB_AGENT_MESSAGE_TYPE, content: text, display: true, details },
					identity.sessionId,
					identity.transitionEpoch,
				);
			},
		};
	}

	#ensureLocal(): void {
		if (this.#localIdentity && this.#isLocalIdentityCurrent(this.#localIdentity)) return;
		if (this.#shutdown || this.#ctx.collabGuest || this.#ctx.session.isSessionTransitioning) return;
		this.#rotateLocal();
	}

	#withdrawLocal(): void {
		// Invalidate before any await: outstanding authenticated deliveries cannot
		// cross session/room changes, including a publication still being created.
		this.#localIdentity?.revoked.resolve();
		this.#localIdentity = undefined;
		const publication = this.#localPublication;
		this.#localPublication = undefined;
		const closing = publication?.close().catch(err => this.#reportLocalFailure(err));
		this.#localOps = this.#localOps.then(() => closing).catch(err => this.#reportLocalFailure(err));
	}

	#rotateLocal(): void {
		this.#withdrawLocal();
		if (this.#shutdown || this.#ctx.collabGuest || this.#ctx.session.isSessionTransitioning) return;
		const identity: LocalPublicationIdentity = {
			generation: ++this.#generation,
			sessionId: this.#ctx.sessionManager.getSessionId(),
			transitionEpoch: this.#ctx.session.sessionTransitionEpoch,
			startedAt: Date.now(),
			revoked: Promise.withResolvers<void>(),
		};
		this.#localIdentity = identity;
		this.#localOps = this.#localOps
			.then(async () => {
				if (this.#ctx.session.isSessionTransitioning)
					await this.#waitForSessionTransition(identity.revoked.promise);
				if (!this.#isLocalIdentityCurrent(identity)) return;
				const publication = await publishCollabHost(this.#localSource(identity), { instanceId: this.instanceId });
				if (this.#ctx.session.isSessionTransitioning)
					await this.#waitForSessionTransition(identity.revoked.promise);
				if (!this.#isLocalIdentityCurrent(identity)) {
					await publication.close();
					return;
				}
				this.#localPublication = publication;
			})
			.catch(err => this.#reportLocalFailure(err));
	}

	#reportLocalFailure(err: unknown): void {
		if (err instanceof CollabSendError && err.code === "revocation_incomplete") {
			// Keep the serial cleanup chain usable, but never turn incomplete revocation
			// into a successful public drain, even after another generation is published.
			this.#localRevocationFailure ??= err;
			const message = "Local collab endpoint revoked; previously authorized message delivery outcome is uncertain";
			logger.warn(message, { error: String(err) });
			if (!this.#shutdown) this.#ctx.showStatus(message, { dim: true });
			return;
		}
		logger.warn("Collab local registry unavailable", { error: String(err) });
		if (!this.#shutdown) {
			this.#ctx.showStatus("Local collab discovery unavailable (omp collab list/send cannot reach this session)", {
				dim: true,
			});
		}
	}

	#resolveRelayUrl(relay?: string): string {
		const input = relay?.trim() || cfgCollabRelayUrl.get(this.#ctx.settings) || "";
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
		if (this.#ctx.session.isSessionTransitioning) await this.#waitForSessionTransition();
		// Manual upgrades may reach this after awaiting the old room's stop.
		// Shutdown or an explicit stop may have overtaken either wait.
		if (this.#shutdown) throw new CollabHostStoppedError("collab controller shut down");
		if (stopEpoch !== this.#stopEpoch) throw new CollabHostStoppedError("collab controller stopped");
		if (this.#ctx.collabGuest) throw new CollabHostStoppedError("collab guest owns the session");
		const relayUrl = this.#resolveRelayUrl(relay);
		const webUrl = cfgCollabWebUrl.get(this.#ctx.settings) || "";
		this.#observeSessionChanges();
		const previous = this.#host;
		this.#rotateLocal();
		this.#hostStartRevocation?.resolve();
		const startupRevocation = Promise.withResolvers<void>();
		this.#hostStartRevocation = startupRevocation;
		const host: CollabHost = new CollabHost(this.#ctx, {
			instanceId: this.instanceId,
			generation: this.#generation,
			access,
			registryOwner: "controller",
			guestActionsReady: () => this.#startupComplete && !this.#ctx.session.isSessionTransitioning,
			onEnded: () => this.#onHostEnded(host),
		});
		this.#host = host;
		this.#ctx.collabHost = host;
		try {
			// A previous room may still be withdrawing subscriptions and registry
			// state after a fatal close. Finish that before installing new taps.
			if (previous) await this.#stopHost(previous, "replaced");
			await host.start(relayUrl, webUrl);
			await this.#localOps;
			// A provisional switch can roll back without an identity callback.
			// Keep the room suspended until the final identity is known.
			if (this.#ctx.session.isSessionTransitioning) await this.#waitForSessionTransition(startupRevocation.promise);
			if (
				host.ending ||
				this.#shutdown ||
				stopEpoch !== this.#stopEpoch ||
				host.sessionId !== this.#ctx.sessionManager.getSessionId()
			) {
				throw new CollabHostStoppedError("collab host replaced during startup");
			}
		} catch (err) {
			// A provisional session switch may overtake start() without its commit
			// callback having run. Never abandon a connected room and its taps.
			await this.#stopHost(host, "collab startup did not settle").catch(stopError => {
				logger.warn("Collab failed startup teardown failed", { error: String(stopError) });
			});
			if (this.#host === host) this.#host = undefined;
			if (this.#ctx.collabHost === host) this.#ctx.collabHost = undefined;
			throw err;
		} finally {
			if (this.#hostStartRevocation === startupRevocation) this.#hostStartRevocation = undefined;
		}
		return host;
	}

	/**
	 * Background start: a failure is logged and shown, never thrown. A room
	 * that this controller (or `/collab stop`) deliberately stopped while it
	 * was still connecting — session switch, access upgrade, shutdown — is not
	 * a failure; its replacement, if any, is already on its way. A relay that
	 * never opened the room (unreachable, connect timeout) is retried on the
	 * relaunch backoff; any other failure waits for the next session change or
	 * `/collab`.
	 */
	async #launchReporting(access: CollabAccess, stopEpoch: number): Promise<void> {
		try {
			await this.#launch(access, stopEpoch);
		} catch (err) {
			this.#ensureLocal();
			this.#reportFailure(err);
			if (!this.#shutdown && err instanceof CollabRelayUnavailableError) this.#scheduleRelaunch(stopEpoch);
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
	 * branch, or a move to a sibling file). The old room is already inert —
	 * the host refuses frames and queries for a session it never shared — so
	 * stop it, then apply the auto-start policy to the new session.
	 */
	#onSessionChanged(): void {
		const previous = this.#host;
		if (this.#localIdentity && this.#isLocalIdentityCurrent(this.#localIdentity)) return;
		this.#withdrawLocal();
		// Stop synchronously so a room still connecting is aborted now rather than
		// after the queued start settles; the chain then waits for that stop.
		this.#reapplyAutoStart(
			previous && this.#stopHost(previous, SESSION_SWITCH_REASON),
			this.#transitionStopEpoch ?? this.#stopEpoch,
		);
	}

	/**
	 * The relay ended the current room without `stop()` (fatal close, e.g. send
	 * backlog). The policy still applies to this session, so host a successor;
	 * `#launch` waits for the ended room to finish withdrawing first.
	 */
	#onHostEnded(host: CollabHost): void {
		if (host !== this.#host) return;
		this.#hostStartRevocation?.resolve();
		this.#rotateLocal();
		this.#scheduleRelaunch(this.#stopEpoch);
	}

	/**
	 * Re-apply the policy after a room ended on its own or the relay never opened
	 * a policy launch. Causes that keep repeating back off exponentially so a
	 * persistently failing relay cannot spin; `/collab`, a session change,
	 * `/collab stop`, or shutdown during the wait take precedence over the
	 * delayed relaunch.
	 */
	#scheduleRelaunch(stopEpoch: number): void {
		const now = Date.now();
		const repeated =
			this.#lastRelaunchCauseAt !== undefined && now - this.#lastRelaunchCauseAt < RELAUNCH_BACKOFF_RESET_MS;
		this.#relaunchStreak = repeated ? this.#relaunchStreak + 1 : 0;
		this.#lastRelaunchCauseAt = now;
		if (this.#relaunchStreak === 0) {
			this.#reapplyAutoStart(undefined, stopEpoch);
			return;
		}
		const delay = Math.min(RELAUNCH_BACKOFF_BASE_MS * 2 ** (this.#relaunchStreak - 1), RELAUNCH_BACKOFF_MAX_MS);
		clearTimeout(this.#relaunchTimer);
		this.#relaunchTimer = setTimeout(() => {
			this.#relaunchTimer = undefined;
			this.#reapplyAutoStart(undefined, stopEpoch);
		}, delay);
	}

	/**
	 * Queue a policy launch for the current session once `stopping` settles,
	 * unless shutdown, a stop after `stopEpoch` was taken, a live room, or a
	 * guest intervened.
	 */
	#reapplyAutoStart(stopping: Promise<void> | undefined, stopEpoch = this.#stopEpoch): void {
		this.#ops = this.#ops
			.then(async () => {
				await stopping?.catch(err => this.#reportFailure(err));
				await this.#waitForSessionTransition();
				if (this.#shutdown || this.#ctx.collabGuest) return;
				const access = this.autoStartMode;
				if (stopEpoch !== this.#stopEpoch || this.host || access === "off") this.#ensureLocal();
				else await this.#launchReporting(access, stopEpoch);
			})
			.catch(err => this.#reportFailure(err));
	}
}

/**
 * Programmatic collab hosting: start, read, and stop the room a session
 * shares, without routing through the /collab slash command.
 *
 * The slash command and the extension API both funnel through
 * {@link startCollabHosting} so relay resolution, the guest-session refusal,
 * and the one-room-per-session rule live in exactly one place. What the
 * command adds on top is presentation (printing the link and its QR code);
 * programmatic callers get the links returned and own keeping them out of
 * logs and transcripts, because a link is a credential: the full link steers
 * the session, the view link reads it.
 */
import type { CollabHostLinks, StartCollabOptions } from "../extensibility/extensions/types";
import type { InteractiveModeContext } from "../modes/types";
import { hasInFlightCollabGuestTransition } from "./guest";
import { COLLAB_STOPPED_ERROR, CollabHost } from "./host";
import { normalizeRelayOrigin } from "./protocol";

interface InFlightStart {
	readonly host: CollabHost;
	readonly relayOrigin: string;
	readonly sessionId: string;
	cancelled: boolean;
	promise: Promise<CollabHost>;
}

/**
 * A start whose room finished binding to a session that is no longer live.
 * Module-private: every caller awaiting that start catches it and loops, so
 * it never escapes to an extension.
 */
class CollabStartSuperseded extends Error {}

const inFlightStarts = new WeakMap<InteractiveModeContext, InFlightStart>();

export function hasInFlightCollabHosting(ctx: InteractiveModeContext): boolean {
	return inFlightStarts.has(ctx);
}

/** The links of a hosted room, in both strengths and both renderings. */
export function collabHostLinks(host: CollabHost): CollabHostLinks {
	return {
		link: host.link,
		viewLink: host.viewLink,
		webLink: host.webLink,
		webViewLink: host.webViewLink,
	};
}

/**
 * Links of the room hosted for the session that is live *now*, or undefined.
 *
 * A session switch replaces the session id before the outgoing room stops, so
 * `ctx.collabHost` briefly points at a room bound to the previous transcript.
 * Handing those links out would publish a credential for the wrong session
 * that dies on the host's next broadcast. Reading links never mutates hosting
 * state. A caller that wants a room for the new session calls
 * {@link startCollabHosting}, which restarts it.
 */
export function activeCollabHostLinks(ctx: InteractiveModeContext): CollabHostLinks | undefined {
	const host = ctx.collabHost;
	if (!host) return undefined;
	if (host.sessionId && host.sessionId !== ctx.sessionManager.getSessionId()) return undefined;
	return collabHostLinks(host);
}

const rolledBackHostReapers = new WeakSet<InteractiveModeContext>();

/**
 * Stop a room whose session did not survive the transition that created it.
 *
 * A `session_switch` handler runs after the id commits but while the switch can
 * still throw, and the restore happens *without* a change notification,
 * deliberately: the success-path notification never fired either. Settlement is
 * therefore the only signal that the outcome is final. Without this the
 * orphaned room lingers until its next broadcast notices, holding a credential
 * the extension was already handed.
 *
 * Two distinct ways a room can be orphaned, and the id check only sees one:
 * a switch to a different session that rolls back, and a same-file reload whose
 * rollback replaces the transcript under an unchanged id. A guest that joined
 * before the failure holds the discarded snapshot and would otherwise keep
 * receiving incremental frames from the restored history.
 *
 * Registered once per context: the callback re-reads `ctx.collabHost`, so it
 * covers every host that context ever publishes.
 */
function ensureRolledBackHostReaper(ctx: InteractiveModeContext): void {
	if (rolledBackHostReapers.has(ctx)) return;
	rolledBackHostReapers.add(ctx);
	ctx.session.registerSessionTransitionSettledCallback(outcome => {
		const host = ctx.collabHost;
		if (!host?.sessionId) return;
		if (!outcome.rolledBack && host.sessionId === ctx.sessionManager.getSessionId()) return;
		void host.stop("session switch rolled back");
	});
}

/**
 * Cancel a reservation and stop its half-started host. Ownership is released
 * with a compare-and-delete: a caller that lost the slot to someone else must
 * not evict that owner's reservation.
 */
async function cancelInFlightStart(ctx: InteractiveModeContext, pending: InFlightStart, reason: string): Promise<void> {
	pending.cancelled = true;
	if (inFlightStarts.get(ctx) === pending) inFlightStarts.delete(ctx);
	await pending.host.stop(reason);
	try {
		await pending.promise;
	} catch {
		// A cancelled start rejects by design.
	}
}

/**
 * Start hosting this session's collab room, or return the room already
 * hosted on the requested relay.
 *
 * Throws when the session joined someone else's room as a guest, when no
 * relay is configured and none is passed, or when a room is already hosted
 * on a different relay: a session has one transcript tap and one status
 * segment, so hosting two rooms at once is not a state CollabHost can
 * represent, and silently moving relays would strand the room's current
 * guests. The caller that truly wants a new relay stops first.
 */
export async function startCollabHosting(
	ctx: InteractiveModeContext,
	options: StartCollabOptions = {},
): Promise<CollabHost> {
	if (ctx.collabGuest) {
		throw new Error("Already in a collab session as a guest (/leave first)");
	}
	if (hasInFlightCollabGuestTransition(ctx)) {
		throw new Error("A collab guest session is still settling (retry once it has finished)");
	}
	if (ctx.session.isSessionTransitionInFlight) {
		throw new Error("A session switch is still settling (retry once the new session has started)");
	}
	const relayInput = options.relayUrl?.trim() || ctx.settings.get("collab.relayUrl") || "";
	if (!relayInput) {
		throw new Error("No relay configured. Set collab.relayUrl in /settings or pass a relayUrl option");
	}
	// Scheme-less relay args default to wss (ws:// must be spelled out for localhost).
	const relayUrl = relayInput.includes("://") ? relayInput : `wss://${relayInput}`;
	const normalized = normalizeRelayOrigin(relayUrl);
	if ("error" in normalized) throw new Error(normalized.error);
	// Both cleanup branches below release ownership before they await, so state
	// is re-read from the top afterwards: a concurrent caller may have claimed
	// the slot meanwhile, and this caller must join that room instead of
	// starting a second one. Each branch removes exactly the object it
	// observed, so every iteration either returns, throws, or makes progress.
	for (;;) {
		const currentSessionId = ctx.sessionManager.getSessionId();
		const pending = inFlightStarts.get(ctx);
		const stalePending = pending && pending.sessionId && pending.sessionId !== currentSessionId ? pending : undefined;
		if (pending && !stalePending) {
			if (pending.relayOrigin === normalized.origin) {
				try {
					return await pending.promise;
				} catch (err) {
					if (err instanceof CollabStartSuperseded) continue;
					throw err;
				}
			}
			throw new Error(`Already hosting a collab session on relay ${pending.relayOrigin} (stop it first)`);
		}

		const existing = ctx.collabHost;
		const staleExisting =
			existing && existing.sessionId && existing.sessionId !== currentSessionId ? existing : undefined;
		if (existing && !staleExisting) {
			if (existing.relayOrigin === normalized.origin) return existing;
			throw new Error(`Already hosting a collab session on relay ${existing.relayOrigin} (stop it first)`);
		}

		// No await between here and the set() below: the slot is claimed in the
		// same synchronous turn as the checks above, and the set() replaces a
		// superseded reservation rather than clearing it first. Both stale
		// cleanups run inside startPromise while this reservation is held, so
		// stopCollabHosting always finds something to cancel and
		// hasInFlightCollabHosting reports true across the entire transition.
		// Progress guarantee: every iteration either returns, throws, awaits a
		// pending start with matching parameters, or claims a fresh reservation
		// for the current session and stops iterating.
		const host = new CollabHost(ctx);
		const inFlight: InFlightStart = {
			host,
			relayOrigin: normalized.origin,
			sessionId: currentSessionId,
			cancelled: false,
			promise: Promise.resolve(host),
		};

		// Claimed before startPromise runs, so the compare-and-delete inside
		// cancelInFlightStart sees this reservation rather than the superseded
		// one and leaves it in place.
		inFlightStarts.set(ctx, inFlight);

		const startPromise = (async () => {
			try {
				if (stalePending) {
					await cancelInFlightStart(ctx, stalePending, "session switched");
					if (inFlight.cancelled) throw new Error(COLLAB_STOPPED_ERROR);
				}
				if (staleExisting) {
					await staleExisting.stop("session switched");
					if (ctx.collabHost === staleExisting) ctx.collabHost = undefined;
					if (inFlight.cancelled) throw new Error(COLLAB_STOPPED_ERROR);
				}
				await host.start(relayUrl, ctx.settings.get("collab.webUrl") || "");
				// The handshake is the last await before the room goes live, and
				// four things can change across it. Publishing anyway would hand
				// out a link to a room that is already doomed.
				if (inFlight.cancelled) {
					await host.stop("host stopped");
					throw new Error(COLLAB_STOPPED_ERROR);
				}
				if (ctx.collabGuest) {
					// A /join that was connecting in parallel finished first.
					await host.stop("joined as guest");
					throw new Error("Already in a collab session as a guest (/leave first)");
				}
				if (hasInFlightCollabGuestTransition(ctx)) {
					// A guest handshake or rollback is mid-flight, so the live
					// session is that guest's replica: either about to be
					// published to, or about to be rolled back. A room
					// published here would bind to a session that is about to
					// vanish, and its next hello would snapshot whatever
					// session the transition settled on.
					await host.stop("collab guest transition in flight");
					throw new Error("A collab guest session is still settling (retry once it has finished)");
				}
				if (ctx.session.isSessionTransitionInFlight) {
					// A transition that began during the handshake has not
					// committed its id yet, so the mismatch check below cannot
					// see it: `getSessionId()` still reads the outgoing id.
					// Publishing here would bind the room to a session already
					// on its way out. Refuse rather than retry: the loop would
					// re-handshake against the same unsettled transition.
					await host.stop("session switch in flight");
					if (inFlight.cancelled) throw new Error(COLLAB_STOPPED_ERROR);
					throw new Error("A session switch is still settling (retry once the new session has started)");
				}
				// `host.sessionId` is the id the room actually bound to inside
				// start(), and the one #broadcast enforces; a mismatch means the
				// first broadcast would tear this room down. Retrying terminates
				// because the next attempt binds whatever id is current then, and
				// getSessionId() is a stable field read between switches.
				if (host.sessionId && host.sessionId !== ctx.sessionManager.getSessionId()) {
					await host.stop("session switched");
					// A stop that landed while that teardown was awaited outranks
					// the retry. Retrying would claim a fresh reservation after
					// stopCollabHosting had already looked and found nothing, so
					// the new room would go live behind the stop's back.
					if (inFlight.cancelled) throw new Error(COLLAB_STOPPED_ERROR);
					throw new CollabStartSuperseded();
				}
				ctx.collabHost = host;
				ensureRolledBackHostReaper(ctx);
				host.publishStatus();
				return host;
			} catch (err) {
				if (inFlight.cancelled) await host.stop("host stopped");
				throw err;
			} finally {
				if (inFlightStarts.get(ctx) === inFlight) inFlightStarts.delete(ctx);
			}
		})();

		inFlight.promise = startPromise;
		try {
			return await startPromise;
		} catch (err) {
			if (err instanceof CollabStartSuperseded) continue;
			throw err;
		}
	}
}

/**
 * Stop hosting this session's collab room, or cancel an in-flight start.
 *
 * If a room is currently active, it is stopped and disconnected. If a start
 * is in-flight awaiting relay handshake, it is cancelled so it cannot publish
 * an active room after this call completes.
 */
export async function stopCollabHosting(ctx: InteractiveModeContext, reason = "host stopped"): Promise<void> {
	const inFlight = inFlightStarts.get(ctx);
	if (inFlight) await cancelInFlightStart(ctx, inFlight, reason);
	const host = ctx.collabHost;
	if (host) await host.stop(reason);
}

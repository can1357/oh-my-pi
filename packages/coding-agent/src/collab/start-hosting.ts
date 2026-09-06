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
import { CollabHost } from "./host";
import { normalizeRelayOrigin } from "./protocol";

interface InFlightStart {
	readonly host: CollabHost;
	readonly relayOrigin: string;
	readonly sessionId: string;
	cancelled: boolean;
	promise: Promise<CollabHost>;
}

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
	const relayInput = options.relayUrl?.trim() || ctx.settings.get("collab.relayUrl") || "";
	if (!relayInput) {
		throw new Error("No relay configured. Set collab.relayUrl in /settings or pass a relayUrl option");
	}
	// Scheme-less relay args default to wss (ws:// must be spelled out for localhost).
	const relayUrl = relayInput.includes("://") ? relayInput : `wss://${relayInput}`;
	const normalized = normalizeRelayOrigin(relayUrl);
	if ("error" in normalized) throw new Error(normalized.error);
	const currentSessionId = ctx.sessionManager.getSessionId();

	const existing = ctx.collabHost;
	if (existing) {
		if (existing.sessionId && existing.sessionId !== currentSessionId) {
			await existing.stop("session switched");
		} else if (existing.relayOrigin === normalized.origin) {
			return existing;
		} else {
			throw new Error(`Already hosting a collab session on relay ${existing.relayOrigin} (stop it first)`);
		}
	}

	const pending = inFlightStarts.get(ctx);
	if (pending) {
		if (pending.sessionId && pending.sessionId !== currentSessionId) {
			pending.cancelled = true;
			inFlightStarts.delete(ctx);
			await pending.host.stop("session switched");
			try {
				await pending.promise;
			} catch {
				// Ignore previous start failure
			}
		} else if (pending.relayOrigin === normalized.origin) {
			return await pending.promise;
		} else {
			throw new Error(`Already hosting a collab session on relay ${pending.relayOrigin} (stop it first)`);
		}
	}

	const host = new CollabHost(ctx);
	const inFlight: InFlightStart = {
		host,
		relayOrigin: normalized.origin,
		sessionId: currentSessionId,
		cancelled: false,
		promise: Promise.resolve(host),
	};

	const startPromise = (async () => {
		try {
			await host.start(relayUrl, ctx.settings.get("collab.webUrl") || "");
			if (inFlight.cancelled) {
				await host.stop("host stopped");
				throw new Error("Collab hosting was stopped");
			}
			ctx.collabHost = host;
			return host;
		} catch (err) {
			if (inFlight.cancelled) {
				await host.stop("host stopped");
			}
			throw err;
		} finally {
			if (inFlightStarts.get(ctx) === inFlight) {
				inFlightStarts.delete(ctx);
			}
		}
	})();

	inFlight.promise = startPromise;
	inFlightStarts.set(ctx, inFlight);
	return startPromise;
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
	if (inFlight) {
		inFlight.cancelled = true;
		inFlightStarts.delete(ctx);
		await inFlight.host.stop(reason);
		try {
			await inFlight.promise;
		} catch {
			// Expected rejection from cancelled start
		}
	}
	const host = ctx.collabHost;
	if (host) {
		await host.stop(reason);
	}
}

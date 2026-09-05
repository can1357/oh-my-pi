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

const inFlightStarts = new WeakMap<InteractiveModeContext, Promise<CollabHost>>();

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
	const existing = ctx.collabHost;
	if (existing) {
		if (existing.relayOrigin === normalized.origin) return existing;
		throw new Error(`Already hosting a collab session on relay ${existing.relayOrigin} (stop it first)`);
	}
	const pending = inFlightStarts.get(ctx);
	if (pending) {
		const host = await pending;
		if (host.relayOrigin === normalized.origin) return host;
		throw new Error(`Already hosting a collab session on relay ${host.relayOrigin} (stop it first)`);
	}
	const host = new CollabHost(ctx);
	const startPromise = (async () => {
		try {
			await host.start(relayUrl, ctx.settings.get("collab.webUrl") || "");
			ctx.collabHost = host;
			return host;
		} finally {
			inFlightStarts.delete(ctx);
		}
	})();
	inFlightStarts.set(ctx, startPromise);
	return startPromise;
}

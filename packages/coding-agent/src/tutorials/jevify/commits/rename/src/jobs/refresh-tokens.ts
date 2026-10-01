import { sessions } from "../db";
import { logger } from "../log";

const WINDOW_MS = 5 * 60 * 1000;
const EXTEND_MS = 60 * 60 * 1000;

export function refreshTokens(now: number): number {
	let refreshed = 0;
	for (const session of sessions.values()) {
		if (session.expiresAt > now && session.expiresAt - now < WINDOW_MS) {
			session.expiresAt += EXTEND_MS;
			refreshed++;
		}
	}
	logger.debug("tokens refreshed", { refreshed });
	return refreshed;
}

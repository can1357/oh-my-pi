import { sessions, users, type Session } from "../db";
import { log } from "../log";

const SESSION_TTL_MS = 60 * 60 * 1000;

export function login(userId: string, now: number): Session | undefined {
	const user = users.get(userId);
	if (!user?.active) {
		log.warn("login rejected", { userId });
		return undefined;
	}
	const session: Session = { id: `${userId}-${now}`, userId, expiresAt: now + SESSION_TTL_MS };
	sessions.set(session.id, session);
	log.info("login", { userId });
	return session;
}

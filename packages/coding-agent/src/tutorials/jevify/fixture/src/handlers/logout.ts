import { sessions } from "../db";
import { log } from "../log";

export function logout(sessionId: string): void {
	const session = sessions.get(sessionId);
	if (!session) {
		log.debug("logout: no session", { sessionId });
		return;
	}
	sessions.delete(sessionId);
	log.info("logout", { userId: session.userId });
}

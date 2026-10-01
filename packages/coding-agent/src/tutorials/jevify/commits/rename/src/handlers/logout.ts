import { sessions } from "../db";
import { logger } from "../log";

export function logout(sessionId: string): void {
	const session = sessions.get(sessionId);
	if (!session) {
		logger.debug("logout: no session", { sessionId });
		return;
	}
	sessions.delete(sessionId);
	logger.info("logout", { userId: session.userId });
}

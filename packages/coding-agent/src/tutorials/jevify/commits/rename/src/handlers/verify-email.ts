import { users } from "../db";
import { logger } from "../log";

export function verifyEmail(userId: string, token: string, expected: string): boolean {
	const user = users.get(userId);
	if (!user || token !== expected) {
		logger.warn("verifyEmail: rejected", { userId });
		return false;
	}
	user.active = true;
	logger.info("email verified", { userId });
	return true;
}

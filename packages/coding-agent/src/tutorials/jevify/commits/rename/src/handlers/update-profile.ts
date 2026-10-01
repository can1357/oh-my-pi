import { users } from "../db";
import { logger } from "../log";

export function updateEmail(userId: string, email: string): boolean {
	const user = users.get(userId);
	if (!user || !email.includes("@")) {
		logger.warn("updateEmail: rejected", { userId });
		return false;
	}
	user.email = email.toLowerCase();
	user.active = false;
	logger.info("email changed, re-verification required", { userId });
	return true;
}

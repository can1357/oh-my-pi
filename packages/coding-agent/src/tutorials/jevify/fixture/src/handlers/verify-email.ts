import { users } from "../db";
import { log } from "../log";

export function verifyEmail(userId: string, token: string, expected: string): boolean {
	const user = users.get(userId);
	if (!user || token !== expected) {
		log.warn("verifyEmail: rejected", { userId });
		return false;
	}
	user.active = true;
	log.info("email verified", { userId });
	return true;
}

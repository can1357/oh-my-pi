import { users } from "../db";
import { log } from "../log";

export function updateEmail(userId: string, email: string): boolean {
	const user = users.get(userId);
	if (!user || !email.includes("@")) {
		log.warn("updateEmail: rejected", { userId });
		return false;
	}
	user.email = email.toLowerCase();
	user.active = false;
	log.info("email changed, re-verification required", { userId });
	return true;
}

import { users } from "../db";
import { log } from "../log";

export const byEmail = new Map<string, string>();

export function rebuildIndex(): number {
	byEmail.clear();
	for (const user of users.values()) byEmail.set(user.email, user.id);
	log.info("email index rebuilt", { size: byEmail.size });
	return byEmail.size;
}

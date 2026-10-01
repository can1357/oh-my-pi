import { sessions, users } from "../db";
import { log } from "../log";

export function deleteUser(id: string): boolean {
	const existed = users.delete(id);
	for (const [sid, session] of sessions) {
		if (session.userId === id) sessions.delete(sid);
	}
	log.info("user deleted", { id, existed });
	return existed;
}

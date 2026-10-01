import { sessions } from "../db";
import { log } from "../log";

const PAGE_SIZE = 100;

export function purgeSessions(now: number): number {
	const all = [...sessions.values()];
	const pages = Math.ceil(all.length / PAGE_SIZE);
	let purged = 0;
	for (let page = 0; page < pages; page++) {
		for (const session of all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
			if (session.expiresAt <= now) {
				sessions.delete(session.id);
				purged++;
			}
		}
	}
	log.info("sessions purged", { purged });
	return purged;
}

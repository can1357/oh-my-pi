import { orders, sessions, users } from "../db";
import { log } from "../log";

export function health(): { ok: boolean; counts: Record<string, number> } {
	const counts = { orders: orders.size, users: users.size, sessions: sessions.size };
	log.debug("health", counts);
	return { ok: true, counts };
}

import { orders, sessions, users } from "../db";
import { logger } from "../log";

export function health(): { ok: boolean; counts: Record<string, number> } {
	const counts = { orders: orders.size, users: users.size, sessions: sessions.size };
	logger.debug("health", counts);
	return { ok: true, counts };
}

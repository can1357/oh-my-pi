import { orders, users } from "../db";
import { logger } from "../log";

export function pingDb(): boolean {
	const ok = orders instanceof Map && users instanceof Map;
	if (!ok) logger.error("db unavailable");
	else logger.debug("db ok");
	return ok;
}

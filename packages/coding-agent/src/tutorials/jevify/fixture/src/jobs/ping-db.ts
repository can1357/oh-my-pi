import { orders, users } from "../db";
import { log } from "../log";

export function pingDb(): boolean {
	const ok = orders instanceof Map && users instanceof Map;
	if (!ok) log.error("db unavailable");
	else log.debug("db ok");
	return ok;
}

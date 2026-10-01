import { users } from "../db";
import { log } from "../log";

const addresses = new Map<string, string>();

export function updateAddress(userId: string, address: string): boolean {
	if (!users.has(userId)) {
		log.warn("updateAddress: unknown user", { userId });
		return false;
	}
	addresses.set(userId, address.trim());
	log.info("address updated", { userId });
	return true;
}

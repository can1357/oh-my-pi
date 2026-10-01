import { users } from "../db";
import { logger } from "../log";

const addresses = new Map<string, string>();

export function updateAddress(userId: string, address: string): boolean {
	if (!users.has(userId)) {
		logger.warn("updateAddress: unknown user", { userId });
		return false;
	}
	addresses.set(userId, address.trim());
	logger.info("address updated", { userId });
	return true;
}

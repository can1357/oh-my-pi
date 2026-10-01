import { carts } from "../db";
import { logger } from "../log";

export function removeItem(userId: string, sku: string): boolean {
	const cart = carts.get(userId);
	const index = cart?.indexOf(sku) ?? -1;
	if (!cart || index === -1) {
		logger.debug("removeItem: not in cart", { userId, sku });
		return false;
	}
	cart.splice(index, 1);
	logger.debug("item removed", { userId, sku });
	return true;
}

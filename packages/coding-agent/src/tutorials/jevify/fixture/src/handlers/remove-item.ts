import { carts } from "../db";
import { log } from "../log";

export function removeItem(userId: string, sku: string): boolean {
	const cart = carts.get(userId);
	const index = cart?.indexOf(sku) ?? -1;
	if (!cart || index === -1) {
		log.debug("removeItem: not in cart", { userId, sku });
		return false;
	}
	cart.splice(index, 1);
	log.debug("item removed", { userId, sku });
	return true;
}

import { carts } from "../db";
import { log } from "../log";

const MAX_ITEMS = 50;

export function addItem(userId: string, sku: string): number {
	const cart = carts.get(userId) ?? [];
	if (cart.length >= MAX_ITEMS) {
		log.warn("cart full", { userId });
		return cart.length;
	}
	cart.push(sku);
	carts.set(userId, cart);
	log.debug("item added", { userId, sku });
	return cart.length;
}

import { log } from "../log";

export const stock = new Map<string, number>();

export function syncInventory(feed: Array<{ sku: string; qty: number }>): number {
	let updated = 0;
	for (const { sku, qty } of feed) {
		if (qty < 0) {
			log.warn("negative stock in feed", { sku, qty });
			continue;
		}
		stock.set(sku, qty);
		updated++;
	}
	log.info("inventory synced", { updated });
	return updated;
}

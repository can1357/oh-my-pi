import type { Order } from "../orders";
import type { Store } from "../store";

/** Deletes every cancelled order; resolves with how many were removed. */
export function purgeCancelled(store: Store): Promise<number> {
	return new Promise((resolve, reject) => {
		store.list("order:", (error, entries) => {
			if (error) return reject(error);
			const cancelled = (entries ?? []).filter(([, doc]) => (doc as Order).status === "cancelled");
			if (cancelled.length === 0) return resolve(0);
			let pending = cancelled.length;
			let failed = false;
			for (const [key] of cancelled) {
				store.del(key, error => {
					if (failed) return;
					if (error) {
						failed = true;
						return reject(error);
					}
					if (--pending === 0) resolve(cancelled.length);
				});
			}
		});
	});
}

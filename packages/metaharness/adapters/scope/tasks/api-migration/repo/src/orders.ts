import type { Store } from "./store";

export interface OrderItem {
	sku: string;
	qty: number;
	cents: number;
}

export interface Order {
	id: string;
	userId: string;
	day: string;
	items: OrderItem[];
	totalCents: number;
	status: "open" | "cancelled";
}

/** Places an order for an existing user; rejects for an unknown user or a store failure. */
export function placeOrder(store: Store, order: Omit<Order, "totalCents" | "status">): Promise<Order> {
	return new Promise((resolve, reject) => {
		store.get(`user:${order.userId}`, (error, user) => {
			if (error) return reject(error);
			if (!user) return reject(new Error(`unknown user ${order.userId}`));
			const placed: Order = {
				...order,
				totalCents: order.items.reduce((sum, item) => sum + item.qty * item.cents, 0),
				status: "open",
			};
			store.set(`order:${order.id}`, placed, error => (error ? reject(error) : resolve(placed)));
		});
	});
}

export function cancelOrder(store: Store, id: string): Promise<void> {
	return new Promise((resolve, reject) => {
		store.get(`order:${id}`, (error, doc) => {
			if (error) return reject(error);
			if (!doc) return reject(new Error(`unknown order ${id}`));
			const order = doc as Order;
			store.set(`order:${id}`, { ...order, status: "cancelled" }, error => (error ? reject(error) : resolve()));
		});
	});
}

export function ordersFor(store: Store, userId: string): Promise<Order[]> {
	return new Promise((resolve, reject) => {
		store.list("order:", (error, entries) => {
			if (error) return reject(error);
			resolve((entries ?? []).map(([, doc]) => doc as Order).filter(order => order.userId === userId));
		});
	});
}

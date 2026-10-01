import { orders, users } from "../db";
import { log } from "../log";
import { sendEmail } from "../mail";

export async function notifyShipping(): Promise<number> {
	let notified = 0;
	for (const order of orders.values()) {
		const user = users.get(order.userId);
		if (order.status !== "paid" || !user) continue;
		await sendEmail(user.email, `Order ${order.id} has shipped`);
		notified++;
	}
	log.info("shipping notices sent", { notified });
	return notified;
}

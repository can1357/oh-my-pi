import { orders, users } from "../db";
import { log } from "../log";
import { sendEmail } from "../mail";

export async function sendReminders(): Promise<number> {
	let reminded = 0;
	for (const order of orders.values()) {
		const user = users.get(order.userId);
		if (order.status !== "open" || !user) continue;
		await sendEmail(user.email, `Order ${order.id} is waiting for payment`);
		reminded++;
	}
	log.info("payment reminders sent", { reminded });
	return reminded;
}

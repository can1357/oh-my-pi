import { users } from "../db";
import { log } from "../log";

function move(fromId: string, toId: string, amount: number): void {
	const from = users.get(fromId);
	const to = users.get(toId);
	if (!from || !to) throw new Error("unknown user");
	from.balance -= amount;
	to.balance += amount;
}

export function transfer(fromId: string, toId: string, amount: number): void {
	if (amount <= 0) throw new Error("amount must be positive");
	move(fromId, toId, amount);
	log.info("transfer", { fromId, toId, amount });
}

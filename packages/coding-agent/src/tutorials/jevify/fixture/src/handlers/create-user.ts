import { users, type User } from "../db";
import { log } from "../log";

export function createUser(id: string, email: string): User {
	if (users.has(id)) throw new Error(`user ${id} exists`);
	const user: User = { id, email: email.toLowerCase(), active: false, balance: 0 };
	users.set(id, user);
	log.info("user created", { id });
	return user;
}

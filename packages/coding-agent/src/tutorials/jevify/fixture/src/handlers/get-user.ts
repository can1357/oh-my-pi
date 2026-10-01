import { users, type User } from "../db";
import { log } from "../log";

export function getUser(id: string): User | undefined {
	const user = users.get(id);
	if (!user) log.debug("user not found", { id });
	return user;
}

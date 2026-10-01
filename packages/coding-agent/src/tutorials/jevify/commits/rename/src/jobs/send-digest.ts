import { users } from "../db";
import { logger } from "../log";
import { sendEmail } from "../mail";

export async function sendDigest(): Promise<number> {
	let sent = 0;
	for (const user of users.values()) {
		if (!user.active) continue;
		sendEmail(user.email, "Your weekly digest");
		sent++;
	}
	logger.info("digest sent", { sent });
	return sent;
}
